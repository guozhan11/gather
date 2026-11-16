// Runs the Slack bot's handlers against a fake Slack client, in demo mode,
// to check the whole flow: /gather -> modal -> thread replies -> plan -> announce.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gather-slack-test-"));
process.env.DEMO_MODE = "1";
const { registerSlackHandlers } = await import("../lib/slack.js");
const store = await import("../lib/store.js");

const ORGANIZER = "U_ORG";
const CHANNEL = "C_LAB";

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
    command: (name, fn) => (handlers.command[name] = fn),
    view: (id, fn) => (handlers.view[id] = fn),
    event: (name, fn) => (handlers.event[name] = fn),
    action: (id, fn) => handlers.action.push([id, fn]),
  };
  const calls = [];
  let ts = 1000;
  const record = (method, result = {}) => async (args) => {
    checkBlocks(args);
    calls.push({ method, args });
    return typeof result === "function" ? result(args) : result;
  };
  const client = {
    views: { open: record("views.open") },
    users: { info: record("users.info", ({ user }) => ({ user: { tz: "America/New_York", profile: { display_name: user.replace("U_", "") } } })) },
    conversations: { join: record("conversations.join"), open: record("conversations.open", ({ users }) => ({ channel: { id: `D_${users}` } })) },
    chat: {
      postMessage: record("chat.postMessage", () => ({ ts: `${++ts}.0` })),
      postEphemeral: record("chat.postEphemeral"),
      update: record("chat.update"),
    },
    reactions: { add: record("reactions.add") },
  };
  registerSlackHandlers(app, { dashboardUrl: (e) => `http://localhost/e/${e.id}/admin?key=${e.adminKey}` });
  const action = (id) => handlers.action.find(([k]) => (k instanceof RegExp ? k.test(id) : k === id))[1];
  return { handlers, client, calls, action, take: () => calls.splice(0) };
}

const modalValues = (over = {}) => {
  const f = { title: "Lab happy hour", dateStart: "2026-10-19", dateEnd: "2026-10-23", dayStart: "17:00", dayEnd: "23:00", duration: "120", ...over };
  return {
    title: { v: { value: f.title } },
    description: { v: { value: null } },
    askAbout: { v: { selected_options: [{ value: "Food preferences" }, { value: "Budget" }] } },
    dateStart: { v: { selected_date: f.dateStart } },
    dateEnd: { v: { selected_date: f.dateEnd } },
    dayStart: { v: { selected_time: f.dayStart } },
    dayEnd: { v: { selected_time: f.dayEnd } },
    durationMinutes: { v: { selected_option: { value: f.duration } } },
  };
};

