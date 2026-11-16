// Following up with people who can't make the top pick. Shared by the Slack bot and
// the web dashboard. Real Slack users get a DM (see slack.js), web participants get a
// message on their personal page (see web.js), and test participants answer on the spot
// through simulate.js.
import * as store from "./store.js";
import { negotiationQuestion } from "./llm.js";
import { simulateNegotiationAnswer, isSimulated } from "./simulate.js";

const MAX_NEGOTIATIONS = 5;

// Who a negotiation is recorded under: the Slack user, or the test participant's name.
export const negotiationKey = (r) => r.slackUserId || (r.token ? `web:${r.token}` : `sim:${r.name}`);

// A web participant: answered on the event page and has a personal link to reach them.
export const isWebParticipant = (r) => Boolean(r.token && !r.slackUserId && !r.simulated);

// People who can't make a slot and could be asked: real Slack users, test participants,
// and (with web: true, i.e. on the web dashboard) web participants.
// Those with some availability on the same day come first: they're likeliest to adjust.
export function negotiationCandidates(event, slot, { web = false } = {}) {
  const missing = new Set(slot.missing);
  const reachable = (r) => (r.slackUserId ? r.slackUserId !== event.slack?.organizer : isSimulated(r) || (web && isWebParticipant(r)));
  return event.responses
    .filter((r) => reachable(r) && missing.has(r.name))
    .map((r) => ({ r, sameDay: r.parsed.availability.some((b) => b.date === slot.date) }))
    .sort((a, b) => Number(b.sameDay) - Number(a.sameDay))
    .slice(0, MAX_NEGOTIATIONS)
    .map(({ r }) => r);
}

// Asked already about this same slot? (A new top pick means they can be asked again.)
const sameSlot = (a, b) => a && b && a.date === b.date && a.start === b.start && a.end === b.end;
const alreadyAsked = (event, r, slot) =>
  Boolean(event.slack?.negotiations?.[negotiationKey(r)]) ||
  (r.token ? sameSlot(r.negotiation?.slot, slot) : Boolean(event.negotiationLog?.some((n) => n.name === r.name)));

// Web and test participants who can't make the top pick and haven't been asked yet.
export function askableParticipants(event) {
  const slot = event.recommendation?.proposals?.[0]?.slot;
  if (!slot) return [];
  return negotiationCandidates(event, slot, { web: true }).filter((r) => !r.slackUserId && !alreadyAsked(event, r, slot));
}

// Ask one test participant and record the exchange so the dashboard can show it.
export async function askTestParticipant(eventId, person, slot) {
  const question = await negotiationQuestion(store.getEvent(eventId), slot, person);
  const { answer, fits } = await simulateNegotiationAnswer(eventId, person.name, slot, question);
  const entry = { name: person.name, question, answer, fits, slot: { date: slot.date, start: slot.start, end: slot.end }, at: new Date().toISOString() };
  store.updateEvent(eventId, (e) => (e.negotiationLog ||= []).push(entry));
  return entry;
}
