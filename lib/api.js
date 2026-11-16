// The JSON API, shared by the local Express server (server.js) and the Cloudflare
// Worker (worker.js). handleApi() takes a plain request and returns { status, body }.
import * as store from "./store.js";
import { parseReply, recommend, sanitizeParsed, isDemoMode, modelName, MAX_CLARIFICATIONS } from "./llm.js";
import { buildHeatmap, rankSlots } from "./schedule.js";
import { normalizeEventFields, str } from "./events.js";
import { simulateReplies } from "./simulate.js";
import { askableParticipants, askTestParticipant, isWebParticipant } from "./negotiate.js";
import { participantView, askWebParticipant, answerNegotiation, handleMessage, setAvailability } from "./web.js";

// A tiny stand-in for Express's req/res, so the handlers below read the same as before.
class Res {
  constructor() { this.statusCode = 200; this.body = null; }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; return this; }
}

const routes = [];
const route = (method) => (pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, re, keys, handler });
};
const app = { get: route("GET"), post: route("POST") };

// Routes that call the AI model (the Worker rate-limits these).
export const AI_ROUTES = /^\/api\/events\/[^/]+\/(parse|recommend|simulate|negotiate|me\/[^/]+\/message)$/;

// request: { method, path, query, body, newEventId? }
export async function handleApi(request) {
  for (const r of routes) {
    const m = r.method === request.method && request.path.match(r.re);
    if (!m) continue;
    const req = {
      params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
      query: request.query || {},
      body: request.body || {},
      newEventId: request.newEventId,
    };
    const res = new Res();
    await r.handler(req, res);
    return { status: res.statusCode, body: res.body ?? {} };
  }
  return { status: 404, body: { error: "Not found" } };
}

function loadEvent(req, res) {
  const event = store.getEvent(req.params.id);
  if (!event) res.status(404).json({ error: "Event not found" });
  return event;
}

function requireAdmin(req, res) {
  const event = loadEvent(req, res);
  if (!event) return null;
  if (req.query.key !== event.adminKey) {
    res.status(403).json({ error: "Wrong or missing organizer key" });
    return null;
  }
  return event;
}

function publicView(event) {
  const { adminKey, responses, recommendation, negotiationLog, ...rest } = event;
  return { ...rest, responseCount: responses.length };
}

const closed = (event, res) => {
  if (!event.decided) return false;
  res.status(409).json({ error: "This event has been decided, so replies are closed." });
  return true;
};

function loadParticipant(req, res) {
  const event = loadEvent(req, res);
  if (!event) return {};
  const me = store.findWebResponse(event, req.params.token);
  if (!me) res.status(404).json({ error: "This personal link doesn't match anyone. Ask the organizer for the event link and reply again." });
  return { event, me };
}

app.get("/api/status", (req, res) => {
  res.json({ demoMode: isDemoMode(), model: isDemoMode() ? null : modelName() });
});

app.post("/api/events", (req, res) => {
  const { fields, problems } = normalizeEventFields(req.body);
  if (Object.keys(problems).length) return res.status(400).json({ error: Object.values(problems).join(" ") });

  const event = store.createEvent(fields, req.newEventId);
  res.json({ id: event.id, adminKey: event.adminKey });
});

app.get("/api/events/:id", (req, res) => {
  const event = loadEvent(req, res);
  if (event) res.json(publicView(event));
});

// Participant sends the conversation so far; returns either a follow-up question
// or the structured interpretation to confirm.
app.post("/api/events/:id/parse", async (req, res) => {
  const event = loadEvent(req, res);
  if (!event || closed(event, res)) return;
  const transcript = (Array.isArray(req.body?.transcript) ? req.body.transcript : [])
    .filter((t) => (t.role === "participant" || t.role === "assistant") && typeof t.text === "string")
    .slice(-12)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }));
  if (!transcript.some((t) => t.role === "participant")) return res.status(400).json({ error: "Say something first." });
  try {
    const parsed = await parseReply(event, transcript);
    const asked = transcript.filter((t) => t.role === "assistant").length;
    res.json({ parsed, clarificationsLeft: Math.max(0, MAX_CLARIFICATIONS - asked) });
  } catch (err) {
    console.error("parse failed:", err);
    res.status(502).json({ error: `AI parsing failed: ${err.message}` });
  }
});