test("full Slack flow", async (t) => {
  const s = fakeSlack();
  const noop = async () => {};

  await t.test("/gather opens the form prefilled with the command text", async () => {
    await s.handlers.command["/gather"]({ ack: noop, client: s.client, command: { trigger_id: "T1", channel_id: CHANNEL, text: "Lab happy hour" } });
    const [open] = s.take();
    assert.equal(open.method, "views.open");
    assert.equal(open.args.view.blocks[0].element.initial_value, "Lab happy hour");
  });

  await t.test("an invalid date range is reported on the form", async () => {
    let acked;
    await s.handlers.view.gather_create({
      ack: async (a) => (acked = a), client: s.client, body: { user: { id: ORGANIZER } },
      view: { private_metadata: JSON.stringify({ channel: CHANNEL }), state: { values: modalValues({ dateEnd: "2026-10-01" }) } },
    });
    assert.equal(acked.response_action, "errors");
    assert.ok(acked.errors.dateEnd);
    assert.ok(!s.take().some((c) => c.method === "chat.postMessage"));
  });

  let event;
  await t.test("submitting the form posts the event in the channel", async () => {
    let acked = "not called";
    await s.handlers.view.gather_create({
      ack: async (a) => (acked = a), client: s.client, body: { user: { id: ORGANIZER } },
      view: { private_metadata: JSON.stringify({ channel: CHANNEL }), state: { values: modalValues() } },
    });
    assert.equal(acked, undefined);
    const calls = s.take();
    const post = calls.find((c) => c.method === "chat.postMessage");
    assert.equal(post.args.channel, CHANNEL);
    assert.match(JSON.stringify(post.args.blocks), /Reply in this thread/);
    const tip = calls.find((c) => c.method === "chat.postEphemeral");
    assert.equal(tip.args.user, ORGANIZER);
    assert.match(tip.args.text, /admin\?key=/);
    event = store.findEventBySlackThread(CHANNEL, "1001.0");
    assert.equal(event.title, "Lab happy hour");
    assert.equal(event.timeZone, "America/New_York");
  });

  const reply = (user, text, ts) =>
    s.handlers.event.message({ client: s.client, event: { channel: CHANNEL, thread_ts: event.slack.ts, ts, user, text } });

  await t.test("a reply with no times gets a follow-up question in the thread", async () => {
    await reply("U_ALICE", "I want sushi!", "2000.1");
    const [q] = s.take();
    assert.equal(q.method, "chat.postMessage");
    assert.equal(q.args.thread_ts, event.slack.ts);
    assert.match(q.args.text, /^<@U_ALICE> /);
    assert.equal(store.getEvent(event.id).responses.length, 0);
  });

  await t.test("answering the follow-up records the response", async () => {
    await reply("U_ALICE", "Thursday after 7pm, Friday evening is best", "2000.2");
    const calls = s.take();
    assert.deepEqual(calls.map((c) => c.method), ["users.info", "reactions.add", "chat.postEphemeral", "chat.update"]);
    assert.match(JSON.stringify(calls[2].args.blocks), /sushi/);
    assert.match(JSON.stringify(calls[3].args.blocks), /1 replied: <@U_ALICE>/);
    const [r] = store.getEvent(event.id).responses;
    assert.equal(r.name, "ALICE");
    assert.equal(r.slackUserId, "U_ALICE");
  });

  await t.test("bot messages, unrelated channel chat and other threads are ignored", async () => {
    await s.handlers.event.message({ client: s.client, event: { channel: CHANNEL, ts: "3000.1", user: "U_BOB", text: "Nice slides today, Sam!" } });
    await s.handlers.event.message({ client: s.client, event: { channel: CHANNEL, thread_ts: "9999.0", ts: "3000.2", user: "U_BOB", text: "Friday works" } });
    await s.handlers.event.message({ client: s.client, event: { channel: CHANNEL, thread_ts: event.slack.ts, ts: "3000.3", bot_id: "B1", text: "Friday" } });
    assert.equal(s.take().length, 0);
  });

  await t.test("a second person replies in Chinese", async () => {
    await reply("U_CAROL", "周五晚上7点以后有空，想吃日料，对花生过敏", "2000.3");
    s.take();
    assert.equal(store.getEvent(event.id).responses.length, 2);
  });

  await t.test("only the organizer can generate the plan", async () => {
    await s.action("gather_plan")({ ack: noop, client: s.client, body: { user: { id: "U_ALICE" } }, action: { value: event.id } });
    const [deny] = s.take();
    assert.equal(deny.method, "chat.postEphemeral");
    assert.match(deny.args.text, /Only <@U_ORG>/);
  });

  await t.test("the organizer gets a plan in the thread", async () => {
    await s.action("gather_plan")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: { value: event.id } });
    const [placeholder, update] = s.take();
    assert.equal(placeholder.args.thread_ts, event.slack.ts);
    assert.equal(update.method, "chat.update");
    const blocks = JSON.stringify(update.args.blocks);
    assert.match(blocks, /Fri, Oct 23/);
    assert.match(blocks, /gather_announce_0/);
  });

  await t.test("announcing posts the decision and closes the event", async () => {
    await s.action("gather_announce_0")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: { value: `${event.id}:0` } });
    const [announce, update] = s.take();
    assert.equal(announce.args.channel, CHANNEL);
    assert.equal(announce.args.thread_ts, undefined);
    assert.match(JSON.stringify(announce.args.blocks), /is on/);
    assert.match(JSON.stringify(update.args.blocks), /Decided/);
    assert.ok(!JSON.stringify(update.args.blocks).includes("gather_plan"));

    await reply("U_DAN", "Thursday works", "2000.9");
    assert.equal(s.take().length, 0, "replies after the decision are ignored");
  });
});

