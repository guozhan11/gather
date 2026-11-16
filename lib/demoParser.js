// Demo mode: a small rule-based stand-in for the LLM so the whole flow can be
// tried without an API key. It understands common English/Chinese phrasings only.
import { dateRange, toMinutes, fromMinutes } from "./schedule.js";

const WEEKDAYS = [
  [/\b(sun(day)?)\b|周日|周天|星期日|星期天/i, 0],
  [/\b(mon(day)?)\b|周一|星期一/i, 1],
  [/\b(tue(s|sday)?)\b|周二|星期二/i, 2],
  [/\b(wed(nesday)?)\b|周三|星期三/i, 3],
  [/\b(thu(rs|rsday)?)\b|周四|星期四/i, 4],
  [/\b(fri(day)?)\b|周五|星期五/i, 5],
  [/\b(sat(urday)?)\b|周六|星期六/i, 6],
];

const PERIODS = [
  [/morning|上午|早上/i, "09:00", "12:00"],
  [/afternoon|下午/i, "13:00", "18:00"],
  [/evening|night|tonight|晚上|晚/i, "18:00", "22:00"],
];

const FOOD = /(sushi|japanese|ramen|pizza|burger|tacos?|mexican|korean|bbq|hot ?pot|thai|indian|chinese|italian|vegan|日料|寿司|拉面|火锅|烧烤|韩餐|川菜|披萨|汉堡|泰餐|西餐|中餐)/gi;
const HARD = /(allergic to [a-z ]+?(?=[,.;]|$)|[a-z]+ allergy|vegetarian|vegan|halal|kosher|gluten[- ]free|对?[\u4e00-\u9fff]{1,4}过敏|素食|清真|不能吃[\u4e00-\u9fff]+)/gi;

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function hour(h, pm) {
  let n = Number(h);
  if (pm && n < 12) n += 12;
  return n;
}

function clauseTimes(clause, event) {
  // "7-9pm", "7点到9点"
  let m = clause.match(/(\d{1,2})\s*(?:[:：]\d{2})?\s*(am|pm|点)?\s*(?:-|–|to|到|至)\s*(\d{1,2})\s*(am|pm|点)?/i);
  if (m) {
    const pm = /pm/i.test(m[4] || m[2] || "") || /晚|下午|evening|night/i.test(clause) || Number(m[1]) < 9;
    return [fromMinutes(hour(m[1], pm) * 60), fromMinutes(hour(m[3], pm) * 60)];
  }
  // "after 7", "7点以后", "7点后"
  m = clause.match(/after\s*(\d{1,2})\s*(am|pm)?|(\d{1,2})\s*点\s*(以后|之后|后)/i);
  if (m) {
    const h = m[1] || m[3];
    const pm = /pm/i.test(m[2] || "") || /晚|下午|evening/i.test(clause) || Number(h) < 9;
    return [fromMinutes(hour(h, pm) * 60), event.dayEnd];
  }
  // "before 9", "9点以前"
  m = clause.match(/before\s*(\d{1,2})\s*(am|pm)?|(\d{1,2})\s*点\s*(以前|之前|前)/i);
  if (m) {
    const h = m[1] || m[3];
    const pm = /pm/i.test(m[2] || "") || /晚|下午|evening/i.test(clause) || Number(h) < 9;
    return [event.dayStart, fromMinutes(hour(h, pm) * 60)];
  }
  for (const [re, s, e] of PERIODS) if (re.test(clause)) return [s, e];
  return [event.dayStart, event.dayEnd];
}

