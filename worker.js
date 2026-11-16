// Cloudflare Workers entry point for the web version. Pages and static files come from
// public/ (Workers static assets); /api/* runs the same handlers as the local server
// (lib/api.js), inside one Durable Object per event so replies to an event are handled
// one at a time and stored durably.
//
// Slack: any workspace can install Gather ("Add to Slack", /slack/install). Each workspace
// gets its own Workspace Durable Object holding its bot token, its events and its members'
// preferences, so organizations never see each other's data. Slack sends events, slash
// commands and button clicks to /slack/events; they run the same handlers as the local
// Socket Mode bot (lib/slack.js) through lib/slack-http.js.
import { DurableObject } from "cloudflare:workers";
import { handleApi, AI_ROUTES } from "./lib/api.js";
import { withBackend, newId } from "./lib/store.js";
import { registerSlackHandlers } from "./lib/slack.js";
import { createSlackApp, slackClient, verifySlackRequest, parseSlackBody, teamOf, installUrl, exchangeCode, signState, checkState } from "./lib/slack-http.js";

// Pretty URLs -> the page that renders them.
const PAGES = [
  [/^\/me\/?$/, "/mine"],
  [/^\/e\/[^/]+\/?$/, "/event"],
  [/^\/e\/[^/]+\/admin\/?$/, "/admin"],
  [/^\/e\/[^/]+\/me\/[^/]+\/?$/, "/me"],
];

// lib/llm.js reads its settings from process.env, as it does under Node.
function useEnv(env) {
  for (const key of ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_REASONING_EFFORT", "DEMO_MODE"]) {
    if (typeof env[key] === "string") process.env[key] = env[key];
  }
}

// One event, stored as a JSON row in this object's own SQLite database.
export class EventStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const events = {};
    const hasTable = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event'").toArray().length > 0;
    if (hasTable) for (const row of sql.exec("SELECT id, data FROM event")) events[row.id] = JSON.parse(row.data);
    this.backend = {
      db: { events },
      save(eventId) {
        const event = events[eventId];
        if (!event) return;
        sql.exec("CREATE TABLE IF NOT EXISTS event (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
        sql.exec("INSERT OR REPLACE INTO event (id, data) VALUES (?, ?)", eventId, JSON.stringify(event));
      },
    };
  }

  async api(request) {
    useEnv(this.env);
    return withBackend(this.backend, () => handleApi(request));
  }
}

// One Slack workspace: its installation, its events (ids "<teamId>.<id>") and its members'
// preferences, each a JSON row in this object's SQLite database.
export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = (this.sql = ctx.storage.sql);
    sql.exec("CREATE TABLE IF NOT EXISTS install (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS event (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.installation = sql.exec("SELECT data FROM install").toArray().map((r) => JSON.parse(r.data))[0] || null;
    const events = {};
    const users = {};
    for (const row of sql.exec("SELECT id, data FROM event")) events[row.id] = JSON.parse(row.data);
    for (const row of sql.exec("SELECT id, data FROM user")) users[row.id] = JSON.parse(row.data);
    this.backend = {
      db: { events, users },
      save(eventId) {
        if (eventId) {
          if (events[eventId]) sql.exec("INSERT OR REPLACE INTO event (id, data) VALUES (?, ?)", eventId, JSON.stringify(events[eventId]));
          return;
        }
        // Called without an id for per-person preferences.
        for (const [id, user] of Object.entries(users)) sql.exec("INSERT OR REPLACE INTO user (id, data) VALUES (?, ?)", id, JSON.stringify(user));
      },
      newEventId: () => `${this.installation?.teamId}.${newId()}`,
    };
    this.slack = createSlackApp();
    registerSlackHandlers(this.slack.app, { dashboardUrl: (event) => `${this.baseUrl}/e/${event.id}/admin?key=${event.adminKey}` });
    this.pending = new Map();
  }

  async install(installation) {
    this.sql.exec("INSERT OR REPLACE INTO install (id, data) VALUES (1, ?)", JSON.stringify(installation));
    this.installation = installation;
  }

  async uninstall() {
    this.sql.exec("DELETE FROM install");
    this.installation = null;
  }

  // Start handling one Slack request. Resolves with the response Slack needs right away
  // (within 3 seconds); the rest of the work finishes in finish(id).
  async begin(id, payload, baseUrl) {
    useEnv(this.env);
    if (!this.installation) return { error: "not_installed" };
    this.baseUrl = this.env.PUBLIC_URL || baseUrl;
    const client = slackClient(this.installation.botToken, { apiUrl: this.env.SLACK_API_URL || undefined });
    const context = { teamId: this.installation.teamId, botUserId: this.installation.botUserId };
    const { ack, done } = withBackend(this.backend, () => this.slack.dispatch(payload, { client, context }));
    this.pending.set(id, done);
    return { response: await ack };
  }

  async finish(id) {
    await this.pending.get(id);
    this.pending.delete(id);
  }

  // The web dashboard for this workspace's events (/e/<teamId>.<id>/admin).
  async api(request) {
    useEnv(this.env);
    return withBackend(this.backend, () => handleApi(request));
  }
}