test("organizer can add simulated replies from the ⋯ menu", async () => {
  const s = fakeSlack();
  const noop = async () => {};
  await s.handlers.view.gather_create({
    ack: noop, client: s.client, body: { user: { id: ORGANIZER } },
    view: { private_metadata: JSON.stringify({ channel: "C_SIM" }), state: { values: modalValues() } },
  });
  const post = s.take().find((c) => c.method === "chat.postMessage");
  const overflow = post.args.blocks.find((b) => b.type === "actions").elements.find((e) => e.type === "overflow");
  const event = store.findEventBySlackThread("C_SIM", "1001.0");
  const pick = (user) => s.action("gather_more")({ ack: noop, client: s.client, body: { user: { id: user } }, action: { selected_option: overflow.options.find((o) => o.value.startsWith("simulate:")) } });

  await pick("U_ALICE");
  assert.match(s.take()[0].args.text, /Only <@U_ORG>/);
  assert.equal(store.getEvent(event.id).responses.length, 0);

  await pick(ORGANIZER);
  const calls = s.take();
  const threadPosts = calls.filter((c) => c.method === "chat.postMessage" && c.args.thread_ts === event.slack.ts);
  assert.equal(threadPosts.length, 5);
  assert.match(threadPosts[0].args.text, /^🧪 \*/);
  const responses = store.getEvent(event.id).responses;
  assert.equal(responses.length, 5);
  assert.ok(responses.every((r) => r.simulated && r.name.endsWith("(sim)")));
  assert.match(JSON.stringify(calls.at(-1).args.blocks), /5 replied: Maya \(sim\)/);

  await pick(ORGANIZER);
  s.take();
  assert.equal(store.getEvent(event.id).responses.length, 10, "a second batch uses new people");
});

// ---------- direct messages ----------

async function newEvent(s, channel) {
  await s.handlers.view.gather_create({
    ack: async () => {}, client: s.client, body: { user: { id: ORGANIZER } },
    view: { private_metadata: JSON.stringify({ channel }), state: { values: modalValues() } },
  });
  s.take();
  return Object.values(store.allEvents()).find((e) => e.slack?.channel === channel);
}

const dmFrom = (s, user, text) =>
  s.handlers.event.message({ client: s.client, event: { channel_type: "im", channel: `D_${user}`, user, ts: String(Math.random()), text } });

test("DM: a private reply asks which event, then confirms in the DM", async () => {
  const s = fakeSlack();
  const event = await newEvent(s, "C_DM1");
  await dmFrom(s, "U_ZOE", "Thursday after 7pm works, I'm vegetarian");
  const pick = s.take().find((c) => c.method === "chat.postMessage");
  assert.equal(pick.args.channel, "D_U_ZOE");
  const buttons = pick.args.blocks.find((b) => b.type === "actions").elements;
  const mine = buttons.find((b) => b.value === event.id);
  assert.ok(mine, "the new event is one of the choices");

  await s.action("gather_dm_pick")({ ack: async () => {}, client: s.client, body: { user: { id: "U_ZOE" }, channel: { id: "D_U_ZOE" }, message: { ts: "m1" } }, action: mine });
  const calls = s.take();
  const confirm = calls.find((c) => c.method === "chat.postMessage" && c.args.channel === "D_U_ZOE");
  assert.match(JSON.stringify(confirm.args.blocks), /When you can come/);
  const r = store.getEvent(event.id).responses.find((x) => x.slackUserId === "U_ZOE");
  assert.equal(r.private, true);
  assert.ok(r.parsed.hard_constraints.includes("vegetarian"));
  assert.ok(calls.some((c) => c.method === "chat.update" && c.args.channel === "C_DM1"), "event message shows the new reply");
});

test("DM: help and questions get answered", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_ZOE", "help");
  assert.match(s.take()[0].args.text, /Set up a new event/);
  await dmFrom(s, "U_ZOE", "Who has replied?");
  const answer = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(answer.args.text, /Open events/);
});

test("DM: one sentence becomes an event draft, then a posted event", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_ORG", "Plan a board game night next week");
  const ask = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(ask.args.text, /Which channel/);

  await dmFrom(s, "U_ORG", "<#C0GAMES|games>");
  const preview = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(JSON.stringify(preview.args.blocks), /board game night/);
  const post = preview.args.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "gather_draft_post");

  await s.action("gather_draft_post")({ ack: async () => {}, client: s.client, body: { user: { id: "U_ORG" }, channel: { id: "D_U_ORG" }, message: { ts: "m2" }, trigger_id: "T2" }, action: post });
  const calls = s.take();
  assert.ok(calls.some((c) => c.method === "chat.postMessage" && c.args.channel === "C0GAMES"));
  assert.ok(calls.some((c) => c.method === "chat.update" && /Posted/.test(c.args.text)));
  const created = Object.values(store.allEvents()).find((e) => e.slack?.channel === "C0GAMES");
  assert.equal(created.slack.organizer, "U_ORG");
});

