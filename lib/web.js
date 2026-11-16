// One-on-one follow-ups for web participants: the web counterpart of Slack DMs.
// Every web participant has a personal link. Gather posts follow-up questions there
// (e.g. "could you make Friday 7–9 after all?"), and the participant can answer with a
// button or in their own words, or update their availability any time.
import * as store from "./store.js";
import { parseReply, negotiationQuestion, sanitizeParsed } from "./llm.js";

const covers = (parsed, slot) => parsed.availability.some((b) => b.date === slot.date && b.start <= slot.start && b.end >= slot.end);
const slotOf = (s) => ({ date: s.date, start: s.start, end: s.end });
const forParser = (thread) => thread.filter((t) => t.kind !== "note").map(({ role, text }) => ({ role, text })).slice(-12);

function logEntry(event, token) {
  return (event.negotiationLog || []).find((n) => n.kind === "web" && n.token === token);
}

// What the participant's personal page shows.
export function participantView(event, r) {
  const { adminKey, responses, recommendation, slack, negotiationLog, ...rest } = event;
  return {
    event: { ...rest, responseCount: responses.length },
    me: {
      name: r.name,
      contact: r.contact || "",
      parsed: r.parsed,
      thread: r.thread || r.transcript || [],
      negotiation: r.negotiation || null,
    },
  };
}

// Ask a web participant whether they could make the slot; the question appears on their page.
export async function askWebParticipant(eventId, person, slot) {
  const question = await negotiationQuestion(store.getEvent(eventId), slot, person);
  const at = new Date().toISOString();
  store.updateEvent(eventId, (e) => {
    const r = store.findWebResponse(e, person.token);
    r.negotiation = { slot: slotOf(slot), status: "asked", question, askedAt: at };
    (r.thread ||= []).push({ role: "assistant", kind: "negotiation", text: question, at });
    (e.negotiationLog ||= []).push({ name: r.name, kind: "web", token: r.token, question, answer: null, fits: null, status: "asked", slot: slotOf(slot), at });
  });
  return { name: person.name, question, status: "asked" };
}

function settleNegotiation(e, r, { answer, fits, status }) {
  const at = new Date().toISOString();
  r.negotiation = { ...r.negotiation, status, answeredAt: at };
  const entry = logEntry(e, r.token);
  if (entry) Object.assign(entry, { answer, fits, status, answeredAt: at });
}

// Yes / No buttons under Gather's question.
export function answerNegotiation(eventId, token, yes) {
  const event = store.getEvent(eventId);
  const r = store.findWebResponse(event, token);
  if (!r?.negotiation || r.negotiation.status !== "asked") throw new Error("There's no open question for you right now.");
  const slot = r.negotiation.slot;
  store.updateEvent(eventId, (e) => {
    const me = store.findWebResponse(e, token);
    const text = yes ? "Yes, I can make it." : "No, sorry, I can't make it.";
    const at = new Date().toISOString();
    me.thread.push({ role: "participant", text, at });
    if (yes && !covers(me.parsed, slot)) me.parsed.availability.push({ ...slot, level: "available" });
    me.thread.push({ role: "assistant", kind: "note", text: yes ? "Marked you as coming at that time. Thanks!" : "No worries, thanks for letting me know.", at });
    settleNegotiation(e, me, { answer: text, fits: yes, status: yes ? "yes" : "no" });
  });
}

// A free-text message on the personal page: an answer to Gather's question, or an update.
// Returns { kind: "question", text } when Gather needs to ask something first, else { kind: "updated" }.
export async function handleMessage(eventId, token, text) {
  const event = store.getEvent(eventId);
  const r = store.findWebResponse(event, token);
  const at = new Date().toISOString();
  const thread = [...(r.thread || []), { role: "participant", text, at }];
  const parsed = await parseReply(event, forParser(thread));

  if (parsed.status === "need_clarification" && parsed.question) {
    store.updateEvent(eventId, (e) => {
      const me = store.findWebResponse(e, token);
      me.thread = [...thread, { role: "assistant", text: parsed.question, at }].slice(-80);
    });
    return { kind: "question", text: parsed.question };
  }

  const clean = sanitizeParsed(event, { ...parsed });
  store.updateEvent(eventId, (e) => {
    const me = store.findWebResponse(e, token);
    me.parsed = { summary: clean.summary, availability: clean.availability, hard_constraints: clean.hard_constraints, preferences: clean.preferences, notes: clean.notes };
    me.transcript = forParser(thread);
    me.submittedAt = at;
    me.thread = [...thread, { role: "assistant", kind: "note", text: "Answer updated", at }].slice(-80);
    if (me.negotiation?.status === "asked") {
      const fits = covers(me.parsed, me.negotiation.slot);
      settleNegotiation(e, me, { answer: text, fits, status: fits ? "yes" : "replied" });
    }
  });
  return { kind: "updated" };
}

// Times adjusted by hand on the private page (drag-to-paint). Replaces the person's
// availability; if Gather was waiting on an answer about a slot, this counts as one.
export function setAvailability(eventId, token, availability) {
  const event = store.getEvent(eventId);
  const at = new Date().toISOString();
  const clean = sanitizeParsed(event, {
    availability: availability
      .slice(0, 200)
      .filter((b) => b && ["preferred", "available", "if_needed"].includes(b.level))
      .map((b) => ({ date: String(b.date), start: String(b.start), end: String(b.end), level: b.level })),
  }).availability;
  store.updateEvent(eventId, (e) => {
    const me = store.findWebResponse(e, token);
    me.parsed = { ...me.parsed, availability: clean, timesEditedAt: at };
    me.submittedAt = at;
    (me.thread ||= []).push({ role: "assistant", kind: "note", text: "Times adjusted by hand", at });
    me.thread = me.thread.slice(-80);
    if (me.negotiation?.status === "asked") {
      const fits = covers(me.parsed, me.negotiation.slot);
      settleNegotiation(e, me, { answer: fits ? "Adjusted their times: can make it now." : "Adjusted their times: still can't make it.", fits, status: fits ? "yes" : "replied" });
    }
  });
}
