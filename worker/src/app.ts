import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { PageFetcher } from "./browser.js";
import type { PoliteQueue } from "./limiter.js";

export interface WorkerDeps {
  fetcher: PageFetcher;
  queue: PoliteQueue;
  /** Shared with the server as WORKER_TOKEN. Unset = no auth (only OK on a private Docker network). */
  token?: string;
}

const SearchBody = z.object({ store: z.enum(["tesco", "dunnes"]), query: z.string().min(1).max(200) });

export function createWorkerApp({ fetcher, queue, token }: WorkerDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/search", async (c, next) => {
    if (!token) return next();
    const given = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.post("/search", async (c) => {
    const parsed = SearchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "expected {store: tesco|dunnes, query}" }, 400);
    const { store, query } = parsed.data;
    try {
      const page = await queue.run(store, () => fetcher.search(store, query));
      return c.json(page);
    } catch (err) {
      console.error(`search failed: ${store} "${query}"`, err);
      return c.json({ error: `Couldn't load ${store}: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}` }, 502);
    }
  });

  return app;
}
