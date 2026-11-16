import test from "node:test";
import assert from "node:assert/strict";
import { rankSlots, buildHeatmap } from "../lib/schedule.js";
import { parseReply } from "../lib/demoParser.js";

// 2026-10-22 is a Thursday, 2026-10-23 a Friday.
const event = { dateStart: "2026-10-22", dateEnd: "2026-10-23", dayStart: "17:00", dayEnd: "23:00", durationMinutes: 120 };
const r = (name, availability) => ({ name, parsed: { availability } });

test("ranks the slot most people can attend first", () => {
  const responses = [
    r("A", [{ date: "2026-10-23", start: "18:00", end: "22:00", level: "preferred" }]),
    r("B", [{ date: "2026-10-23", start: "19:00", end: "23:00", level: "available" }]),
    r("C", [{ date: "2026-10-22", start: "17:00", end: "23:00", level: "available" }]),
  ];
  const [best] = rankSlots(event, responses);
  assert.equal(best.date, "2026-10-23");
  assert.equal(best.start, "19:00");
  assert.deepEqual(best.missing, ["C"]);
});

test("shortlist does not contain overlapping slots on the same day", () => {
  const responses = [r("A", [{ date: "2026-10-22", start: "17:00", end: "23:00", level: "available" }])];
  const slots = rankSlots(event, responses);
  assert.deepEqual(slots.map((s) => s.start), ["17:00", "19:00", "21:00"]);
});

test("heatmap counts people per 30-minute cell", () => {
  const hm = buildHeatmap(event, [r("A", [{ date: "2026-10-22", start: "18:00", end: "19:00", level: "available" }])]);
  assert.equal(hm[0].cells.find((c) => c.time === "18:30").count, 1);
  assert.equal(hm[0].cells.find((c) => c.time === "19:00").count, 0);
});

test("demo parser understands a Chinese reply", () => {
  const p = parseReply(event, [{ role: "participant", text: "周四晚上7点以后有空，周五不行。想吃日料，对花生过敏" }]);
  assert.equal(p.status, "complete");
  assert.deepEqual(p.availability, [{ date: "2026-10-22", start: "19:00", end: "23:00", level: "available" }]);
  assert.equal(p.preferences[0].value, "日料");
  assert.deepEqual(p.hard_constraints, ["对花生过敏"]);
});

test("demo parser asks a follow-up when no time is given", () => {
  const p = parseReply(event, [{ role: "participant", text: "I'd love pizza" }]);
  assert.equal(p.status, "need_clarification");
});

test("demo parser keeps what an English allergy is to", () => {
  const p = parseReply(event, [{ role: "participant", text: "Friday evening, allergic to shellfish." }]);
  assert.deepEqual(p.hard_constraints, ["allergic to shellfish"]);
});