export function parseReply(event, transcript) {
  const text = transcript.filter((t) => t.role === "participant").map((t) => t.text).join("。");
  const dates = dateRange(event.dateStart, event.dateEnd);
  const availability = [];
  let sawTime = false;

  // Each clause can name days and a time; "except/除了/没空" clauses remove days.
  const clauses = text.split(/[,，.。;；\n]|but|但是|不过/i).filter((c) => c.trim());
  const excluded = new Set();
  for (const clause of clauses) {
    const days = WEEKDAYS.filter(([re]) => re.test(clause)).map(([, d]) => d);
    const negative = /except|not|n't|cannot|busy|除了|没空|不行|不能|没时间|来不了/i.test(clause);
    const allDays = /any ?day|every ?day|all week|whenever|都可以|都行|随时|每天/i.test(clause);
    const level = /prefer|ideally|best|最好|更想|优先/i.test(clause) ? "preferred" : /maybe|might|if needed|可能|勉强|也许/i.test(clause) ? "if_needed" : "available";

    if (negative && days.length) {
      days.forEach((d) => excluded.add(d));
      sawTime = true;
      continue;
    }
    const targetDays = days.length ? days : allDays ? [0, 1, 2, 3, 4, 5, 6] : null;
    if (!targetDays) continue;
    sawTime = true;
    const [start, end] = clauseTimes(clause, event);
    for (const date of dates) {
      if (targetDays.includes(weekday(date))) availability.push({ date, start, end, level });
    }
  }
  if (excluded.size && !availability.length) {
    // "free all week except Thursday"
    for (const date of dates) availability.push({ date, start: event.dayStart, end: event.dayEnd, level: "available" });
  }
  const filtered = availability
    .filter((b) => !excluded.has(weekday(b.date)))
    .map((b) => ({
      ...b,
      start: b.start < event.dayStart ? event.dayStart : b.start,
      end: b.end > event.dayEnd ? event.dayEnd : b.end,
    }))
    .filter((b) => toMinutes(b.start) < toMinutes(b.end));

  const preferences = [...new Set((text.match(FOOD) || []).map((f) => f.toLowerCase()))].map((value) => ({
    topic: "food",
    value,
    strength: "medium",
  }));
  const budget = text.match(/(\$\s?\d+|\d+\s?(dollars|刀|块|元))|(cheap|便宜|别太贵|不要太贵)/i);
  if (budget) preferences.push({ topic: "budget", value: budget[0], strength: "medium" });
  const hard = [...new Set(text.match(HARD) || [])];

  const asked = transcript.filter((t) => t.role === "assistant").length;
  const needTime = !sawTime || filtered.length === 0;
  // Chinese replies only in Slack; the web version is English-only.
  const zh = Boolean(event.slack) && /[一-鿿]/.test(text);
  return {
    status: needTime && asked < 1 ? "need_clarification" : "complete",
    question: needTime && asked < 1
      ? zh ? "能具体说说哪几天、大概几点有空吗？比如“周四晚上7点以后”。" : "Which days and roughly what times work for you? e.g. “Thursday after 7pm”."
      : "",
    summary: zh ? `（演示模式解析）${text.slice(0, 80)}` : `(demo-mode parse) ${text.slice(0, 80)}`,
    availability: filtered,
    hard_constraints: hard,
    preferences,
    notes: "",
  };
}

export function recommend(event, candidates) {
  const counts = {};
  const hard = [];
  for (const r of event.responses) {
    for (const p of r.parsed.preferences) {
      const k = `${p.topic}: ${p.value}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    for (const h of r.parsed.hard_constraints) hard.push(`${r.name}: ${h}`);
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topText = top.length ? top.map(([k, n]) => `${k} (${n})`).join(", ") : "no specific preferences";
  const proposals = candidates.slice(0, 3).map((slot, i) => ({
    candidate_index: i,
    title: `Option ${i + 1}`,
    why: `${slot.attendees.length}/${event.responses.length} can attend.`,
    tradeoffs: slot.missing.length ? `Can't make it: ${slot.missing.join(", ")}` : "Everyone can make it.",
    details: `Most-mentioned preferences: ${topText}.`,
    slot,
  }));
  const first = proposals[0];
  return {
    group_summary: `${event.responses.length} people responded. Most-mentioned preferences: ${topText}. (Demo mode: add an OpenAI API key for a real AI summary.)`,
    must_respect: hard,
    proposals,
    announcement: first
      ? `📅 ${event.title}: ${first.slot.date} ${first.slot.start}–${first.slot.end}. ${first.tradeoffs}`
      : "",
  };
}

