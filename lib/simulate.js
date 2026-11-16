// Demo helper: adds replies from made-up participants so one person can see what an
// event looks like with a whole group. Replies go through the same parser as real ones.
import * as store from "./store.js";
import { parseReply } from "./llm.js";
import { dateRange } from "./schedule.js";

// {d0}…{d4} are weekday names of the event's dates; {early}/{mid}/{late} are times inside
// the daily window. Each persona has a follow-up answer in case the parser asks a question,
// and a flexibility ("yes" / "partial" / "no") for when Gather asks whether they could adjust.
const PERSONAS = [
  { name: "Maya", flex: "yes", text: "{d0} or {d1} works for me, {d1} only after {mid} though. Would love sushi, nothing too pricey.", followUp: "Anytime {d0}, {d1} after {mid}." },
  { name: "李明", flex: "partial", text: "{d1}和{d2}晚上都可以，{d2}更好。想吃火锅！对花生过敏。", followUp: "{d2}{mid}以后最好。" },
  { name: "Jordan", flex: "no", text: "Free all week except {d0}. Prefer {d2}. I'm vegetarian btw.", followUp: "Any time except {d0}." },
  { name: "Priya", flex: "no", text: "Only {d2} works, and I can't get there before {mid}. Craft beer would be fun.", followUp: "{d2} after {mid}." },
  { name: "Sam", flex: "yes", text: "probably {d1}? maybe {d3} if needed. budget around $25", followUp: "{d1} from {early}, {d3} only if needed." },
  { name: "王芳", flex: "no", text: "我{d0}{d1}都行，但要{late}之前结束。想吃韩餐或者烧烤。", followUp: "{d0}和{d1}，{late}前结束。" },
  { name: "Alex", flex: "yes", text: "Whenever, I'm flexible! Tacos > everything.", followUp: "Any day works." },
  { name: "Chen Wei", flex: "partial", text: "{d2} evening is best, {d3} could work if it's after {mid}. Gluten-free options please.", followUp: "{d2} anytime, {d3} after {mid}." },
  { name: "Emma", flex: "yes", text: "I want pizza", followUp: "{d1} or {d2}, from {early}." },
  { name: "Diego", flex: "yes", text: "{d1} I'm busy until {mid}, {d2} is wide open. Down for anything with drinks.", followUp: "{d1} after {mid}, {d2} anytime." },
  { name: "Hana", flex: "no", text: "{d3}以外都可以。不喝酒，希望有无酒精饮料。", followUp: "除了{d3}都行。" },
  { name: "Noah", flex: "partial", text: "{d2} works but I'll need to leave by {late}. Thai or Indian sounds great.", followUp: "{d2}, until {late}." },
];

const NAME_SUFFIX = " (sim)";

function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 ? "pm" : "am"}`;
}

export function fillTemplate(text, event) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const dates = dateRange(event.dateStart, event.dateEnd);
  const start = toMin(event.dayStart);
  const end = toMin(event.dayEnd);
  const round = (m) => Math.round(m / 60) * 60;
  const slots = {
    early: fmtTime(Math.min(start + 60, end)),
    mid: fmtTime(round((start + end) / 2)),
    late: fmtTime(Math.max(end - 60, start)),
  };
  return text
    .replace(/\{d(\d)\}/g, (_, i) => {
      const d = dates[Number(i) % dates.length];
      return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    })
    .replace(/\{(early|mid|late)\}/g, (_, k) => slots[k]);
}

export function nextPersonas(event, count) {
  const used = new Set(event.responses.map((r) => r.name));
  return PERSONAS.filter((p) => !used.has(p.name + NAME_SUFFIX)).slice(0, count);
}

// Adds up to `count` simulated replies. onReply(name, text) fires as each one is written,
// so the Slack bot can post it in the thread. Returns the names added.
export async function simulateReplies(eventId, count, { onReply } = {}) {
  const event = store.getEvent(eventId);
  const personas = nextPersonas(event, count);
  const added = [];
  const run = async (p) => {
    const transcript = [{ role: "participant", text: fillTemplate(p.text, event) }];
    let parsed = await parseReply(event, transcript);
    if (parsed.status === "need_clarification" && parsed.question) {
      transcript.push({ role: "assistant", text: parsed.question }, { role: "participant", text: fillTemplate(p.followUp, event) });
      parsed = await parseReply(event, transcript);
    }
    store.upsertResponse(eventId, { name: p.name + NAME_SUFFIX, simulated: true, parsed, transcript });
    added.push(p.name);
    await onReply?.(p.name + NAME_SUFFIX, transcript);
  };
  // A few at a time keeps it quick without hammering the API.
  for (let i = 0; i < personas.length; i += 3) {
    const results = await Promise.allSettled(personas.slice(i, i + 3).map(run));
    for (const r of results) if (r.status === "rejected") console.error("simulated reply failed:", r.reason?.message || r.reason);
  }
  return added;
}

// How each kind of persona answers "could you make <slot> after all?". {slot} is filled in.
const NEGOTIATION_ANSWERS = {
  en: {
    yes: "Sure, I can make {slot} work!",
    partial: "I can come on {slot}, but I'd be about 30 minutes late.",
    no: "Sorry, {slot} really doesn't work for me.",
  },
  zh: {
    yes: "可以，{slot}我能来！",
    partial: "{slot}可以，不过我会晚到半小时左右。",
    no: "不好意思，{slot}我实在来不了。",
  },
};

const personaFor = (name) => PERSONAS.find((p) => p.name + NAME_SUFFIX === name);
export const isSimulated = (response) => Boolean(response?.simulated && personaFor(response.name));

// A made-up participant answers Gather's "could you adjust?" question. The answer goes
// through the same parser as real replies, so their availability updates the same way.
// Returns { answer, fits } where fits says whether they can now make the whole slot.
export async function simulateNegotiationAnswer(eventId, name, slot, question) {
  const event = store.getEvent(eventId);
  const persona = personaFor(name);
  const response = event.responses.find((r) => r.name === name);
  if (!persona || !response) throw new Error(`No test participant called ${name}`);
  const zh = /[\u4e00-\u9fff]/.test(persona.text);
  const date = new Date(`${slot.date}T12:00:00Z`);
  const day = zh ? `周${"日一二三四五六"[date.getUTCDay()]}` : date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const slotText = `${day} ${fillTime(slot.start)}–${fillTime(slot.end)}`;
  const answer = NEGOTIATION_ANSWERS[zh ? "zh" : "en"][persona.flex].replace("{slot}", slotText);

  const transcript = [...response.transcript, { role: "assistant", text: question }, { role: "participant", text: answer }].slice(-12);
  const parsed = await parseReply(event, transcript);
  store.upsertResponse(eventId, { ...response, parsed, transcript });
  const fits = parsed.availability.some((b) => b.date === slot.date && b.start <= slot.start && b.end >= slot.end);
  return { answer, fits };
}

function fillTime(hhmm) {
  return fmtTime(Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));
}

export const MAX_PERSONAS = PERSONAS.length;
