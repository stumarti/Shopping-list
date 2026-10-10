import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authenticate, createInvite, createUser, issueToken, listPeople, redeemInvite, revokeToken, revokeUser, type User } from "./auth.js";
import { NotUnderstoodError, parseTextLocally, type AiBackend, type Assistant } from "./ai/index.js";
import type { DB } from "./db.js";
import { changeLine, fillBasket, getOrder, latestOrder, startOrder, WorkerError, type StoreWorker } from "./ordering.js";
import { getPriceCheck, latestPriceCheck, startPriceCheck, STORES, type PriceWorker } from "./pricing.js";
import { lookupBarcode, rememberProduct, type FetchFn } from "./products.js";
import { categorize } from "./sections.js";
import { applyOps, finishTrip, getState, OpSchema, startTrip, suggestions, tripHistory, visibleListIds } from "./sync.js";

export interface AppDeps {
  db: DB;
  /** Setup secret from .env: lets a new phone create a person without an invite. Unset = open setup (local dev only). */
  setupToken?: string;
  assistant?: Assistant;
  aiBackend?: AiBackend;
  /** Playwright worker that loads store search pages; unset = price checks off. */
  priceWorker?: PriceWorker;
  /** Same worker, signed-in side: linking store accounts and filling baskets. */
  storeWorker?: StoreWorker;
  fetchFn?: FetchFn;
}

export const VERSION = "0.3.0";

const BARCODE = /^\d{6,14}$/;

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7).trim() : "");
const json = async (req: { json(): Promise<unknown> }) => req.json().catch(() => null);

type Env = { Variables: { user: User; token: string } };

