// Slack over HTTP, for Cloudflare Workers (no Bolt, no long-running process).
// - verifySlackRequest / parseSlackBody: check the signature and read what Slack sent.
// - createSlackApp: a small Bolt-compatible registry (command / view / action / event) so the
//   handlers in slack.js run unchanged. dispatch() returns { ack, done }: `ack` resolves with
//   the HTTP response Slack needs within 3 seconds; `done` when the handler has finished.
// - slackClient: a fetch-based Web API client shaped like Bolt's (client.chat.postMessage(...)).
// - installUrl / exchangeCode / signState / checkState: the "Add to Slack" OAuth flow.

// Scopes the bot asks for when a workspace installs it. Keep in sync with slack-manifest.yml.
export const BOT_SCOPES = [
  "commands", "chat:write", "channels:join", "channels:history", "groups:history",
  "im:history", "im:write", "users:read", "reactions:write", "channels:read", "groups:read",
];

const encoder = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// https://api.slack.com/authentication/verifying-requests-from-slack
export async function verifySlackRequest({ timestamp, signature, rawBody, signingSecret, now = Date.now() }) {
  if (!timestamp || !signature || !signingSecret) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false; // replayed or stale
  const expected = `v0=${await hmacHex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  return safeEqual(expected, signature);
}

// Events arrive as JSON; slash commands and interactions as form posts (interactions put
// their JSON in a `payload` field).
export function parseSlackBody(rawBody, contentType = "") {
  if (contentType.includes("application/json")) return JSON.parse(rawBody);
  const form = Object.fromEntries(new URLSearchParams(rawBody));
  return form.payload ? JSON.parse(form.payload) : form;
}

export function teamOf(payload) {
  return payload.team_id || payload.team?.id || payload.user?.team_id || payload.view?.team_id || null;
}

export function createSlackApp() {
  const handlers = { command: [], view: [], action: [], event: [] };
  const matches = (key, value) => (key instanceof RegExp ? key.test(value) : key === value);
  const register = (kind) => (key, fn) => handlers[kind].push({ key, fn });
  const app = { command: register("command"), view: register("view"), action: register("action"), event: register("event") };

  function dispatch(payload, { client, context = {}, fetchImpl = fetch }) {
    let resolveAck;
    const ack = new Promise((resolve) => (resolveAck = resolve));
    const ackFn = async (response) => resolveAck(response ?? null);
    // Like Bolt's respond(): update or delete the message an interaction came from
    // (including ephemeral ones) through its response_url.
    const respond = async (message) => {
      if (!payload.response_url) return;
      const body = typeof message === "string" ? { text: message } : message;
      await fetchImpl(payload.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    };
    const base = { client, context, body: payload, respond };
    let run = null;

    if (payload.type === "event_callback") {
      resolveAck(null); // events only need a 200
      const event = payload.event;
      run = Promise.all(handlers.event.filter((h) => matches(h.key, event.type)).map((h) => h.fn({ ...base, event })));
    } else if (payload.command) {
      const h = handlers.command.find((x) => matches(x.key, payload.command));
      if (h) run = h.fn({ ...base, ack: ackFn, command: payload });
    } else if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const h = action && handlers.action.find((x) => matches(x.key, action.action_id));
      if (h) run = h.fn({ ...base, ack: ackFn, action });
    } else if (payload.type === "view_submission") {
      const h = handlers.view.find((x) => matches(x.key, payload.view?.callback_id));
      if (h) run = h.fn({ ...base, ack: ackFn, view: payload.view });
    }

    const done = Promise.resolve(run)
      .catch((err) => console.error("Slack handler failed:", err?.data?.error || err))
      .finally(() => resolveAck(null)); // a handler that never acks still gets a 200
    return { ack, done };
  }

  return { app, dispatch };
}

// Web API client: client.chat.postMessage({...}) -> POST https://slack.com/api/chat.postMessage.
// Arguments are form-encoded (objects such as blocks or view as JSON strings), which every
// Web API method accepts. Errors throw with err.data.error, like Bolt's client.
export function slackClient(token, { apiUrl = "https://slack.com/api/", fetchImpl = fetch } = {}) {
  async function call(method, args = {}) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const res = await fetchImpl(`${apiUrl}${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
    if (!data.ok) {
      const err = new Error(`An API error occurred: ${data.error}`);
      err.data = data;
      throw err;
    }
    return data;
  }
  const namespace = (ns) => new Proxy({}, { get: (_, method) => (args) => call(`${ns}.${String(method)}`, args) });
  return new Proxy({ call }, { get: (target, ns) => (ns in target ? target[ns] : namespace(String(ns))) });
}

// ----- "Add to Slack" (OAuth v2) -----

// The state parameter proves the redirect came from an install we started (no storage needed).
export async function signState(secret, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  return `${ts}.${await hmacHex(secret, `state:${ts}`)}`;
}

export async function checkState(secret, state, now = Date.now()) {
  const [ts, sig] = String(state || "").split(".");
  if (!ts || !sig || Math.abs(now / 1000 - Number(ts)) > 10 * 60) return false;
  return safeEqual(await hmacHex(secret, `state:${ts}`), sig);
}

export function installUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

// Swap the code Slack gives us for the workspace's bot token.
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, apiUrl, fetchImpl }) {
  const res =await slackClient(null, { apiUrl, fetchImpl }).call("oauth.v2.access", {
    client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
  });
  return {
    teamId: res.team?.id,
    teamName: res.team?.name,
    botToken: res.access_token,
    botUserId: res.bot_user_id,
    appId: res.app_id,
    installedBy: res.authed_user?.id,
    scopes: res.scope,
    installedAt: new Date().toISOString(),
  };
}
