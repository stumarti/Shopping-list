import { serve } from "@hono/node-server";
import { createWorkerApp } from "./app.js";
import { PlaywrightFetcher } from "./browser.js";
import { PoliteQueue } from "./limiter.js";
import { searchUrls } from "./stores.js";

const fetcher = new PlaywrightFetcher(searchUrls(), process.env.PROFILE_DIR || "./data/profiles");
const queue = new PoliteQueue(Number(process.env.STORE_GAP_MS || 4000));
const app = createWorkerApp({ fetcher, queue, token: process.env.WORKER_TOKEN || undefined });
const port = Number(process.env.PORT || 8788);

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`price worker listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await fetcher.close();
    process.exit(0);
  });
}
