import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { PageFetcher } from "./browser.js";
import type { PoliteQueue } from "./limiter.js";
import type { Ordering } from "./ordering.js";
import type { RemoteView } from "./remote.js";
import { NotReadyError } from "./stores/index.js";

export interface WorkerDeps {
  fetcher: PageFetcher;
  queue: PoliteQueue;
  ordering?: Ordering;
  remote?: Pick<RemoteView, "open" | "screenshot" | "input" | "close">;
  /** Shared with the server as WORKER_TOKEN. Unset = no auth (only OK on a private Docker network). */
  token?: string;
}

const SearchBody = z.object({ store: z.enum(["tesco", "dunnes"]), query: z.string().min(1).max(200) });
// `owner` is the person's id, supplied by the server after it has checked their login.
const Owner = { owner: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), store: z.string().regex(/^[a-z]{1,20}$/) };
const CandidateSchema = z.object({
  ref: z.string().min(1).max(500),
  name: z.string(),
  price: z.number().nullable(),
  memberPrice: z.number().nullable(),
  size: z.string().nullable(),
  available: z.boolean(),
});
const InputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().min(0).max(2000), y: z.number().min(0).max(4000) }),
  z.object({ type: z.literal("type"), text: z.string().max(500) }),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Tab", "Backspace", "Escape"]) }),
  z.object({ type: z.literal("scroll"), dy: z.number().min(-5000).max(5000) }),
  z.object({ type: z.literal("back") }),
]);

const message = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : "unknown error");

export function createWorkerApp({ fetcher, queue, ordering, remote, token }: WorkerDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (!token || c.req.path === "/health") return next();
    const given = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  const body = async <T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T) => schema.safeParse(await c.req.json().catch(() => null));

  // ---- Read-only price checks ----

  app.post("/search", async (c) => {
    const parsed = await body(c, SearchBody);
    if (!parsed.success) return c.json({ error: "expected {store: tesco|dunnes, query}" }, 400);
    const { store, query } = parsed.data;
    try {
      return c.json(await queue.run(store, () => fetcher.search(store, query)));
    } catch (err) {
      console.error(`search failed: ${store} "${query}"`, err);
      return c.json({ error: `Couldn't load ${store}: ${message(err)}` }, 502);
    }
  });

  if (!ordering || !remote) return app;

  // ---- Linking a store account (live view of the browser) ----

  app.get("/stores", (c) =>
    c.json({
      stores: [...["tesco", "dunnes", "test"]].flatMap((id) => {
        try {
          const a = ordering.adapter(id);
          return [{ id: a.id, name: a.name, ordering: a.ordering, basketUrl: a.basketUrl }];
        } catch {
          return [];
        }
      }),
    }),
  );

  app.post("/account/open", async (c) => {
    const parsed = await body(c, z.object(Owner));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    try {
      const a = ordering.adapter(parsed.data.store);
      return c.json({ view: await remote.open(parsed.data.owner, a.id, a.signInUrl) });
    } catch (err) {
      return c.json({ error: message(err) }, 502);
    }
  });

  app.get("/account/screenshot", async (c) => {
    const parsed = z.object(Owner).safeParse({ owner: c.req.query("owner"), store: c.req.query("store") });
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    try {
      const jpeg = await remote.screenshot(parsed.data.owner, parsed.data.store);
      return c.body(new Uint8Array(jpeg), 200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    } catch (err) {
      return c.json({ error: message(err) }, 409);
    }
  });

  app.post("/account/input", async (c) => {
    const parsed = await body(c, z.object({ ...Owner, event: InputSchema }));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    try {
      await remote.input(parsed.data.owner, parsed.data.store, parsed.data.event);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: message(err) }, 409);
    }
  });

  app.post("/account/close", async (c) => {
    const parsed = await body(c, z.object(Owner));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    await remote.close(parsed.data.owner, parsed.data.store);
    return c.json({ ok: true });
  });

  // ---- Ordering: slot, search, fill the basket ----

  const run = async <T>(store: string, job: () => Promise<T>, c: { json: (b: unknown, s?: number) => Response }) => {
    try {
      return c.json(await queue.run(store, job));
    } catch (err) {
      return c.json({ error: message(err), notReady: err instanceof NotReadyError }, err instanceof NotReadyError ? 501 : 502);
    }
  };

  app.post("/order/slot", async (c) => {
    const parsed = await body(c, z.object(Owner));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { owner, store } = parsed.data;
    return run(store, () => ordering.slot(owner, store), c);
  });

  app.post("/order/search", async (c) => {
    const parsed = await body(c, z.object({ ...Owner, query: z.string().min(1).max(200) }));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { owner, store, query } = parsed.data;
    return run(store, async () => ({ candidates: await ordering.search(owner, store, query) }), c);
  });

  app.post("/order/add", async (c) => {
    const parsed = await body(c, z.object({ ...Owner, items: z.array(z.object({ candidate: CandidateSchema, qty: z.number().int().min(1).max(99) })).max(300) }));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { owner, store, items } = parsed.data;
    return run(store, async () => ({ results: await ordering.add(owner, store, items) }), c);
  });

  return app;
}
