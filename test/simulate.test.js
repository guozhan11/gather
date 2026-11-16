import test from "node:test";
import assert from "node:assert/strict";
import { fillTemplate } from "../lib/simulate.js";

test("persona templates use the event's own days and window", () => {
  const event = { dateStart: "2026-10-19", dateEnd: "2026-10-23", dayStart: "17:00", dayEnd: "23:00" };
  assert.equal(fillTemplate("{d0} or {d1}, after {mid}, leave by {late}", event), "Monday or Tuesday, after 8pm, leave by 10pm");
  const day = { dateStart: "2026-10-19", dateEnd: "2026-10-20", dayStart: "09:00", dayEnd: "12:00" };
  assert.equal(fillTemplate("{d2} from {early}", day), "Monday from 10am");
});