const json = (body, status = 200) => Response.json(body, { status });

async function limited(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  for (const [limiter, key] of [[env.AI_RATE_LIMITER, ip], [env.AI_GLOBAL_RATE_LIMITER, "all"]]) {
    if (limiter && !(await limiter.limit({ key })).success) return true;
  }
  return false;
}

async function api(request, env, url) {
  useEnv(env);
  const { pathname: path } = url;
  if (request.method === "POST" && AI_ROUTES.test(path) && (await limited(env, request)))
    return json({ error: "Too many requests right now. Wait a minute and try again." }, 429);

  let body = {};
  if (request.method === "POST") {
    const text = await request.text();
    if (text.length > 100_000) return json({ error: "Request too large." }, 413);
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
  }
  const req = { method: request.method, path, query: Object.fromEntries(url.searchParams), body };

  // Creating an event: pick its id here so the request goes to that event's own object.
  if (request.method === "POST" && path === "/api/events") req.newEventId = newId();
  const eventId = req.newEventId || path.match(/^\/api\/events\/([^/]+)/)?.[1];

  // Slack events ("<teamId>.<id>") live in their workspace's object; web events in their own.
  const store = eventId?.includes(".") ? env.WORKSPACES.getByName(eventId.split(".")[0]) : eventId && env.EVENTS.getByName(eventId);
  const { status, body: out } = store
    ? await store.api(req)
    : await handleApi(req); // e.g. /api/status, which touches no event
  return json(out, status);
}

// ----- Slack -----

const page = (url, query) => Response.redirect(`${url.origin}/slack.html?${new URLSearchParams(query)}`, 302);
const slackReady = (env) => Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET);

async function slack(request, env, ctx, url) {
  if (!slackReady(env)) return new Response("Slack isn't set up for this deployment yet.", { status: 503 });
  const redirectUri = `${env.PUBLIC_URL || url.origin}/slack/oauth_redirect`;

  // "Add to Slack": send the visitor to Slack to approve the install.
  if (url.pathname === "/slack/install") {
    return Response.redirect(installUrl({ clientId: env.SLACK_CLIENT_ID, redirectUri, state: await signState(env.SLACK_CLIENT_SECRET) }), 302);
  }

  // Slack sends them back here with a one-time code; swap it for this workspace's token.
  if (url.pathname === "/slack/oauth_redirect") {
    if (url.searchParams.get("error")) return page(url, { cancelled: "1" });
    if (!(await checkState(env.SLACK_CLIENT_SECRET, url.searchParams.get("state")))) return page(url, { failed: "expired" });
    try {
      const installation = await exchangeCode({
        clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET, code: url.searchParams.get("code"), redirectUri,
        apiUrl: env.SLACK_API_URL || undefined,
      });
      await env.WORKSPACES.getByName(installation.teamId).install(installation);
      return page(url, { installed: installation.teamName || "your workspace", team: installation.teamId, app: installation.appId || "" });
    } catch (err) {
      console.error("Slack install failed:", err.data?.error || err.message);
      return page(url, { failed: err.data?.error || "error" });
    }
  }

  // Events, slash commands and button clicks.
  if (url.pathname === "/slack/events" && request.method === "POST") {
    const rawBody = await request.text();
    const verified = await verifySlackRequest({
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      rawBody,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    if (!verified) return new Response("Invalid signature", { status: 401 });
    const payload = parseSlackBody(rawBody, request.headers.get("content-type") || "");
    if (payload.type === "url_verification") return json({ challenge: payload.challenge });
    // Slack retries when it doesn't hear back in 3 seconds; the first delivery is already being handled.
    if (request.headers.get("x-slack-retry-num")) return new Response("");
    const teamId = teamOf(payload);
    if (!teamId || payload.event?.bot_id) return new Response("");
    const workspace = env.WORKSPACES.getByName(teamId);
    if (["app_uninstalled", "tokens_revoked"].includes(payload.event?.type)) {
      await workspace.uninstall();
      return new Response("");
    }
    // Every Slack request can lead to AI calls, so cap them per workspace.
    if (env.AI_GLOBAL_RATE_LIMITER && !(await env.AI_GLOBAL_RATE_LIMITER.limit({ key: `slack:${teamId}` })).success) return new Response("");
    const id = crypto.randomUUID();
    const { response, error } = await workspace.begin(id, payload, url.origin);
    if (error) {
      console.error(`Slack request for ${teamId}: ${error}`);
      return new Response("");
    }
    ctx.waitUntil(workspace.finish(id));
    return response ? json(response) : new Response("");
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/slack/")) {
      try {
        return await slack(request, env, ctx, url);
      } catch (err) {
        console.error("Slack error:", err);
        return new Response("Something went wrong.", { status: 500 });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (err) {
        console.error("API error:", err);
        return json({ error: "Something went wrong on the server. Try again." }, 500);
      }
    }
    for (const [pattern, page] of PAGES) {
      if (pattern.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL(page, url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