export function createApp({ db, setupToken, assistant, aiBackend, priceWorker, storeWorker, fetchFn = fetch }: AppDeps) {
  const app = new Hono<Env>();

  // ---- Public: health, first-time setup, joining with an invite ----

  // Also used by the app's Settings screen to show what this server can do.
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      ai: assistant ? { backend: aiBackend ?? "custom", name: assistant.name } : null,
      priceCheck: Boolean(priceWorker && assistant),
      onlineOrdering: Boolean(storeWorker),
      stores: STORES,
      // Kept for older app versions.
      claude: Boolean(assistant),
    }),
  );

  const Device = z.string().max(60).nullish();

  app.post("/api/setup", async (c) => {
    const parsed = z.object({ setupToken: z.string().default(""), name: z.string().min(1).max(40), device: Device }).safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "Enter your name." }, 400);
    if (setupToken && !secretMatches(parsed.data.setupToken, setupToken)) return c.json({ error: "That setup token doesn't match the server's APP_TOKEN." }, 401);
    const user = createUser(db, parsed.data.name);
    return c.json({ user, token: issueToken(db, user.id, parsed.data.device ?? null) });
  });

  app.post("/api/join", async (c) => {
    const parsed = z.object({ code: z.string().min(10).max(100), name: z.string().max(40).optional(), device: Device }).safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "Invalid invite." }, 400);
    const result = redeemInvite(db, parsed.data.code, parsed.data.name, parsed.data.device ?? null);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ user: result.user, token: result.token });
  });

  // ---- Everything else needs a personal token ----

  app.use("/api/*", async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    const user = authenticate(db, token);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    c.set("token", token);
    return next();
  });

  const canSeeList = (userId: string, listId: string) => visibleListIds(db, userId).includes(listId);

  app.get("/api/me", (c) => {
    const me = c.get("user");
    return c.json({ user: me, people: listPeople(db).map((p) => ({ ...p, isMe: p.id === me.id })) });
  });

  app.patch("/api/me", async (c) => {
    const parsed = z.object({ name: z.string().min(1).max(40) }).safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "Enter a name." }, 400);
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(parsed.data.name.trim(), c.get("user").id);
    return c.json({ ok: true });
  });

  app.post("/api/invites", async (c) => {
    const parsed = z.object({ forMe: z.boolean().default(false) }).safeParse((await json(c.req)) ?? {});
    const forMe = parsed.success && parsed.data.forMe;
    const me = c.get("user");
    return c.json(createInvite(db, me.id, forMe ? me.id : null));
  });

  /** Sign this device out. */
  app.post("/api/logout", (c) => {
    revokeToken(db, c.get("token"));
    return c.json({ ok: true });
  });

  /** Sign out every device of a person, e.g. a lost phone. Household members trust each other. */
  app.post("/api/people/:id/revoke", (c) => {
    const n = revokeUser(db, c.req.param("id"));
    return c.json({ ok: true, revoked: n });
  });

  app.get("/api/state", (c) => c.json(getState(db, c.get("user").id)));

  app.post("/api/sync", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const parsed = z.object({ ops: z.array(OpSchema).max(2000) }).safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "invalid ops", detail: parsed.error.issues.slice(0, 5) }, 400);
    const userId = c.get("user").id;
    applyOps(db, userId, parsed.data.ops);
    return c.json(getState(db, userId));
  });

  // ---- Shopping trips, history and "usual items" ----

  app.post("/api/trips", async (c) => {
    const parsed = z.object({ listId: z.string() }).safeParse(await json(c.req));
    const userId = c.get("user").id;
    if (!parsed.success || !canSeeList(userId, parsed.data.listId)) return c.json({ error: "unknown list" }, 404);
    return c.json(startTrip(db, userId, parsed.data.listId));
  });

  app.post("/api/trips/:id/finish", (c) => {
    const summary = finishTrip(db, c.get("user").id, c.req.param("id"));
    return summary ? c.json(summary) : c.json({ error: "unknown trip" }, 404);
  });

  app.get("/api/lists/:id/history", (c) => {
    const listId = c.req.param("id");
    if (!canSeeList(c.get("user").id, listId)) return c.json({ error: "unknown list" }, 404);
    return c.json({ trips: tripHistory(db, c.get("user").id, listId) });
  });

  app.get("/api/lists/:id/suggestions", (c) => {
    const listId = c.req.param("id");
    if (!canSeeList(c.get("user").id, listId)) return c.json({ error: "unknown list" }, 404);
    return c.json({ suggestions: suggestions(db, listId) });
  });

  // ---- Price comparison (read-only) ----

  app.post("/api/lists/:id/price-check", (c) => {
    const listId = c.req.param("id");
    const userId = c.get("user").id;
    if (!canSeeList(userId, listId)) return c.json({ error: "unknown list" }, 404);
    if (!priceWorker || !assistant) return c.json({ error: "Price checks aren't set up on the server (needs the worker container and an AI backend)." }, 503);
    const started = startPriceCheck({ db, assistant, worker: priceWorker }, listId, userId);
    return c.json(started, started.alreadyRunning ? 200 : 202);
  });

  app.get("/api/lists/:id/price-check", (c) => {
    const listId = c.req.param("id");
    if (!canSeeList(c.get("user").id, listId)) return c.json({ error: "unknown list" }, 404);
    return c.json({ check: latestPriceCheck(db, listId) });
  });

  app.get("/api/price-checks/:id", (c) => {
    const check = getPriceCheck(db, c.req.param("id"));
    if (!check || !canSeeList(c.get("user").id, check.listId)) return c.json({ error: "unknown price check" }, 404);
    return c.json({ check });
  });

  // ---- Online ordering: link a store account, check the slot, match items, fill the basket ----

  const workerError = (c: { json: (b: unknown, s?: number) => Response }, err: unknown) => {
    if (err instanceof WorkerError) return c.json({ error: err.message, notReady: err.notReady }, err.notReady ? 501 : 502);
    console.error("store worker failed", err);
    return c.json({ error: "The store worker isn't responding." }, 502);
  };
  const noWorker = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "Online ordering isn't set up on the server (needs the worker container)." }, 503);
  const Store = z.string().regex(/^[a-z]{1,20}$/);

  async function onlineStore(id: string) {
    return (await storeWorker!.stores()).find((s) => s.id === id) ?? null;
  }

  app.get("/api/online/stores", async (c) => {
    if (!storeWorker) return noWorker(c);
    try {
      return c.json({ stores: await storeWorker.stores() });
    } catch (err) {
      return workerError(c, err);
    }
  });

  /** Is this person's account linked, and which slot have they booked? */
  app.get("/api/online/:store/status", async (c) => {
    if (!storeWorker) return noWorker(c);
    const store = Store.safeParse(c.req.param("store"));
    if (!store.success) return c.json({ error: "unknown store" }, 404);
    try {
      return c.json(await storeWorker.slot(c.get("user").id, store.data));
    } catch (err) {
      return workerError(c, err);
    }
  });

  app.post("/api/online/:store/link", async (c) => {
    if (!storeWorker) return noWorker(c);
    const store = Store.safeParse(c.req.param("store"));
    if (!store.success) return c.json({ error: "unknown store" }, 404);
    try {
      return c.json({ view: await storeWorker.openAccount(c.get("user").id, store.data) });
    } catch (err) {
      return workerError(c, err);
    }
  });

  app.get("/api/online/:store/link/screenshot", async (c) => {
    if (!storeWorker) return noWorker(c);
    const store = Store.safeParse(c.req.param("store"));
    if (!store.success) return c.json({ error: "unknown store" }, 404);
    try {
      const jpeg = await storeWorker.screenshot(c.get("user").id, store.data);
      return c.body(new Uint8Array(jpeg), 200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    } catch (err) {
      return workerError(c, err);
    }
  });

  const RemoteInputSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("click"), x: z.number().min(0).max(2000), y: z.number().min(0).max(4000) }),
    z.object({ type: z.literal("type"), text: z.string().max(500) }),
    z.object({ type: z.literal("key"), key: z.enum(["Enter", "Tab", "Backspace", "Escape"]) }),
    z.object({ type: z.literal("scroll"), dy: z.number().min(-5000).max(5000) }),
    z.object({ type: z.literal("back") }),
  ]);

  app.post("/api/online/:store/link/input", async (c) => {
    if (!storeWorker) return noWorker(c);
    const store = Store.safeParse(c.req.param("store"));
    const event = RemoteInputSchema.safeParse(await json(c.req));
    if (!store.success || !event.success) return c.json({ error: "bad request" }, 400);
    try {
      await storeWorker.input(c.get("user").id, store.data, event.data);
      return c.json({ ok: true });
    } catch (err) {
      return workerError(c, err);
    }
  });

  app.post("/api/online/:store/link/done", async (c) => {
    if (!storeWorker) return noWorker(c);
    const store = Store.safeParse(c.req.param("store"));
    if (!store.success) return c.json({ error: "unknown store" }, 404);
    try {
      await storeWorker.closeAccount(c.get("user").id, store.data);
      return c.json(await storeWorker.slot(c.get("user").id, store.data));
    } catch (err) {
      return workerError(c, err);
    }
  });

  const deps = () => ({ db, worker: storeWorker!, assistant });

  app.post("/api/orders", async (c) => {
    if (!storeWorker) return noWorker(c);
    const parsed = z.object({ listId: z.string(), store: Store }).safeParse(await json(c.req));
    const userId = c.get("user").id;
    if (!parsed.success || !canSeeList(userId, parsed.data.listId)) return c.json({ error: "unknown list" }, 404);
    try {
      const store = await onlineStore(parsed.data.store);
      if (!store) return c.json({ error: "unknown store" }, 404);
      const started = await startOrder(deps(), userId, parsed.data.listId, store);
      return started.ok ? c.json({ id: started.id }, 202) : c.json({ error: started.message, code: started.code }, 409);
    } catch (err) {
      return workerError(c, err);
    }
  });

  app.get("/api/orders", (c) => {
    const listId = c.req.query("listId") ?? "";
    const userId = c.get("user").id;
    if (!canSeeList(userId, listId)) return c.json({ error: "unknown list" }, 404);
    return c.json({ order: latestOrder(db, userId, listId) });
  });

  // Orders are personal: each one fills the basket of the person who started it.
  app.get("/api/orders/:id", (c) => {
    const order = getOrder(db, c.req.param("id"), c.get("user").id);
    return order ? c.json({ order }) : c.json({ error: "unknown order" }, 404);
  });

  const LineChangeSchema = z.union([
    z.object({ choose: z.string().min(1).max(500) }),
    z.object({ skip: z.literal(true) }),
    z.object({ qty: z.number().int().min(1).max(99) }),
    z.object({ search: z.string().min(1).max(200) }),
  ]);

  app.patch("/api/orders/:id/lines/:itemId", async (c) => {
    if (!storeWorker) return noWorker(c);
    const change = LineChangeSchema.safeParse(await json(c.req));
    if (!change.success) return c.json({ error: "bad request" }, 400);
    const order = await changeLine(deps(), c.get("user").id, c.req.param("id"), c.req.param("itemId"), change.data);
    return order ? c.json({ order }) : c.json({ error: "Can't change that item now." }, 409);
  });

  app.post("/api/orders/:id/fill", (c) => {
    if (!storeWorker) return noWorker(c);
    const result = fillBasket(deps(), c.get("user").id, c.req.param("id"));
    return result.ok ? c.json({ ok: true }, 202) : c.json({ error: result.message }, 409);
  });

  // ---- Adding items: barcodes, photos, typed text ----

  const sections = () => db.prepare("SELECT id, name, color FROM sections ORDER BY position, id").all() as Array<{ id: string; name: string; color: string }>;

  app.get("/api/barcode/:code", async (c) => {
    const code = c.req.param("code");
    if (!BARCODE.test(code)) return c.json({ error: "invalid barcode" }, 400);
    try {
      const product = await lookupBarcode(db, code, fetchFn);
      return product ? c.json({ found: true, product }) : c.json({ found: false });
    } catch (err) {
      console.error("barcode lookup failed", err);
      return c.json({ error: "lookup unavailable" }, 502);
    }
  });

  const RememberBody = z.object({
    name: z.string().min(1).max(200),
    brand: z.string().max(100).nullable(),
    size: z.string().max(50).nullable(),
    sectionId: z.string().min(1).max(64),
  });

  // "Remember this barcode next time": stores what the photo identified against the barcode.
  app.put("/api/barcode/:code", async (c) => {
    const code = c.req.param("code");
    if (!BARCODE.test(code)) return c.json({ error: "invalid barcode" }, 400);
    const parsed = RememberBody.safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "invalid product" }, 400);
    rememberProduct(db, { barcode: code, ...parsed.data, source: "photo" });
    return c.json({ ok: true });
  });

  const IdentifyBody = z.object({
    image: z.string().min(100),
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
  });

  app.post("/api/identify", bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    if (!assistant) return c.json({ error: "Photo identification needs ANTHROPIC_API_KEY on the server" }, 503);
    const parsed = IdentifyBody.safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "invalid image" }, 400);
    try {
      return c.json(await assistant.identifyPhoto(parsed.data.image, parsed.data.mediaType, sections()));
    } catch (err) {
      if (err instanceof NotUnderstoodError) return c.json({ error: "Couldn't recognise that. Try a closer photo of the label." }, 422);
      console.error("identify failed", err);
      return c.json({ error: "identification unavailable" }, 502);
    }
  });

  app.post("/api/parse", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(await json(c.req));
    if (!parsed.success) return c.json({ error: "invalid text" }, 400);
    const text = parsed.data.text;
    // A single plain item doesn't need a model call.
    if (!assistant || !/[,\n;]|\d/.test(text)) {
      return c.json({ items: parseTextLocally(text), via: "local" });
    }
    try {
      return c.json({ items: await assistant.parseText(text, sections()), via: "claude" });
    } catch (err) {
      console.error("parse failed, falling back to local", err);
      return c.json({ items: parseTextLocally(text), via: "local" });
    }
  });

  app.get("/api/categorize", (c) => c.json({ sectionId: categorize(c.req.query("name") ?? "") }));

  return app;
}
