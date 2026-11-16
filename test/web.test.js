// Runs the web version end to end over HTTP, in demo mode: a participant replies on the
// event page, gets a private link, Gather follows up there, and the organizer decides.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${PORT}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DEMO_MODE: "1", DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "gather-web-test-")), SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (d) => /running at/.test(d) && resolve()));
});
test.after(() => server.kill());

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

async function reply(id, name, text, token) {
  const transcript = [{ role: "participant", text }];
  const { data } = await call("POST", `/api/events/${id}/parse`, { transcript });
  const saved = await call("POST", `/api/events/${id}/responses`, { name, parsed: data.parsed, transcript, token });
  assert.equal(saved.status, 200);
  return saved.data.token;
}

test("web: private link, follow-up question, answers, and deciding", async () => {
  const { data: ev } = await call("POST", "/api/events", {
    title: "Lab dinner", dateStart: "2026-10-22", dateEnd: "2026-10-23", dayStart: "17:00", dayEnd: "22:00", durationMinutes: 120, timeZone: "America/New_York",
  });
  const admin = (p) => `/api/events/${ev.id}${p}?key=${ev.adminKey}`;

  // Four people pick Friday; Bo and Cy can only do Thursday.
  for (const n of ["Ann", "Dee", "Eve", "Fay"]) await reply(ev.id, n, "Friday after 7pm");
  const bo = await reply(ev.id, "Bo", "Thursday after 7pm");
  const cy = await reply(ev.id, "Cy", "Thursday after 7pm");
  assert.ok(bo && cy && bo !== cy, "each web participant gets their own private token");

  // Replying again with the token updates the same person, even under another name.
  assert.equal(await reply(ev.id, "Bo B.", "Thursday after 7pm", bo), bo);
  let dash = (await call("GET", admin("/admin"))).data;
  assert.equal(dash.responses.length, 6);
  assert.ok(dash.responses.every((r) => r.token === undefined && r.thread === undefined), "tokens never leak in bulk");
  assert.equal(dash.responses.find((r) => r.name === "Bo B.").personalPath, `/e/${ev.id}/me/${bo}`);

  // The private page works; a wrong token doesn't.
  assert.equal((await call("GET", `/api/events/${ev.id}/me/${bo}`)).data.me.name, "Bo B.");
  assert.equal((await call("GET", `/api/events/${ev.id}/me/nope`)).status, 404);
  assert.equal((await call("GET", `/api/events/${ev.id}`)).data.negotiationLog, undefined);

  await call("POST", admin("/recommend"));
  dash = (await call("GET", admin("/admin"))).data;
  assert.equal(dash.recommendation.proposals[0].slot.date, "2026-10-23");
  assert.deepEqual(dash.negotiation.askable.map((a) => a.name).sort(), ["Bo B.", "Cy"]);

  // Organizer asks: the question lands on each private page.
  const asked = (await call("POST", admin("/negotiate"))).data.results;
  assert.equal(asked.length, 2);
  assert.ok(asked.every((r) => r.status === "asked"));
  const boPage = (await call("GET", `/api/events/${ev.id}/me/${bo}`)).data;
  assert.equal(boPage.me.negotiation.status, "asked");
  assert.equal(boPage.me.thread.at(-1).kind, "negotiation");
  assert.equal((await call("POST", admin("/negotiate"))).status, 400, "nobody is asked twice about the same slot");

  // Bo taps Yes; Cy answers in words.
  const afterYes = (await call("POST", `/api/events/${ev.id}/me/${bo}/answer`, { yes: true })).data;
  assert.equal(afterYes.me.negotiation.status, "yes");
  assert.ok(afterYes.me.parsed.availability.some((b) => b.date === "2026-10-23" && b.start <= "19:00"));
  assert.equal((await call("POST", `/api/events/${ev.id}/me/${bo}/answer`, { yes: true })).status, 400);
  const afterText = (await call("POST", `/api/events/${ev.id}/me/${cy}/message`, { text: "Friday after 7pm works actually" })).data;
  assert.equal(afterText.kind, "updated");
  assert.equal(afterText.me.negotiation.status, "yes");

  dash = (await call("GET", admin("/admin"))).data;
  assert.deepEqual(dash.negotiation.log.map((n) => n.status), ["yes", "yes"]);
  await call("POST", `/api/events/${ev.id}/me/${cy}/contact`, { contact: "wechat: cy123" });
  assert.equal((await call("GET", admin("/admin"))).data.responses.find((r) => r.name === "Cy").contact, "wechat: cy123");

  // Regenerating now gets everyone on Friday; then the organizer decides and replies close.
  await call("POST", admin("/recommend"));
  dash = (await call("GET", admin("/admin"))).data;
  assert.equal(dash.recommendation.proposals[0].slot.missing.length, 0);
  assert.equal((await call("POST", `/api/events/${ev.id}/announce?key=wrong`, { index: 0 })).status, 403);
  const decided = (await call("POST", admin("/announce"), { index: 0 })).data;
  assert.equal(decided.slot.date, "2026-10-23");
  assert.equal((await call("GET", `/api/events/${ev.id}`)).data.decided.slot.date, "2026-10-23");
  assert.equal((await call("POST", `/api/events/${ev.id}/me/${cy}/message`, { text: "hi" })).status, 409);
  assert.equal((await call("POST", `/api/events/${ev.id}/parse`, { transcript: [{ role: "participant", text: "Fri" }] })).status, 409);
});

test("web: adjusting times by hand saves them and answers an open question", async () => {
  const { data: ev } = await call("POST", "/api/events", {
    title: "Paint test", dateStart: "2026-10-22", dateEnd: "2026-10-23", dayStart: "17:00", dayEnd: "22:00", durationMinutes: 120, timeZone: "America/New_York",
  });
  const admin = (p) => `/api/events/${ev.id}${p}?key=${ev.adminKey}`;
  for (const n of ["Ann", "Dee", "Eve"]) await reply(ev.id, n, "Friday after 7pm");
  const bo = await reply(ev.id, "Bo", "Thursday after 7pm");
  await call("POST", admin("/recommend"));
  await call("POST", admin("/negotiate"));

  const painted = [
    { date: "2026-10-22", start: "19:00", end: "22:00", level: "available" },
    { date: "2026-10-23", start: "19:00", end: "21:00", level: "if_needed" },
    { date: "2026-10-23", start: "16:00", end: "18:00", level: "preferred" }, // starts before the window: clipped
    { date: "2026-10-30", start: "19:00", end: "21:00", level: "available" }, // not an event date: dropped
    { date: "2026-10-22", start: "17:00", end: "18:00", level: "bogus" }, // bad level: dropped
  ];
  const res = await call("POST", `/api/events/${ev.id}/me/${bo}/availability`, { availability: painted });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.me.parsed.availability.map((b) => `${b.date} ${b.start}-${b.end} ${b.level}`), [
    "2026-10-22 19:00-22:00 available",
    "2026-10-23 19:00-21:00 if_needed",
    "2026-10-23 17:00-18:00 preferred",
  ]);
  assert.ok(res.data.me.parsed.timesEditedAt);
  assert.equal(res.data.me.negotiation.status, "yes", "painting the asked-about slot counts as yes");
  assert.equal(res.data.me.thread.at(-1).text, "Times adjusted by hand");
  assert.equal((await call("POST", `/api/events/${ev.id}/me/${bo}/availability`, {})).status, 400);
  assert.equal((await call("POST", `/api/events/${ev.id}/me/nope/availability`, { availability: [] })).status, 404);
});
