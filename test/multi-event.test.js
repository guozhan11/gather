// Several events collecting replies at the same time: does every message land on the right
// event? Two events share a channel, a third is elsewhere; people reply in threads (all at
// once), mention @Gather, reply in the channel without tagging, and answer reminder DMs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gather-multi-"));
process.env.DEMO_MODE = "1";
const { registerSlackHandlers } = await import("../lib/slack.js");
const store = await import("../lib/store.js");

const ORG = "U0ORG";
const BOT = "UBOT";

// Real Slack rejects a message whose buttons in one block share an action_id; so does this fake.
function checkBlocks(args = {}) {
  const blocks = args.blocks || args.view?.blocks || [];
  for (const b of blocks) {
    if (b.type !== "actions") continue;
    const ids = b.elements.map((e) => e.action_id);
    if (new Set(ids).size !== ids.length) throw Object.assign(new Error("invalid_blocks"), { data: { error: `invalid_blocks: duplicate action_id in ${ids.join(",")}` } });
  }
}

function fakeSlack() {
  const handlers = { command: {}, view: {}, event: {}, action: [] };
  const app = {
    command: (n, fn) => (handlers.command[n] = fn),
    view: (n, fn) => (handlers.view[n] = fn),
    event: (n, fn) => (handlers.event[n] = fn),
    action: (k, fn) => handlers.action.push([k, fn]),
  };
  const calls = [];
  let ts = 1000;
  const rec = (method, result = {}) => async (args) => {
    checkBlocks(args);
    calls.push({ method, args });
    return typeof result === "function" ? result(args) : result;
  };
  const client = {
    views: { open: rec("views.open") },
    users: { info: rec("users.info", ({ user }) => ({ user: { id: user, tz: "America/New_York", profile: { display_name: user } } })) },
    conversations: {
      join: rec("conversations.join"),
      open: rec("conversations.open", ({ users }) => ({ channel: { id: `D_${users}` } })),
      members: rec("conversations.members", () => ({ members: [ORG, BOT, "U0EVE", "U0GUS"] })),
    },
    chat: { postMessage: rec("chat.postMessage", () => ({ ts: `${++ts}.0` })), postEphemeral: rec("chat.postEphemeral"), update: rec("chat.update") },
    reactions: { add: rec("reactions.add") },
  };
  registerSlackHandlers(app, {});
  const action = (id) => handlers.action.find(([k]) => (k instanceof RegExp ? k.test(id) : k === id))[1];
  return { handlers, client, calls, action, take: () => calls.splice(0) };
}

const values = (title) => ({
  title: { v: { value: title } }, description: { v: { value: null } }, askAbout: { v: { selected_options: [] } },
  dateStart: { v: { selected_date: "2026-10-19" } }, dateEnd: { v: { selected_date: "2026-10-23" } },
  dayStart: { v: { selected_time: "17:00" } }, dayEnd: { v: { selected_time: "23:00" } }, durationMinutes: { v: { selected_option: { value: "120" } } },
});

const s = fakeSlack();
const noop = async () => {};
async function createEvent(channel, title) {
  await s.handlers.view.gather_create({ ack: noop, client: s.client, body: { user: { id: ORG } }, view: { private_metadata: JSON.stringify({ channel }), state: { values: values(title) } } });
  s.take();
  return Object.values(store.allEvents()).find((e) => e.title === title);
}
const message = (event) => s.handlers.event.message({ client: s.client, context: { botUserId: BOT }, event });
const respondersOf = (event) => store.getEvent(event.id).responses.map((r) => r.slackUserId).sort();

const happyHour = await createEvent("C0LAB", "Lab happy hour");
const reading = await createEvent("C0LAB", "Reading group"); // same channel
const games = await createEvent("C0FUN", "Board games");

test("thread replies to three events, all arriving at once, each land on their own event", async () => {
  const plan = [
    [happyHour, ["U0A1", "U0A2", "U0A3", "U0A4"]],
    [reading, ["U0B1", "U0B2", "U0B3"]],
    [games, ["U0C1", "U0C2", "U0C3", "U0A1"]], // U0A1 replies to two events
  ];
  let n = 0;
  await Promise.all(plan.flatMap(([event, users]) => users.map((user) =>
    message({ channel: event.slack.channel, thread_ts: event.slack.ts, ts: `8000.${++n}`, user, text: "Wednesday after 7pm" }))));
  assert.deepEqual(respondersOf(happyHour), ["U0A1", "U0A2", "U0A3", "U0A4"]);
  assert.deepEqual(respondersOf(reading), ["U0B1", "U0B2", "U0B3"]);
  assert.deepEqual(respondersOf(games), ["U0A1", "U0C1", "U0C2", "U0C3"]);
  s.take();
});

