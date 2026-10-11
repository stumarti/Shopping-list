import { serve } from "@hono/node-server";
import { createWorkerApp } from "./app.js";
import { PlaywrightFetcher } from "./browser.js";
import { PoliteQueue } from "./limiter.js";
import { Ordering } from "./ordering.js";
import { RemoteView } from "./remote.js";
import { SessionManager } from "./sessions.js";
import { storeAdapters } from "./stores/index.js";
import { searchUrls } from "./stores/search-urls.js";

const sessions = new SessionManager(process.env.PROFILE_DIR || "./data/profiles");
const app = createWorkerApp({
  fetcher: new PlaywrightFetcher(searchUrls(), sessions),
  queue: new PoliteQueue(Number(process.env.STORE_GAP_MS || 4000)),
  ordering: new Ordering(sessions, storeAdapters()),
  remote: new RemoteView(sessions),
  token: process.env.WORKER_TOKEN || undefined,
});
const port = Number(process.env.PORT || 8788);

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`store worker listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await sessions.close();
    process.exit(0);
  });
}