test("negotiation: Gather DMs people who can't make the top pick", async () => {
  const s = fakeSlack();
  const event = await newEvent(s, "C_NEGO");
  const reply = (user, text) =>
    s.handlers.event.message({ client: s.client, event: { channel: "C_NEGO", thread_ts: event.slack.ts, ts: String(Math.random()), user, text } });
  await reply("U_A", "Friday after 7pm");
  await reply("U_B", "Friday after 7pm");
  await reply("U_E", "Friday after 7pm");
  await reply("U_C", "Thursday after 7pm");
  await reply("U_D", "Thursday after 7pm");
  s.take();

  await s.action("gather_plan")({ ack: async () => {}, client: s.client, body: { user: { id: ORGANIZER } }, action: { value: event.id } });
  const plan = s.take().find((c) => c.method === "chat.update");
  const ask = plan.args.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "gather_negotiate");
  assert.match(ask.text.text, /the 2 people/);

  await s.action("gather_negotiate")({ ack: async () => {}, client: s.client, body: { user: { id: "U_A" } }, action: ask });
  assert.match(s.take().find((c) => c.method === "chat.postEphemeral").args.text, /Only <@U_ORG>/);

  await s.action("gather_negotiate")({ ack: async () => {}, client: s.client, body: { user: { id: ORGANIZER } }, action: ask });
  const calls = s.take();
  const dms = calls.filter((c) => c.method === "chat.postMessage" && /^D_/.test(c.args.channel));
  assert.deepEqual(dms.map((c) => c.args.channel).sort(), ["D_U_C", "D_U_D"]);
  assert.match(calls.at(-1).args.text, /privately asked/);

  // U_C taps "Yes"
  const yes = dms.find((c) => c.args.channel === "D_U_C").args.blocks.find((b) => b.type === "actions").elements[0];
  await s.action("gather_nego_yes")({ ack: async () => {}, client: s.client, body: { user: { id: "U_C" }, channel: { id: "D_U_C" }, message: { ts: "n1" } }, action: yes });
  const afterYes = s.take();
  assert.ok(afterYes.some((c) => c.args.channel === "D_U_ORG" && /can make/.test(c.args.text)), "organizer hears the good news");
  const slot = store.getEvent(event.id).recommendation.proposals[0].slot;
  const c = store.getEvent(event.id).responses.find((r) => r.slackUserId === "U_C");
  assert.ok(c.parsed.availability.some((b) => b.date === slot.date && b.start === slot.start));

  // U_D answers in words instead
  await dmFrom(s, "U_D", "Friday after 7pm works actually");
  const afterText = s.take();
  assert.ok(afterText.some((c) => c.args.channel === "D_U_ORG" && /can make/.test(c.args.text)));
  assert.equal(store.getEvent(event.id).slack.negotiations.U_D.status, "yes");
});

test("negotiation: test participants answer in the thread", async () => {
  const s = fakeSlack();
  const event = await newEvent(s, "C_SIMNEGO");
  const noop = async () => {};
  const menu = { selected_option: { value: `simulate:${event.id}` } };
  await s.action("gather_more")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: menu });
  await s.action("gather_more")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: menu });
  s.take();

  await s.action("gather_plan")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: { value: event.id } });
  const plan = s.take().find((c) => c.method === "chat.update");
  const top = store.getEvent(event.id).recommendation.proposals[0].slot;
  assert.ok(top.missing.length > 0, "someone can't make the top pick");
  const ask = plan.args.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "gather_negotiate");
  assert.ok(ask, "the plan offers to ask them");

  await s.action("gather_negotiate")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: ask });
  const calls = s.take();
  const exchanges = calls.filter((c) => c.method === "chat.postMessage" && c.args.thread_ts === event.slack.ts && /I asked/.test(c.args.text));
  assert.ok(exchanges.length > 0);
  assert.ok(exchanges.every((c) => /\(sim\)\*: /.test(c.args.text)), "each exchange includes the answer");
  assert.ok(!calls.some((c) => c.method === "conversations.open"), "test participants are never DMed");
  assert.match(calls.find((c) => c.method === "chat.postEphemeral").args.text, /Test participants answered/);
  assert.equal(store.getEvent(event.id).negotiationLog.length, exchanges.length);

  await s.action("gather_negotiate")({ ack: noop, client: s.client, body: { user: { id: ORGANIZER } }, action: ask });
  assert.match(s.take()[0].args.text, /already asked everyone/);
});

