import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createAssistant } from "./ai/index.js";
import { createApp } from "./app.js";
import { HOUSEHOLD_LIST, openDb } from "./db.js";
import { watchInbox } from "./inbox.js";
import { HttpStoreWorker } from "./ordering.js";
import { runAutoPlan } from "./planning.js";
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

const db = openDb(dbFile);
const app = createApp({ db, setupToken, assistant, aiBackend: backend, priceWorker, storeWorker });

// Keep lists with "top up automatically" switched on topped up.
setInterval(() => {
  for (const r of runAutoPlan(db)) if (r.added.length) console.log(`weekly plan added ${r.added.length} items to ${r.listId}`);
}, 60 * 60 * 1000);

// Bulk import of old receipts dropped into a folder.
if (process.env.RECEIPTS_INBOX) {
  if (!assistant) console.warn("RECEIPTS_INBOX is set but no AI is configured, so receipts can't be read.");
  else {
    const who = process.env.RECEIPTS_USER;
    watchInbox({
      db,
      assistant,
      dir: process.env.RECEIPTS_INBOX,
      listId: process.env.RECEIPTS_LIST || HOUSEHOLD_LIST,
      sections: () => db.prepare("SELECT id, name, color FROM sections ORDER BY position").all() as Array<{ id: string; name: string; color: string }>,
      userId: () =>
        ((who
          ? db.prepare("SELECT id FROM users WHERE name = ? ORDER BY created_at LIMIT 1").get(who)
          : db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get()) as { id: string } | undefined)?.id ?? null,
    });
    console.log(`Watching ${process.env.RECEIPTS_INBOX} for receipts`);
  }
}
const port = Number(process.env.PORT || 8787);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`shopping-list server listening on :${port}`);
});
