import express from "express";
import path from "node:path";
import { handleApi } from "./lib/api.js";
import { isDemoMode, modelName } from "./lib/llm.js";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.resolve("public"), { index: false }));

const page = (name) => (req, res) => res.sendFile(path.resolve("public", name));
app.get("/", page("index.html"));
app.get("/e/:id", page("event.html"));
app.get("/e/:id/admin", page("admin.html"));
app.get("/e/:id/me/:token", page("me.html"));
app.get("/me", page("mine.html"));

// The API itself lives in lib/api.js, shared with the Cloudflare Worker (worker.js).
app.use("/api", async (req, res) => {
  const { status, body } = await handleApi({ method: req.method, path: req.baseUrl + req.path, query: req.query, body: req.body });
  res.status(status).json(body);
});

const port = Number(process.env.PORT) || 3000;
const baseUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");

app.listen(port, async (err) => {
  // Express 5 calls this callback with the error too (e.g. port already in use).
  if (err) {
    console.error(`Could not start on port ${port}: ${err.code === "EADDRINUSE" ? "the port is already in use (is another Gather server still running?)" : err.message}`);
    process.exit(1);
  }
  console.log(`Gather running at ${baseUrl} ${isDemoMode() ? "(DEMO MODE: no OPENAI_API_KEY)" : `(model: ${modelName()})`}`);

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    try {
      const { startSlack } = await import("./lib/slack-socket.js");
      await startSlack({ dashboardUrl: (event) => `${baseUrl}/e/${event.id}/admin?key=${event.adminKey}` });
      console.log("Slack bot connected (Socket Mode). Use /gather in a channel.");
    } catch (e) {
      console.error(`Slack bot failed to start: ${e.data?.error || e.message}`);
    }
  } else {
    console.log("Slack bot off (set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env to turn it on).");
  }
});