test("test participants answer the follow-up according to their persona", async () => {
  const { simulateReplies, simulateNegotiationAnswer } = await import("../lib/simulate.js");
  const s = fakeSlack();
  const event = await newEvent(s, "C_PERSONA");
  await simulateReplies(event.id, 12);
  // Friday Oct 23, inside the window: a "yes" persona can make it, a "no" persona can't.
  const slot = { date: "2026-10-23", start: "19:00", end: "21:00" };
  const yes = await simulateNegotiationAnswer(event.id, "Maya (sim)", slot, "Could you make Friday 7–9pm?");
  assert.match(yes.answer, /Sure, I can make Friday 7pm–9pm work/);
  assert.equal(yes.fits, true);
  const no = await simulateNegotiationAnswer(event.id, "Priya (sim)", slot, "Could you make Friday 7–9pm?");
  assert.match(no.answer, /doesn't work/);
  assert.equal(no.fits, false);
  const zh = await simulateNegotiationAnswer(event.id, "李明 (sim)", slot, "周五 7–9 点可以吗？");
  assert.match(zh.answer, /周五 7pm–9pm可以，不过我会晚到半小时/);
});

test("web events (no Slack) can still ask test participants", async () => {
  const { negotiationCandidates } = await import("../lib/negotiate.js");
  const sim = { name: "Maya (sim)", simulated: true, parsed: { availability: [] } };
  const person = { name: "Bo", parsed: { availability: [] } };
  const event = { responses: [sim, person] };
  assert.deepEqual(negotiationCandidates(event, { date: "2026-10-23", missing: ["Maya (sim)", "Bo"] }).map((r) => r.name), ["Maya (sim)"]);
});

test("DM: choosing the channel from the menu, and 'ok' while it's waiting", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_PAT", "Plan a party next Friday at 8pm");
  const picker = s.take().find((c) => c.method === "chat.postMessage");
  const actions = picker.args.blocks.find((b) => b.type === "actions");
  assert.equal(actions.elements[0].type, "conversations_select");
  assert.doesNotMatch(picker.args.text, /#social/, "no example channel that reads like a suggestion");

  await dmFrom(s, "U_PAT", "ok");
  const nudge = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(nudge.args.text, /menu in the preview above/);

  await s.action("gather_draft_channel")({
    ack: async () => {}, client: s.client,
    body: { user: { id: "U_PAT" }, channel: { id: "D_U_PAT" }, message: { ts: "p1" } },
    action: { block_id: actions.block_id, selected_conversation: "C0PARTY" },
  });
  const preview = s.take().find((c) => c.method === "chat.update");
  assert.equal(preview.args.ts, "p1", "the question turns into the preview");
  assert.match(JSON.stringify(preview.args.blocks), /C0PARTY/);
  assert.match(JSON.stringify(preview.args.blocks), /gather_draft_post/);
});

test("DM: a longer message while a channel is pending starts a new topic", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_QUINN", "Plan a picnic next week");
  s.take();
  await dmFrom(s, "U_QUINN", "Actually, who has replied to the happy hour so far?");
  const answer = s.take().find((c) => c.method === "chat.postMessage");
  assert.doesNotMatch(answer.args.text, /menu above/);
});

test("DM: feedback on an open draft revises it", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_RAE", "Plan a party next Friday in <#C0RAE|social>");
  const first = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(JSON.stringify(first.args.blocks), /2 hours/);
  assert.match(JSON.stringify(first.args.blocks), /Want changes\? Just tell me here/);

  await dmFrom(s, "U_RAE", "make it 3 hours");
  const calls = s.take();
  const closed = calls.find((c) => c.method === "chat.update");
  assert.match(closed.args.text, /Updated version below/);
  const posts = calls.filter((c) => c.method === "chat.postMessage");
  assert.match(posts[0].args.text, /Updated the draft/);
  assert.match(JSON.stringify(posts.at(-1).args.blocks), /3 hours/);
  assert.match(JSON.stringify(posts.at(-1).args.blocks), /gather_draft_post/);

  // A question isn't an edit: it gets answered normally and the draft stays as it was.
  await dmFrom(s, "U_RAE", "who has replied so far?");
  const answer = s.take().filter((c) => c.method === "chat.postMessage");
  assert.equal(answer.length, 1);
  assert.doesNotMatch(JSON.stringify(answer[0].args), /gather_draft_post/);
});

