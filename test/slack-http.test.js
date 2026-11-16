import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifySlackRequest, parseSlackBody, teamOf, createSlackApp, slackClient, signState, checkState, installUrl } from "../lib/slack-http.js";

const sign = (secret, ts, body) => `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

test("verifies Slack's request signature and rejects stale or forged ones", async () => {
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const rawBody = "token=x&command=%2Fgather";
  const signature = sign("s3cret", ts, rawBody);
  assert.equal(await verifySlackRequest({ timestamp: ts, signature, rawBody, signingSecret: "s3cret", now }), true);
  assert.equal(await verifySlackRequest({ timestamp: ts, signature, rawBody: rawBody + "x", signingSecret: "s3cret", now }), false);
  assert.equal(await verifySlackRequest({ timestamp: ts, signature, rawBody, signingSecret: "other", now }), false);
  assert.equal(await verifySlackRequest({ timestamp: ts, signature, rawBody, signingSecret: "s3cret", now: now + 10 * 60 * 1000 }), false);
});

test("parses events, commands and interactions", () => {
  assert.equal(parseSlackBody('{"type":"event_callback","team_id":"T1"}', "application/json").team_id, "T1");
  const command = parseSlackBody("command=%2Fgather&team_id=T2&text=party", "application/x-www-form-urlencoded");
  assert.equal(command.command, "/gather");
  assert.equal(teamOf(command), "T2");
  const action = parseSlackBody(`payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T3" } }))}`, "application/x-www-form-urlencoded");
  assert.equal(teamOf(action), "T3");
});

test("dispatch acks early while the handler keeps working", async () => {
  const { app, dispatch } = createSlackApp();
  let finished = false;
  let release;
  app.view("gather_create", async ({ ack, view }) => {
    await ack({ response_action: "errors", errors: { title: view.id } });
    await new Promise((r) => (release = r));
    finished = true;
  });
  const { ack, done } = dispatch({ type: "view_submission", view: { callback_id: "gather_create", id: "V1" } }, { client: {} });
  assert.deepEqual(await ack, { response_action: "errors", errors: { title: "V1" } });
  assert.equal(finished, false, "the response doesn't wait for the rest of the work");
  release();
  await done;
  assert.equal(finished, true);
});

test("dispatch routes actions by id or pattern, and events by type", async () => {
  const { app, dispatch } = createSlackApp();
  const seen = [];
  app.action(/^gather_announce_\d+$/, async ({ ack, action }) => { await ack(); seen.push(action.value); });
  app.event("message", async ({ event }) => seen.push(event.text));
  await dispatch({ type: "block_actions", actions: [{ action_id: "gather_announce_1", value: "e:1" }] }, { client: {} }).done;
  const ev = dispatch({ type: "event_callback", event: { type: "message", text: "hi" } }, { client: {} });
  assert.equal(await ev.ack, null);
  await ev.done;
  assert.deepEqual(seen, ["e:1", "hi"]);
  // Nothing registered: still a 200, never a hang.
  assert.equal(await dispatch({ type: "block_actions", actions: [{ action_id: "nope" }] }, { client: {} }).ack, null);
});

test("a handler that throws before acking still gets Slack a response", async () => {
  const { app, dispatch } = createSlackApp();
  app.command("/gather", async () => { throw new Error("boom"); });
  const { ack } = dispatch({ command: "/gather" }, { client: {} });
  assert.equal(await ack, null);
});

test("the API client form-encodes arguments and surfaces Slack errors like Bolt", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return { json: async () => (url.endsWith("chat.postMessage") ? { ok: true, ts: "1.0" } : { ok: false, error: "not_in_channel" }) };
  };
  const client = slackClient("xoxb-test", { fetchImpl });
  const res = await client.chat.postMessage({ channel: "C1", text: "hi", blocks: [{ type: "divider" }] });
  assert.equal(res.ts, "1.0");
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].init.headers.authorization, "Bearer xoxb-test");
  assert.equal(calls[0].form.blocks, '[{"type":"divider"}]');
  await assert.rejects(client.conversations.join({ channel: "C1" }), (err) => err.data.error === "not_in_channel");
});

test("OAuth state is signed and expires", async () => {
  const now = Date.now();
  const state = await signState("s3cret", now);
  assert.equal(await checkState("s3cret", state, now + 60_000), true);
  assert.equal(await checkState("other", state, now), false);
  assert.equal(await checkState("s3cret", state, now + 20 * 60_000), false);
  const url = new URL(installUrl({ clientId: "123.456", redirectUri: "https://x.dev/slack/oauth_redirect", state }));
  assert.equal(url.searchParams.get("client_id"), "123.456");
  assert.match(url.searchParams.get("scope"), /im:write/);
});
