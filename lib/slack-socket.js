// Local Slack bot (npm start): runs the handlers from slack.js with Bolt in Socket Mode, so
// no public URL is needed. Single workspace, using SLACK_BOT_TOKEN / SLACK_APP_TOKEN from .env.
// On Cloudflare the same handlers run over HTTP instead (lib/slack-http.js, worker.js).
import bolt from "@slack/bolt";
import { registerSlackHandlers } from "./slack.js";

const { App, LogLevel } = bolt;

export async function startSlack({ dashboardUrl } = {}) {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
    // Without this, a bad token rejects inside the constructor and crashes the whole server.
    deferInitialization: true,
  });
  await app.init();
  registerSlackHandlers(app, { dashboardUrl });
  await app.start();
  return app;
}