app.post("/api/events/:id/responses", (req, res) => {
  const event = loadEvent(req, res);
  if (!event || closed(event, res)) return;
  const name = str(req.body?.name, 60);
  const parsed = req.body?.parsed;
  if (!name) return res.status(400).json({ error: "Name is required." });
  if (!parsed || !Array.isArray(parsed.availability)) return res.status(400).json({ error: "Missing parsed response." });
  const clean = sanitizeParsed(event, {
    summary: str(parsed.summary, 500),
    availability: parsed.availability.slice(0, 100),
    hard_constraints: (parsed.hard_constraints || []).map((s) => str(s, 200)).filter(Boolean).slice(0, 20),
    preferences: (parsed.preferences || []).slice(0, 30).map((p) => ({
      topic: str(p.topic, 40),
      value: str(p.value, 200),
      strength: ["strong", "medium", "weak"].includes(p.strength) ? p.strength : "medium",
    })),
    notes: str(parsed.notes, 500),
  });
  clean.availability = clean.availability.filter((b) => ["preferred", "available", "if_needed"].includes(b.level));
  const transcript = (Array.isArray(req.body.transcript) ? req.body.transcript : [])
    .filter((t) => (t.role === "participant" || t.role === "assistant") && typeof t.text === "string")
    .slice(-12)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }));
  const saved = store.saveWebResponse(event.id, { token: str(req.body.token, 40), name, parsed: clean, transcript, contact: str(req.body.contact, 120) });
  res.json({ ok: true, token: saved.token });
});

// ----- a participant's personal page (the web version of a Slack DM) -----
app.get("/api/events/:id/me/:token", (req, res) => {
  const { event, me } = loadParticipant(req, res);
  if (me) res.json(participantView(event, me));
});

app.post("/api/events/:id/me/:token/message", async (req, res) => {
  const { event, me } = loadParticipant(req, res);
  if (!me || closed(event, res)) return;
  const text = str(req.body?.text, 2000);
  if (!text) return res.status(400).json({ error: "Say something first." });
  try {
    const result = await handleMessage(event.id, me.token, text);
    res.json({ ...result, ...participantView(store.getEvent(event.id), store.findWebResponse(store.getEvent(event.id), me.token)) });
  } catch (err) {
    console.error("message failed:", err);
    res.status(502).json({ error: `AI parsing failed: ${err.message}` });
  }
});