test("@Gather in a channel with two open events asks which one, instead of guessing", async () => {
  await message({ channel: "C0LAB", ts: "8100.1", user: "U0CAT", text: `<@${BOT}> Friday after 7pm works` });
  const ask = s.take().find((c) => c.method === "chat.postEphemeral" && c.args.user === "U0CAT");
  assert.ok(ask, "U0CAT is asked privately");
  const buttons = ask.args.blocks.find((b) => b.type === "actions").elements;
  const forReading = buttons.find((b) => /Reading group/.test(b.text.text));
  assert.ok(forReading && buttons.some((b) => /Lab happy hour/.test(b.text.text)), "both events are offered");
  assert.ok(!respondersOf(happyHour).includes("U0CAT") && !respondersOf(reading).includes("U0CAT"), "nothing counted before choosing");

  await s.action(forReading.action_id)({ ack: noop, client: s.client, body: { user: { id: "U0CAT" } }, action: forReading, respond: noop });
  assert.ok(respondersOf(reading).includes("U0CAT"));
  assert.ok(!respondersOf(happyHour).includes("U0CAT"));
  s.take();
});

test("an untagged answer in that channel offers both events too", async () => {
  await message({ channel: "C0LAB", ts: "8200.1", user: "U0DAN", text: "Thursday works for me" });
  const prompt = s.take().find((c) => c.method === "chat.postEphemeral" && c.args.user === "U0DAN");
  const buttons = prompt.args.blocks.find((b) => b.type === "actions").elements;
  const forHappyHour = buttons.find((b) => /Lab happy hour/.test(b.text.text));
  assert.ok(forHappyHour && buttons.some((b) => /Reading group/.test(b.text.text)));
  await s.action(forHappyHour.action_id)({ ack: noop, client: s.client, body: { user: { id: "U0DAN" } }, action: forHappyHour, respond: noop });
  assert.ok(respondersOf(happyHour).includes("U0DAN"));
  assert.ok(!respondersOf(reading).includes("U0DAN"));
  s.take();
});

test("in a channel with one open event, @Gather still counts right away", async () => {
  await message({ channel: "C0FUN", ts: "8300.1", user: "U0FAY", text: `<@${BOT}> Monday after 7pm` });
  assert.ok(respondersOf(games).includes("U0FAY"));
  s.take();
});

test("someone reminded by two events is asked which one their DM answer is for", async () => {
  for (const event of [happyHour, games]) {
    await s.action("gather_more")({ ack: noop, client: s.client, context: { botUserId: BOT }, body: { user: { id: ORG } }, action: { selected_option: { value: `remind:${event.id}` } } });
  }
  s.take();
  await message({ channel_type: "im", channel: "D_U0EVE", ts: "8400.1", user: "U0EVE", text: "Tuesday after 7pm works" });
  const pick = s.take().find((c) => c.method === "chat.postMessage" && c.args.channel === "D_U0EVE");
  assert.match(pick.args.text, /Which event/);
  const buttons = pick.args.blocks.find((b) => b.type === "actions").elements;
  assert.deepEqual(buttons.map((b) => b.text.text).sort(), ["Board games", "Lab happy hour"], "only the two events that asked");
  await s.action("gather_dm_pick")({ ack: noop, client: s.client, body: { user: { id: "U0EVE" }, channel: { id: "D_U0EVE" }, message: { ts: "p" } }, action: buttons.find((b) => b.text.text === "Board games") });
  assert.ok(respondersOf(games).includes("U0EVE"));
  assert.ok(!respondersOf(happyHour).includes("U0EVE"));
  s.take();
});

test("someone with just one pending question has their DM go straight to that event", async () => {
  // U0GUS was reminded by both too; answering one leaves only the other pending.
  await message({ channel: "C0LAB", thread_ts: happyHour.slack.ts, ts: "8500.1", user: "U0GUS", text: "Wednesday after 7pm" });
  s.take();
  await message({ channel_type: "im", channel: "D_U0GUS", ts: "8500.2", user: "U0GUS", text: "Thursday after 7pm" });
  const calls = s.take();
  assert.ok(!calls.some((c) => /Which event/.test(c.args?.text || "")));
  assert.ok(respondersOf(games).includes("U0GUS"));
});

test("no reply ended up on an event it wasn't meant for", () => {
  assert.deepEqual(respondersOf(happyHour), ["U0A1", "U0A2", "U0A3", "U0A4", "U0DAN", "U0GUS"]);
  assert.deepEqual(respondersOf(reading), ["U0B1", "U0B2", "U0B3", "U0CAT"]);
  assert.deepEqual(respondersOf(games), ["U0A1", "U0C1", "U0C2", "U0C3", "U0EVE", "U0FAY", "U0GUS"]);
});
