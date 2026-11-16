// Event storage. Locally (npm start) everything lives in one JSON file, data/db.json.
// On Cloudflare Workers each event lives in its own Durable Object (see worker.js), which
// runs the same code with its own backend through withBackend(). Either way the rest of
// the app just calls getEvent / updateEvent / ... below.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// A backend is { db: { events: {id: event}, users?: {} }, save(eventId?) }.
const scope = new AsyncLocalStorage();
let fileBackend = null;

function openFileBackend() {
  const dataDir = process.env.DATA_DIR || path.resolve("data");
  const file = path.join(dataDir, "db.json");
  const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { events: {} };
  return {
    db,
    save() {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}

const current = () => scope.getStore() || (fileBackend ||= openFileBackend());
const db = new Proxy({}, { get: (_, key) => current().db[key], set: (_, key, value) => ((current().db[key] = value), true) });
const save = (eventId) => current().save(eventId);

// Run fn with a different backend (used by the Cloudflare Durable Object).
export const withBackend = (backend, fn) => scope.run(backend, fn);

export function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// A backend can choose event ids (Slack workspace events are "<teamId>.<id>").
export function createEvent(fields, id = current().newEventId?.() || newId()) {
  const event = {
    id,
    adminKey: newId(12),
    createdAt: new Date().toISOString(),
    responses: [],
    recommendation: null,
    ...fields,
  };
  db.events[event.id] = event;
  save(event.id);
  return event;
}

export function allEvents() {
  return db.events;
}

export function getEvent(id) {
  return db.events[id] || null;
}

// One response per person; resubmitting replaces the old one. Web responses are
// keyed by name (case-insensitive), Slack responses by Slack user id.
const responseKey = (r) => r.slackUserId || r.name.trim().toLowerCase();

export function upsertResponse(eventId, response) {
  const event = db.events[eventId];
  const key = responseKey(response);
  event.responses = event.responses.filter((r) => responseKey(r) !== key);
  event.responses.push({ ...response, submittedAt: new Date().toISOString() });
  save(eventId);
}

export function setRecommendation(eventId, recommendation) {
  db.events[eventId].recommendation = { ...recommendation, generatedAt: new Date().toISOString() };
  save(eventId);
}

export function findEventBySlackThread(channel, threadTs) {
  return Object.values(db.events).find((e) => e.slack?.channel === channel && e.slack?.ts === threadTs) || null;
}

// Apply a change to an event and persist it.
export function updateEvent(eventId, mutate) {
  mutate(db.events[eventId]);
  save(eventId);
  return db.events[eventId];
}

// ----- web participants -----
// Each web participant gets a private token: their personal link (/e/:id/me/:token) is
// the web version of a Slack DM, where Gather can follow up with them later.
export const findWebResponse = (event, token) =>
  (token && event.responses.find((r) => r.token === token)) || null;

// Save a web reply. With a valid token it updates that person's answer (and keeps their
// thread); otherwise it replaces any earlier answer under the same name, like before.
export function saveWebResponse(eventId, { token, name, parsed, transcript, contact }) {
  const event = db.events[eventId];
  const existing = findWebResponse(event, token) ||
    event.responses.find((r) => !r.slackUserId && !r.simulated && r.name.trim().toLowerCase() === name.trim().toLowerCase());
  const now = new Date().toISOString();
  const thread = existing?.thread || [];
  thread.push(...transcript.map((t) => ({ ...t, at: now })));
  thread.push({ role: "assistant", kind: "note", text: existing ? "Answer updated" : "Answer saved", at: now });
  const response = {
    ...(existing || {}),
    name,
    parsed,
    transcript: transcript.slice(-12),
    thread: thread.slice(-80),
    token: existing?.token || newId(9),
    contact: contact ?? existing?.contact ?? "",
    submittedAt: now,
  };
  event.responses = event.responses.filter((r) => r !== existing);
  event.responses.push(response);
  save(eventId);
  return response;
}

// Per-person preferences Gather has picked up from conversation (keyed by Slack user id).
export function getUserPrefs(userId) {
  return db.users?.[userId]?.prefs || {};
}

export function setUserPrefs(userId, prefs) {
  db.users ||= {};
  db.users[userId] = { ...(db.users[userId] || {}), prefs };
  save();
  return prefs;
}

// Small bits of bot state that must survive restarts, such as a DM draft that hasn't been
// posted yet. Saved with save("__state__"); backends that don't handle it simply skip it.
export const STATE_KEY = "__state__";

export function getState(key) {
  return db.state?.[key];
}

export function setState(key, value) {
  db.state ||= {};
  if (value === undefined) delete db.state[key];
  else db.state[key] = value;
  save(STATE_KEY);
}
