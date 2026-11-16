// LLM integration (OpenAI): (1) turn a participant's free-text reply into structured
// availability + preferences, (2) turn ranked slots + everyone's preferences into
// 2–3 proposals the organizer can pick from. Times are never invented by the model:
// proposals must reference slots computed in schedule.js.
import OpenAI from "openai";
import { dateRange } from "./schedule.js";
import * as demo from "./demoParser.js";

export const MAX_CLARIFICATIONS = 2;

// Settings are read when used, not when this file loads: on Cloudflare Workers the
// secrets only arrive with the first request.
export const modelName = () => process.env.OPENAI_MODEL || "gpt-5.4-mini";
export const isDemoMode = () => process.env.DEMO_MODE === "1" || !process.env.OPENAI_API_KEY;

let client = null;
let clientKey = "";
function openai() {
  if (!client || clientKey !== process.env.OPENAI_API_KEY) {
    clientKey = process.env.OPENAI_API_KEY;
    client = new OpenAI({ apiKey: clientKey });
  }
  return client;
}

const PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "question", "summary", "availability", "hard_constraints", "preferences", "notes"],
  properties: {
    status: { type: "string", enum: ["need_clarification", "complete"] },
    question: { type: "string", description: "One short follow-up question if status is need_clarification, else empty." },
    summary: { type: "string", description: "One-sentence restatement of what the participant said, in the language the instructions name. No pronouns or names for the participant (never he/she, 他/她): write it as a note, e.g. 'Free Thursday after 6pm; wants vegetarian food.'" },
    availability: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "start", "end", "level"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, must be one of the event dates" },
          start: { type: "string", description: "HH:MM 24h" },
          end: { type: "string", description: "HH:MM 24h, after start" },
          level: { type: "string", enum: ["preferred", "available", "if_needed"] },
        },
      },
    },
    hard_constraints: {
      type: "array",
      items: { type: "string" },
      description: "Non-negotiable needs about the activity: allergies, dietary restrictions, accessibility, no alcohol. Never about days or times.",
    },
    preferences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "value", "strength"],
        properties: {
          topic: { type: "string", description: "Short lowercase English category, e.g. food, budget, location, activity, drinks, vibe. Never time or day." },
          value: { type: "string", description: "Short phrase, e.g. 'sushi'. Never a day or time; those go in availability." },
          strength: { type: "string", enum: ["strong", "medium", "weak"] },
        },
      },
    },
    notes: { type: "string", description: "Anything else useful for the organizer (e.g. 'may arrive 30 min late'). Empty if none." },
  },
};

const RECOMMEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["group_summary", "must_respect", "proposals", "announcement"],
  properties: {
    group_summary: { type: "string", description: "2-4 sentences: what the group wants overall, including minority-but-important needs." },
    must_respect: { type: "array", items: { type: "string" }, description: "Hard constraints any plan must honor, with who raised them." },
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate_index", "title", "why", "tradeoffs", "details"],
        properties: {
          candidate_index: { type: "integer", description: "Index into the candidate slot list" },
          title: { type: "string", description: "Short name, e.g. 'Friday sushi night'" },
          why: { type: "string" },
          tradeoffs: { type: "string", description: "Who misses out or which preference is not met." },
          details: { type: "string", description: "Concrete suggestions for the activity: type of venue/food, budget range, format." },
        },
      },
    },
    announcement: { type: "string", description: "Ready-to-paste group chat message for the top proposal." },
  },
};

function weekdayList(event) {
  return dateRange(event.dateStart, event.dateEnd)
    .map((d) => `${d} (${new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })})`)
    .join(", ");
}