app.post("/api/events/:id/me/:token/answer", (req, res) => {
  const { event, me } = loadParticipant(req, res);
  if (!me || closed(event, res)) return;
  try {
    answerNegotiation(event.id, me.token, req.body?.yes === true);
    res.json(participantView(store.getEvent(event.id), store.findWebResponse(store.getEvent(event.id), me.token)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/events/:id/me/:token/availability", (req, res) => {
  const { event, me } = loadParticipant(req, res);
  if (!me || closed(event, res)) return;
  if (!Array.isArray(req.body?.availability)) return res.status(400).json({ error: "Missing availability." });
  setAvailability(event.id, me.token, req.body.availability);
  const fresh = store.getEvent(event.id);
  res.json(participantView(fresh, store.findWebResponse(fresh, me.token)));
});

app.post("/api/events/:id/me/:token/contact", (req, res) => {
  const { event, me } = loadParticipant(req, res);
  if (!me) return;
  store.updateEvent(event.id, (e) => (store.findWebResponse(e, me.token).contact = str(req.body?.contact, 120)));
  res.json({ ok: true });
});

app.get("/api/events/:id/admin", (req, res) => {
  const event = requireAdmin(req, res);
  if (!event) return;
  res.json({
    event: publicView(event),
    responses: event.responses.map(({ transcript, thread, token, ...r }) => ({
      ...r,
      web: isWebParticipant({ token, ...r }),
      personalPath: isWebParticipant({ token, ...r }) ? `/e/${event.id}/me/${token}` : null,
      waitingOnThem: r.negotiation?.status === "asked",
    })),
    heatmap: buildHeatmap(event, event.responses),
    candidates: rankSlots(event, event.responses),
    recommendation: event.recommendation,
    negotiation: {
      askable: askableParticipants(event).map((r) => ({ name: r.name, web: isWebParticipant(r) })),
      log: (event.negotiationLog || []).map(({ token, ...n }) => ({ ...n, personalPath: token ? `/e/${event.id}/me/${token}` : null })),
    },
    decided: event.decided || null,
  });
});

app.post("/api/events/:id/recommend", async (req, res) => {
  const event = requireAdmin(req, res);
  if (!event || closed(event, res)) return;
  if (!event.responses.length) return res.status(400).json({ error: "No responses yet." });
  const candidates = rankSlots(event, event.responses, 6);
  if (!candidates.length) return res.status(400).json({ error: "No time works for anyone yet." });
  try {
    const rec = await recommend(event, candidates);
    store.setRecommendation(event.id, { ...rec, responseCount: event.responses.length });
    res.json(store.getEvent(event.id).recommendation);
  } catch (err) {
    console.error("recommend failed:", err);
    res.status(502).json({ error: `AI recommendation failed: ${err.message}` });
  }
});

// Demo helper: add made-up participants' replies (organizer only).
app.post("/api/events/:id/simulate", async (req, res) => {
  const event = requireAdmin(req, res);
  if (!event) return;
  const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 12);
  try {
    const added = await simulateReplies(event.id, count);
    res.json({ added });
  } catch (err) {
    console.error("simulate failed:", err);
    res.status(502).json({ error: `Simulation failed: ${err.message}` });
  }
});

// Ask the people who can't make the top pick whether they could adjust. Web participants
// get the question on their personal page; test participants answer on the spot.
app.post("/api/events/:id/negotiate", async (req, res) => {
  const event = requireAdmin(req, res);
  if (!event || closed(event, res)) return;
  const slot = event.recommendation?.proposals?.[0]?.slot;
  if (!slot) return res.status(400).json({ error: "Generate a plan first." });
  const people = askableParticipants(event);
  if (!people.length) return res.status(400).json({ error: "Everyone who can't make it has already been asked." });
  const results = [];
  for (const person of people) {
    try {
      results.push(isWebParticipant(person) ? await askWebParticipant(event.id, person, slot) : { ...(await askTestParticipant(event.id, person, slot)), status: "answered" });
    } catch (err) {
      console.error("negotiation failed:", err);
    }
  }
  res.json({ results });
});

// Organizer picks a proposal: the event closes and everyone's page shows the decision.
app.post("/api/events/:id/announce", (req, res) => {
  const event = requireAdmin(req, res);
  if (!event || closed(event, res)) return;
  const index = Number(req.body?.index) || 0;
  const p = event.recommendation?.proposals?.[index];
  if (!p) return res.status(400).json({ error: "Generate a plan first." });
  const message = index === 0 && event.recommendation.announcement
    ? event.recommendation.announcement
    : `${event.title}: ${p.title}\n${p.slot.date} ${p.slot.start}–${p.slot.end}\n${p.details}`;
  store.updateEvent(event.id, (e) => {
    e.decided = { index, title: p.title, slot: { date: p.slot.date, start: p.slot.start, end: p.slot.end }, details: p.details, message, at: new Date().toISOString() };
  });
  res.json(store.getEvent(event.id).decided);
});