test("DM: the edit form can be reopened, and posting from it closes the preview", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_SKY", "Plan a movie night next week in <#C0SKY|movies>");
  const preview = s.take().find((c) => c.method === "chat.postMessage");
  const edit = preview.args.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "gather_draft_edit");
  const click = () => s.action("gather_draft_edit")({ ack: async () => {}, client: s.client, body: { user: { id: "U_SKY" }, channel: { id: "D_U_SKY" }, message: { ts: "1001.0" }, trigger_id: "T" }, action: edit });

  await click();
  let calls = s.take();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "views.open");
  assert.ok(!calls.some((c) => c.method === "chat.update"), "the preview and its buttons stay");
  await click();
  const reopened = s.take().find((c) => c.method === "views.open");
  assert.ok(reopened, "the form opens a second time");

  const meta = reopened.args.view.private_metadata;
  assert.ok(JSON.parse(meta).draftId);
  await s.handlers.view.gather_create({
    ack: async () => {}, client: s.client, body: { user: { id: "U_SKY" } },
    view: { private_metadata: meta, state: { values: modalValues({ title: "Movie night" }) } },
  });
  calls = s.take();
  assert.ok(calls.some((c) => c.method === "chat.postMessage" && c.args.channel === "C0SKY"));
  const closed = calls.find((c) => c.method === "chat.update" && c.args.channel === "D_U_SKY");
  assert.match(closed.args.text, /Posted \*Movie night\*/);
});

test("DM: feedback works before a channel is chosen, and the form asks for one", async () => {
  const s = fakeSlack();
  await dmFrom(s, "U_TOM", "Plan a party next Friday at 8pm");
  const first = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(JSON.stringify(first.args.blocks), /party/i, "the draft is shown right away");
  assert.ok(first.args.blocks.find((b) => b.type === "actions").elements.some((e) => e.type === "conversations_select"));

  await dmFrom(s, "U_TOM", "write it all in English and make it 3 hours");
  const calls = s.take();
  const revised = calls.filter((c) => c.method === "chat.postMessage").at(-1);
  assert.match(JSON.stringify(revised.args.blocks), /3 hours/, "the edit was applied, not answered as chat");
  assert.ok(revised.args.blocks.find((b) => b.type === "actions").elements.some((e) => e.type === "conversations_select"), "still asks for a channel");

  const edit = revised.args.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "gather_draft_edit");
  await s.action("gather_draft_edit")({ ack: async () => {}, client: s.client, body: { user: { id: "U_TOM" }, channel: { id: "D_U_TOM" }, message: { ts: "x" }, trigger_id: "T" }, action: edit });
  const modal = s.take().find((c) => c.method === "views.open").args.view;
  assert.equal(modal.blocks[0].block_id, "channel", "the form asks where to post");

  await s.handlers.view.gather_create({
    ack: async () => {}, client: s.client, body: { user: { id: "U_TOM" } },
    view: { private_metadata: modal.private_metadata, state: { values: { ...modalValues({ title: "Party" }), channel: { v: { selected_conversation: "C0TOM" } } } } },
  });
  assert.ok(s.take().some((c) => c.method === "chat.postMessage" && c.args.channel === "C0TOM"));
});