// Demo-mode stand-ins for the direct-message helpers.
export function routeDm({ text, events }) {
  const remember = rememberFrom(text);
  const routed = routeDmIntent({ text, events });
  // A message that only states a preference isn't a reply to an event.
  const statesPreference = remember.reply_language || remember.post_language || remember.usual_channel_id;
  if (statesPreference && routed.intent === "reply") return { ...routed, intent: "other", answer: "", remember };
  return { ...routed, remember };
}

function routeDmIntent({ text, events }) {
  const draft = { title: "", description: "", askAbout: "", dateStart: "", dateEnd: "", dayStart: "", dayEnd: "", durationMinutes: 0 };
  if (/\b(plan|organi[sz]e|set up|schedule)\b|约|组织|安排|发起/i.test(text)) {
    const title = text.match(/(?:plan|organi[sz]e|set up|schedule)\s+(?:a|an)?\s*([^,.#<]+?)(?:\s+(?:in|for|next|on)\b|[,.#<]|$)/i)?.[1]?.trim();
    return { intent: "create", event_index: -1, answer: "", draft: { ...draft, title: title || "Get-together" } };
  }
  if (/\?|？|\b(how|what|who|when|status|help)\b|怎么|什么|谁|哪些|吗/i.test(text)) {
    const list = events.length ? events.map((e) => `• ${e}`).join("\n") : "No open events right now.";
    return { intent: "ask", event_index: -1, answer: `(Demo mode) Open events:\n${list}`, draft };
  }
  if (/\b(hi|hello|hey|thanks?)\b|你好|谢谢/i.test(text)) {
    return { intent: "other", event_index: -1, answer: "Hi! Tell me when you're free for an event, ask me about your events, or say \"plan a happy hour next week in #social\".", draft };
  }
  return { intent: "reply", event_index: events.length === 1 ? 0 : -1, answer: "", draft };
}

export function negotiationQuestion(event, slot, person) {
  const first = person.name.split(" ")[0];
  return `${first}, most people can make ${event.title} on ${slot.date} ${slot.start}–${slot.end}. Is there any chance you could make that time work?`;
}

// Demo-mode stand-in: understands "N hours"; counts a message as an edit if it sounds like one.
export function reviseDraft({ fields, instruction }) {
  const isEdit = !/[?？]/.test(instruction) && /hour|英文|english|中文|chinese|change|make it|rename|title|date|day|time|location|改|换|加|删/i.test(instruction);
  const hours = instruction.match(/(\d+(?:\.5)?)\s*(hours?|hrs?|小时)/i);
  const draft = { ...fields, ...(hours ? { durationMinutes: Math.round(Number(hours[1]) * 2) * 30 } : {}) };
  return { is_edit: isEdit, reply: isEdit ? "(Demo mode) Updated the draft." : "", draft: isEdit ? draft : fields, remember: rememberFrom(instruction) };
}

// Demo-mode stand-in for picking up lasting preferences from a message.
export function rememberFrom(text) {
  const lang = (m) => (m ? (/英文|english/i.test(m) ? "English" : "Chinese") : "");
  return {
    reply_language: lang(text.match(/(?:回复我|reply(?: to me)?)[^,，。.]{0,6}(?:英文|中文|english|chinese)/i)?.[0]),
    post_language: lang(text.match(/(?:post|发布|发出|活动信息)[^,，。.]{0,12}(?:英文|中文|english|chinese)/i)?.[0]),
    usual_channel_id: text.match(/(?:always|usually|一般|总是|默认)[^<]{0,20}<#([CG][A-Z0-9]+)/i)?.[1] || "",
    notes: [],
  };
}
