import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ClaudeAssistant } from "./claude.js";
import { openDb } from "./db.js";

const dbFile = process.env.DB_FILE || "./data/shopping.db";
mkdirSync(dirname(dbFile), { recursive: true });

const token = process.env.APP_TOKEN || undefined;
if (!token) console.warn("APP_TOKEN is not set: the API is open to anyone who can reach it. Fine for local dev only.");

const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
if (!hasClaude) console.warn("ANTHROPIC_API_KEY is not set: photo identification is off, text entry uses simple parsing.");

const app = createApp({ db: openDb(dbFile), token, assistant: hasClaude ? new ClaudeAssistant() : undefined });
const port = Number(process.env.PORT || 8787);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`shopping-list server listening on :${port}`);
});