function todayIn(timeZone) {
  // en-CA formats as YYYY-MM-DD
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

async function callModel({ name, system, user, schema }) {
  const completion = await openai().chat.completions.create({
    model: modelName(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
    ...(process.env.OPENAI_REASONING_EFFORT ? { reasoning_effort: process.env.OPENAI_REASONING_EFFORT } : {}),
  });
  const message = completion.choices[0].message;
  if (message.refusal) throw new Error(`The model declined this request: ${message.refusal}`);
  if (!message.content) throw new Error(`Empty model response (finish_reason: ${completion.choices[0].finish_reason})`);
  return JSON.parse(message.content);
}

// Tell the model which language to write in instead of letting it guess; a small
// model left to infer it sometimes answers an English reply in Spanish.
export function replyLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "Japanese";
  if (/[\uac00-\ud7af]/.test(text)) return "Korean";
  if (/[\u4e00-\u9fff]/.test(text)) return "Chinese";
  const letters = text.match(/\p{L}/gu) || [];
  const ascii = letters.filter((c) => /[a-z]/i.test(c)).length;
  return letters.length && ascii / letters.length > 0.9 ? "English" : "the same language the participant wrote in";
}

// What Gather writes in for an event. The web version is English-only (it still reads
// any language); in Slack, Gather answers each person in the language they wrote in.
export function outputLanguage(event, text) {
  return event.slack ? replyLanguage(text) : "English";
}

// transcript: [{ role: "participant" | "assistant", text }]
export async function parseReply(event, transcript, { language: preferred } = {}) {
  const clarificationsUsed = transcript.filter((t) => t.role === "assistant").length;
  if (isDemoMode()) return demo.parseReply(event, transcript);

  const language = preferred || outputLanguage(event, transcript.filter((t) => t.role === "participant").map((t) => t.text).join(" "));
  const system = `You help collect availability and preferences for a group event. You read what one participant wrote and convert it into structured data for the organizer.

Event: ${event.title}
Organizer's description: ${event.description || "(none)"}
Things the organizer wants to learn besides time: ${event.askAbout || "(nothing specific)"}
Candidate dates: ${weekdayList(event)}
Daily window: ${event.dayStart}–${event.dayEnd}. Event length: ${event.durationMinutes} minutes.
Today is ${todayIn(event.timeZone)} (time zone ${event.timeZone}). Resolve relative dates ("tomorrow", "next Thursday", "周四") against today and the candidate dates.

How to convert:
- availability lists only times the person CAN attend, clipped to the candidate dates and daily window. If they say "free all week except Thursday", list every other date across the full window.
- level: "preferred" when they express a preference for that time, "if_needed" for reluctant or conditional availability ("I could make it if…", "maybe"), otherwise "available".
- Vague times: evening ≈ 18:00–22:00, afternoon ≈ 13:00–18:00, morning ≈ 09:00–12:00, then clip to the daily window. "After 7" means 19:00 to the window end.
- Read bare hours in context: when the daily window is in the afternoon/evening, "7" or "9" mean 19:00 / 21:00.
- availability is the span during which the person can be present, not when the event may start. "Must leave by 9" or "only if it ends by 9" means the block ends at 21:00; "can't get there before 8" means it starts at 20:00.
- hard_constraints are things about the activity that must not be violated: allergies, dietary restrictions, accessibility, not drinking alcohol. preferences are soft wishes about the activity (food, drinks, budget, place, vibe); set strength from their wording.
- Anything about time (which days, preferred days, arriving late, leaving early) belongs only in availability and its level, never in hard_constraints or preferences. Put a short note in notes only if it matters beyond the time blocks (e.g. "may arrive 30 min late").
- If they gave no usable time information at all, or the times are ambiguous in a way that changes the result (e.g. "Thursday" when two Thursdays are candidates), set status "need_clarification" and ask ONE short, friendly question in ${language}. Do not ask about things the organizer did not ask for. You may ask at most ${MAX_CLARIFICATIONS - clarificationsUsed} more question(s).${clarificationsUsed >= MAX_CLARIFICATIONS ? "\n- You have used all follow-up questions: set status \"complete\" and make your best reasonable interpretation." : ""}
- When status is need_clarification, still fill in everything you could already extract.
- Read the whole conversation as one answer. A later message adds to or corrects what they said before; keep earlier times, needs and wishes unless they take them back ("Saturday works too" adds Saturday and keeps the rest; "actually only Saturday" replaces it).
- The participant may write in any language; read it as written. Language: write summary, question, notes, hard_constraints and preference values in ${language}${language === "English" ? ", translating what they said if needed (e.g. 火锅 → hot pot)" : ""}. topic stays a lowercase English word. Keep preference values short, like "sushi" or "under $25".`;

  const conversation = transcript
    .map((t) => `${t.role === "participant" ? "Participant" : "You (assistant)"}: ${t.text}`)
    .join("\n");

  const ask = (extra = "") => callModel({ name: "participant_reply", system: system + extra, user: `Conversation so far:\n${conversation}`, schema: PARSE_SCHEMA });
  let parsed = await ask();
  // The model occasionally slips back into the participant's language; ask once more.
  if (language === "English" && notEnglish(parsed)) parsed = await ask("\n- IMPORTANT: every text field must be in English. Translate anything the participant wrote in another language.");
  if (clarificationsUsed >= MAX_CLARIFICATIONS) parsed.status = "complete";
  const clean = sanitizeParsed(event, parsed);
  // No usable times yet? Always ask: the model sometimes marks a food-only reply "complete".
  if (!clean.availability.length && clarificationsUsed < MAX_CLARIFICATIONS) {
    clean.status = "need_clarification";
    if (!clean.question) clean.question = timeQuestion(event, language);
  }
  return clean;
}

// Any Chinese, Japanese, Korean or other non-Latin letters in what Gather would show?
function notEnglish(parsed) {
  const text = [parsed.summary, parsed.question, parsed.notes, ...parsed.hard_constraints, ...parsed.preferences.map((p) => p.value)].join(" ");
  return /[^\p{Script=Latin}\P{L}]/u.test(text);
}

function timeQuestion(event, language) {
  const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  if (language === "Chinese") return `${event.dateStart.slice(5).replace("-", "月")}日到${event.dateEnd.slice(5).replace("-", "月")}日之间，你哪几天、大概几点有空？`;
  return `Which days and times work for you between ${day(event.dateStart)} and ${day(event.dateEnd)}?`;
}

// Drop anything outside the event's dates/window so bad model output can't skew the math.
export function sanitizeParsed(event, parsed) {
  const dates = new Set(dateRange(event.dateStart, event.dateEnd));
  const clamp = (t, lo, hi) => (t < lo ? lo : t > hi ? hi : t);
  const valid = /^\d{2}:\d{2}$/;
  parsed.availability = parsed.availability
    .filter((b) => dates.has(b.date) && valid.test(b.start) && valid.test(b.end))
    .map((b) => ({ ...b, start: clamp(b.start, event.dayStart, event.dayEnd), end: clamp(b.end, event.dayStart, event.dayEnd) }))
    .filter((b) => b.start < b.end);
  return parsed;
}

export async function recommend(event, candidates) {
  if (isDemoMode()) return demo.recommend(event, candidates);

  const people = event.responses.map((r) => ({
    name: r.name,
    hard_constraints: r.parsed.hard_constraints,
    preferences: r.parsed.preferences,
    notes: r.parsed.notes,
  }));
  const slots = candidates.map((c, i) => ({
    index: i,
    // Spell out the weekday; left to work it out from the date, the model sometimes gets it wrong.
    when: `${new Date(`${c.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${c.date} ${c.start}–${c.end}`,
    can_attend: c.attendees.map((a) => `${a.name} (${a.level})`),
    cannot_attend: c.missing,
  }));

  // The plan is posted publicly, so it follows the event's own language (Slack) or English (web).
  // Named explicitly: asked to "match the organizer", the model drifts toward whatever language
  // most replies are in.
  const language = event.slack ? replyLanguage(`${event.title} ${event.description || ""}`) : "English";
  const system = `You help an organizer finalize a group event. Time slots have already been computed and ranked by an algorithm; you choose among them and enrich the plan with activity details based on what people asked for. Never propose a time that is not in the candidate list. Refer to people by name; never guess anyone's gender (use "they" if you need a pronoun).

Write all text in ${language}, even where participants wrote in another language (translate their wishes, e.g. 火锅 → hot pot). Keep people's names exactly as written.`;

  const user = `Event: ${event.title}
Description: ${event.description || "(none)"}
Event length: ${event.durationMinutes} minutes

Candidate slots (best first by attendance):
${JSON.stringify(slots, null, 2)}

What each participant said about the activity:
${JSON.stringify(people, null, 2)}

Pick 2–3 meaningfully different proposals (fewer if there is only one candidate). Order them best first. Weigh attendance first, then hard constraints (an option that violates someone's hard constraint must say so), then how many soft preferences it satisfies. Titles and wording must match each slot's actual day and time (don't call a 21:00 slot "early"). Say days and times the way people do (e.g. "Wednesday 7–9pm", "周三晚上7点到9点"), never as YYYY-MM-DD or 24-hour ranges. Keep each field concise.`;

  const result = await callModel({ name: "event_plan", system, user, schema: RECOMMEND_SCHEMA });
  result.proposals = result.proposals
    .filter((p) => Number.isInteger(p.candidate_index) && candidates[p.candidate_index])
    .map((p) => ({ ...p, slot: candidates[p.candidate_index] }));
  return result;
}

// ---------- direct messages ----------

// Lasting preferences someone states in conversation ("reply to me in Chinese, post in
// English", "I usually use #social"). Filled only when they say how Gather should work
// for them from now on; one-off edits to the current draft don't count.
const REMEMBER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "Lasting preferences they just stated about how you should work for them. Leave everything empty if none.",
  required: ["reply_language", "post_language", "usual_channel_id", "notes"],
  properties: {
    reply_language: { type: "string", description: "Language they want you to reply to them in, e.g. 'Chinese'. Empty if not stated." },
    post_language: { type: "string", description: "Language they want events you post for them written in, e.g. 'English'. Empty if not stated." },
    usual_channel_id: { type: "string", description: "Slack channel ID (like C0123ABC, from a <#ID|name> mention) they say they usually want events posted in. Empty if not stated." },
    notes: { type: "array", items: { type: "string" }, description: "Other lasting preferences about how you should work for them, as short English sentences (e.g. 'Usually plans 2-hour events'). Empty if none." },
  },
};

const REMEMBER_RULE = `- remember: fill it only when they state a lasting preference about how you should work for them (e.g. "回复我用中文，post 的信息用英文", "always post in #social", "I usually do 2-hour events"). A request about just this draft or this message ("make this one 3 hours") is not a lasting preference. Leave every field empty otherwise.`;

// What Gather already knows about this person, for the prompt.
function prefsSummary(prefs = {}) {
  const lines = [];
  if (prefs.replyLanguage) lines.push(`Reply to them in ${prefs.replyLanguage}.`);
  if (prefs.postLanguage) lines.push(`Write events posted for them in ${prefs.postLanguage}.`);
  if (prefs.usualChannelId) lines.push(`They usually post events in channel ${prefs.usualChannelId}.`);
  for (const n of prefs.notes || []) lines.push(n);
  return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "(nothing yet)";
}

const EMPTY_REMEMBER = { reply_language: "", post_language: "", usual_channel_id: "", notes: [] };

const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "event_index", "answer", "draft", "remember"],
  properties: {
    intent: { type: "string", enum: ["reply", "create", "ask", "other"] },
    remember: REMEMBER_SCHEMA,
    event_index: { type: "integer", description: "Index of the event the message is about, or -1 if none or unclear" },
    answer: { type: "string", description: "For ask/other: the reply to send. Empty for reply/create." },
    draft: {
      type: "object",
      additionalProperties: false,
      description: "For create: the event they want to set up. Use empty strings / 0 for anything they didn't say.",
      required: ["title", "description", "askAbout", "dateStart", "dateEnd", "dayStart", "dayEnd", "durationMinutes"],
      properties: {
        title: { type: "string", description: "Short name, e.g. 'Lab happy hour'" },
        description: { type: "string", description: "Extra details they gave beyond the title, time and channel (place, purpose, size). Empty if none." },
        askAbout: {
          type: "string",
          description: "Besides time, what to ask people about, comma-separated. Use these exact English labels when they fit: Food preferences, Budget, Dietary restrictions, Drinks, Location, Activity ideas. Never list availability or whether people can come; that is always asked.",
        },
        dateStart: { type: "string", description: "YYYY-MM-DD or empty" },
        dateEnd: { type: "string", description: "YYYY-MM-DD or empty" },
        dayStart: { type: "string", description: "HH:MM 24h or empty" },
        dayEnd: { type: "string", description: "HH:MM 24h or empty. Use 23:59 for midnight." },
        durationMinutes: { type: "integer", description: "Multiple of 30, or 0 if not given" },
      },
    },
  },
};

const EMPTY_DRAFT = { title: "", description: "", askAbout: "", dateStart: "", dateEnd: "", dayStart: "", dayEnd: "", durationMinutes: 0 };

// Decide what a direct message to the bot is for. `events` is a short summary of the
// open events this person can see, so the model can pick one or answer questions about them.
export async function routeDm({ text, events, timeZone, userName, prefs = {} }) {
  if (isDemoMode()) return { remember: EMPTY_REMEMBER, ...demo.routeDm({ text, events }) };
  const language = prefs.replyLanguage || replyLanguage(text);
  const postLanguage = prefs.postLanguage || language;
  const system = `You are Gather, a Slack bot that helps groups find a time to meet. People reply to events in their own words; you work out when everyone is free and suggest a plan. ${userName || "Someone"} sent you a direct message. Decide what it is for.

Open events (index: details):
${events.length ? events.map((e, i) => `${i}: ${e}`).join("\n") : "(none)"}

Today is ${todayIn(timeZone)} (${timeZone}).

What you've learned about how this person likes things:
${prefsSummary(prefs)}

Intents:
- "reply": they are telling you when they're free or what they'd like for an event (or answering a question you asked them). Set event_index to that event; -1 if it could be several.
- "create": they want to organize a new get-together. Fill draft with what they said; leave the rest empty. Resolve relative dates against today. For anything they didn't say, use what you've learned about them (e.g. their usual event length); otherwise leave it empty. Write the draft's title and description in ${postLanguage}.
- "ask": a question about their events (status, who replied, what's planned, what they said), about what you remember about them, or how to use Gather. Answer in answer, only from the details above. Be brief.
- "other": greetings, thanks, anything else. Reply briefly in answer and mention what you can do: reply to an event privately, set up a new event ("plan a happy hour next week in #social"), or answer questions about events.
${REMEMBER_RULE}
Write answer in ${language} (or the language they just asked you to reply in). Never make up events or details.`;
  const result = await callModel({ name: "dm_route", system, user: text, schema: ROUTE_SCHEMA });
  return { ...result, draft: { ...EMPTY_DRAFT, ...result.draft } };
}

// "18:00" -> "6pm", "19:30" -> "7:30pm"
function clock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 && h < 24 ? "pm" : "am"}`;
}

// One short, friendly DM asking someone who can't make the top pick whether they could adjust.
export async function negotiationQuestion(event, slot, person) {
  if (isDemoMode()) return demo.negotiationQuestion(event, slot, person);
  const language = outputLanguage(event, person.transcript.filter((t) => t.role === "participant").map((t) => t.text).join(" "));
  const day = new Date(`${slot.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  // Format the time here: left to convert 18:00–20:00 itself, the model sometimes shifts it.
  const time = `${day}, ${clock(slot.start)}–${clock(slot.end)}`;
  const system = `You are Gather, a bot helping a group plan "${event.title}". Most people can make ${time}, but ${person.name} can't, based on what they told you. Write one short, warm direct message (2 sentences max) asking whether they could make that time after all. Mention concretely what would need to change compared to what they said (e.g. arriving a bit late, leaving early); only mention other plans if they said they have them. No pressure; make it easy to say no. Write in ${language}. Use exactly that day and time (${clock(slot.start)} to ${clock(slot.end)}); never shift it. Say it naturally, the way people write it in ${language} (e.g. "Friday 6–8pm", "周五晚上6点到8点"), never as YYYY-MM-DD. Plain text, no greeting line beyond their first name. Never guess their gender.`;
  const user = `What ${person.name} said: ${person.transcript.filter((t) => t.role === "participant").map((t) => t.text).join(" / ")}
Their availability on file: ${JSON.stringify(person.parsed.availability)}`;
  const result = await callModel({
    name: "negotiation_question",
    system,
    user,
    schema: { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string" } } },
  });
  return result.message;
}

const REVISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_edit", "reply", "draft", "remember"],
  properties: {
    remember: REMEMBER_SCHEMA,
    is_edit: { type: "boolean", description: "true if the message asks to change this draft; false if it's about something else" },
    reply: { type: "string", description: "One short sentence saying what you changed. Empty if is_edit is false." },
    draft: { ...ROUTE_SCHEMA.properties.draft, description: "The complete updated draft. Copy fields that should not change exactly as they are." },
  },
};

// Apply feedback like "write it all in English" or "make it 3 hours" to an event draft
// that hasn't been posted yet. Returns { is_edit, reply, draft }.
export async function reviseDraft({ fields, instruction, timeZone, prefs = {} }) {
  const current = Object.fromEntries(Object.keys(EMPTY_DRAFT).map((k) => [k, fields[k] ?? EMPTY_DRAFT[k]]));
  if (isDemoMode()) return { remember: EMPTY_REMEMBER, ...demo.reviseDraft({ fields: current, instruction }) };
  const system = `You are Gather, a Slack bot. The user is reviewing a draft event before you post it to a channel. Decide whether their message asks to change the draft, and if so return the full updated draft.

Current draft:
${JSON.stringify(current, null, 2)}

Today is ${todayIn(timeZone)} (${timeZone}).

- Change only what they ask for; copy every other field exactly.
- "Write it in English" / "全部用英文" means translate the draft's text fields (title, description) into that language.
- Dates YYYY-MM-DD, times HH:MM 24h (23:59 for midnight), durationMinutes a multiple of 30.
- If the message is a question or a new topic rather than an edit to this draft, set is_edit false and return the draft unchanged.
${REMEMBER_RULE} A message can do both: "回复我用中文，post 的信息用英文" changes this draft to English and is a lasting preference.
- What you've learned about how this person likes things:
${prefsSummary(prefs)}
- Write reply in ${prefs.replyLanguage || replyLanguage(instruction)} (or the language they just asked you to reply in).`;
  let result = await callModel({ name: "revise_draft", system, user: instruction, schema: REVISE_SCHEMA });
  // "Reply to me in Chinese, but post in English" sets a preference *and* should change this
  // draft; the model tends to treat it as only the former, so apply the language explicitly.
  if (!result.is_edit && result.remember.post_language) {
    const translated = await reviseDraft({ fields: current, instruction: `Write the title and description in ${result.remember.post_language}.`, timeZone, prefs });
    result = { ...translated, reply: result.reply || translated.reply, remember: result.remember };
  }
  return { ...result, draft: { ...current, ...result.draft, title: result.draft.title || current.title } };
}