test("preferences: picked up from feedback, used next time, and can be forgotten", async () => {
  const s = fakeSlack();
  // Stated while giving feedback on a draft: applied to the draft and remembered.
  await dmFrom(s, "U_NORA", "Plan a party next Friday in <#C0NORA|social>");
  s.take();
  await dmFrom(s, "U_NORA", "回复我用中文，但是 post 的信息用英文");
  const noted = s.take().find((c) => c.method === "chat.postMessage" && /记住/.test(c.args.text));
  assert.match(noted.args.text, /回复你用中文/);
  assert.match(noted.args.text, /发布的活动用英文/);
  assert.deepEqual(store.getUserPrefs("U_NORA"), { replyLanguage: "Chinese", postLanguage: "English", notes: [] });

  // Saying it again doesn't produce another note.
  await dmFrom(s, "U_NORA", "回复我用中文，但是 post 的信息用英文");
  assert.ok(!s.take().some((c) => /记住/.test(c.args.text || "")));

  // A usual channel, stated on its own, becomes the default for new drafts.
  await s.action("gather_draft_cancel")({ ack: async () => {}, client: s.client, body: { user: { id: "U_NORA" }, channel: { id: "D_U_NORA" }, message: { ts: "c" } }, action: { value: "x" } });
  s.take();
  await dmFrom(s, "U_NORA", "我一般都发到 <#C0USUAL|social>");
  const usual = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(usual.args.text, /默认发到 <#C0USUAL>/);
  await dmFrom(s, "U_NORA", "Plan a picnic next week");
  const preview = s.take().find((c) => c.method === "chat.postMessage");
  assert.match(JSON.stringify(preview.args.blocks), /C0USUAL/);
  assert.ok(preview.args.blocks.find((b) => b.type === "actions").elements.some((e) => e.action_id === "gather_draft_post"), "ready to post without asking for a channel");

  // Preferences are per person.
  assert.deepEqual(store.getUserPrefs("U_SOMEONE_ELSE"), {});

  await dmFrom(s, "U_NORA", "忘掉我的偏好");
  assert.match(s.take().find((c) => c.method === "chat.postMessage").args.text, /忘掉了/);
  assert.deepEqual(store.getUserPrefs("U_NORA"), {});
});

// ---------- channel replies, reminders, calendar, cancel ----------

test("channel: @Gather counts right away; an untagged answer gets a private 'count it?' prompt", async () => {
  const s = fakeSlack();
  const event = await newEvent(s, "C0CHAN");
  const say = (user, text, ts) => s.handlers.event.message({ client: s.client, context: { botUserId: "UBOT" }, event: { channel: "C0CHAN", ts, user, text } });

  await say("U0AMY", "<@UBOT> Wednesday after 7pm works, I'd love hot pot", "4000.1");
  let calls = s.take();
  assert.ok(calls.some((c) => c.method === "reactions.add" && c.args.timestamp === "4000.1"));
  assert.ok(store.getEvent(event.id).responses.some((r) => r.slackUserId === "U0AMY"));

  // A follow-up question for a tagged message goes in the thread under it, and answers there count.
  await say("U0BEN", "<@UBOT> I want pizza", "4000.2");
  const q = s.take().find((c) => c.method === "chat.postMessage");
  assert.equal(q.args.thread_ts, "4000.2");
  await s.handlers.event.message({ client: s.client, context: { botUserId: "UBOT" }, event: { channel: "C0CHAN", thread_ts: "4000.2", ts: "4000.3", user: "U0BEN", text: "Thursday after 7pm" } });
  assert.ok(store.getEvent(event.id).responses.some((r) => r.slackUserId === "U0BEN"));
  s.take();

  // Forgot the tag: only its author is asked.
  await say("U0CAT", "周三晚上7点以后可以", "4000.4");
  const prompt = s.take().find((c) => c.method === "chat.postEphemeral");
  assert.equal(prompt.args.user, "U0CAT");
  const yes = prompt.args.blocks.find((b) => b.type === "actions").elements[0];
  const responded = [];
  await s.action("gather_count_yes")({ ack: async () => {}, client: s.client, body: { user: { id: "U0CAT" } }, action: yes, respond: async (m) => responded.push(m) });
  assert.match(responded[0].text, /Counting that/);
  assert.ok(store.getEvent(event.id).responses.some((r) => r.slackUserId === "U0CAT"));
  s.take();

  // Saying no just removes the prompt; nothing is saved.
  await say("U0DAN", "Friday works for me", "4000.5");
  const prompt2 = s.take().find((c) => c.method === "chat.postEphemeral");
  const no = prompt2.args.blocks.find((b) => b.type === "actions").elements[1];
  const removed = [];
  await s.action("gather_count_no")({ ack: async () => {}, respond: async (m) => removed.push(m), action: no, body: { user: { id: "U0DAN" } }, client: s.client });
  assert.deepEqual(removed, [{ delete_original: true }]);
  assert.ok(!store.getEvent(event.id).responses.some((r) => r.slackUserId === "U0DAN"));

  // Everyday chat in the channel is left alone.
  await say("U0DAN", "Nice slides today, Sam!", "4000.6");
  assert.equal(s.take().length, 0);
});

test("reminders: DM only channel members who haven't replied, and their DM answer counts", async () => {
  const s = fakeSlack();
  s.client.conversations.members = async (args) => { s.take; return { members: ["U_ORG", "UBOT", "U0AMY", "U0BEN", "U0BOTX"] }; };
  const info = s.client.users.info;
  s.client.users.info = async ({ user }) => (user === "U0BOTX" ? { user: { id: user, is_bot: true } } : info({ user }));
  const event = await newEvent(s, "C0REM");
  await s.handlers.event.message({ client: s.client, event: { channel: "C0REM", thread_ts: event.slack.ts, ts: "5000.1", user: "U0AMY", text: "Wednesday after 7pm" } });
  s.take();

  const menu = (value) => ({ selected_option: { value } });
  await s.action("gather_more")({ ack: async () => {}, client: s.client, context: { botUserId: "UBOT" }, body: { user: { id: ORGANIZER } }, action: menu(`remind:${event.id}`) });
  let calls = s.take();
  const dms = calls.filter((c) => c.method === "chat.postMessage" && /^D/.test(c.args.channel));
  assert.deepEqual(dms.map((c) => c.args.channel), ["D_U0BEN"], "only the person who hasn't replied (not the organizer, bots, or Amy)");
  assert.match(calls.find((c) => c.method === "chat.postEphemeral").args.text, /Reminded <@U0BEN>/);

  // Ben answers in the DM: counted for this event.
  await dmFrom(s, "U0BEN", "Thursday after 7pm works");
  assert.ok(store.getEvent(event.id).responses.some((r) => r.slackUserId === "U0BEN"));
  s.take();

  // Reminding again right away doesn't spam anyone.
  await s.action("gather_more")({ ack: async () => {}, client: s.client, context: { botUserId: "UBOT" }, body: { user: { id: ORGANIZER } }, action: menu(`remind:${event.id}`) });
  calls = s.take();
  assert.ok(!calls.some((c) => c.method === "chat.postMessage"));
});

test("announcing adds calendar buttons; the organizer can cancel an event", async () => {
  const { calendarLinks } = await import("../lib/slack.js");
  const links = calendarLinks({ title: "Lab happy hour", timeZone: "America/New_York" }, { date: "2026-11-25", start: "20:00", end: "22:00" }, "Hot pot");
  const g = new URL(links.google);
  assert.equal(g.searchParams.get("dates"), "20261125T200000/20261125T220000");
  assert.equal(g.searchParams.get("ctz"), "America/New_York");
  assert.equal(new URL(links.outlook).searchParams.get("startdt"), "2026-11-25T20:00:00-05:00");

  const s = fakeSlack();
  const event = await newEvent(s, "C0CAN");
  await s.action("gather_more")({ ack: async () => {}, client: s.client, body: { user: { id: "U0AMY" } }, action: { selected_option: { value: `cancel:${event.id}` } } });
  assert.match(s.take()[0].args.text, /Only <@U_ORG>/);
  await s.action("gather_more")({ ack: async () => {}, client: s.client, body: { user: { id: ORGANIZER } }, action: { selected_option: { value: `cancel:${event.id}` } } });
  const confirm = s.take()[0].args.blocks.find((b) => b.type === "actions").elements[0];
  await s.action("gather_cancel_confirm")({ ack: async () => {}, client: s.client, body: { user: { id: ORGANIZER } }, action: confirm });
  const calls = s.take();
  assert.match(JSON.stringify(calls.find((c) => c.method === "chat.update").args.blocks), /Cancelled by the organizer/);
  assert.ok(store.getEvent(event.id).slack.cancelled);
  // No more replies once cancelled.
  await s.handlers.event.message({ client: s.client, event: { channel: "C0CAN", thread_ts: event.slack.ts, ts: "6000.1", user: "U0AMY", text: "Friday after 7pm" } });
  assert.equal(s.take().length, 0);
});

test("only messages that sound like an answer get the 'count it?' prompt", async () => {
  const { looksLikeReply } = await import("../lib/slack.js");
  for (const yes of ["Friday works for me", "周三晚上7点以后可以", "tomorrow evening works", "I'm free after 6pm", "这周末有空", "晚上可以"])
    assert.ok(looksLikeReply(yes), yes);
  for (const no of ["Nice slides today, Sam!", "Did anyone see the game tonight?", "lol", "Thanks everyone 🙏", "今天的讲座很有意思"])
    assert.ok(!looksLikeReply(no), no);
});
