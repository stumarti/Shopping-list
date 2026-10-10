import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createAssistant } from "./ai/index.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { HttpStoreWorker } from "./ordering.js";
import { HttpPriceWorker } from "./pricing.js";

const dbFile = process.env.DB_FILE || "./data/shopping.db";
mkdirSync(dirname(dbFile), { recursive: true });

const setupToken = process.env.APP_TOKEN || undefined;
if (!setupToken) console.warn("APP_TOKEN is not set: anyone who can reach the server can create an account. Fine for local dev only.");

const { backend, assistant } = createAssistant();
console.log(assistant ? `AI: ${assistant.name}` : "AI: none (photo identification off, typed lists use simple parsing)");

const priceWorker = process.env.WORKER_URL ? new HttpPriceWorker(process.env.WORKER_URL, process.env.WORKER_TOKEN) : undefined;
if (priceWorker && !assistant) console.warn("WORKER_URL is set but no AI is configured: price checks need one to read store pages.");

const storeWorker = process.env.WORKER_URL ? new HttpStoreWorker(process.env.WORKER_URL, process.env.WORKER_TOKEN) : undefined;

const app = createApp({ db: openDb(dbFile), setupToken, assistant, aiBackend: backend, priceWorker, storeWorker });
const port = Number(process.env.PORT || 8787);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`shopping-list server listening on :${port}`);
});
