import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { NotUnderstoodError, parseTextLocally, type Assistant } from "./claude.js";
import type { DB } from "./db.js";
import { lookupBarcode, rememberProduct, type FetchFn } from "./products.js";
import { categorize } from "./sections.js";
import { applyOps, getState, OpSchema } from "./sync.js";

export interface AppDeps {
  db: DB;
  /** Shared secret both phones send as a Bearer token. Unset = no auth (local dev only). */
  token?: string;
  assistant?: Assistant;
  fetchFn?: FetchFn;
}

const BARCODE = /^\d{6,14}$/;

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ db, token, assistant, fetchFn = fetch }: AppDeps) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, claude: Boolean(assistant) }));

  app.use("/api/*", async (c, next) => {
    if (!token) return next();
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokenMatches(given, token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  const sections = () => getState(db).sections;

  app.get("/api/state", (c) => c.json(getState(db)));

  app.post("/api/sync", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const parsed = z.object({ ops: z.array(OpSchema).max(2000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid ops", detail: parsed.error.issues.slice(0, 5) }, 400);
    applyOps(db, parsed.data.ops);
    return c.json(getState(db));
  });

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

  const IdentifyBody = z.object({
    image: z.string().min(100),
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
  });

  app.post("/api/identify", bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    if (!assistant) return c.json({ error: "Photo identification needs ANTHROPIC_API_KEY on the server" }, 503);
    const parsed = IdentifyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid image" }, 400);
    try {
      const result = await assistant.identifyPhoto(parsed.data.image, parsed.data.mediaType, sections());
      return c.json(result);
    } catch (err) {
      if (err instanceof NotUnderstoodError) return c.json({ error: "Couldn't recognise that. Try a closer photo of the label." }, 422);
      console.error("identify failed", err);
      return c.json({ error: "identification unavailable" }, 502);
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
    const parsed = RememberBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid product" }, 400);
    rememberProduct(db, { barcode: code, ...parsed.data, source: "photo" });
    return c.json({ ok: true });
  });

  app.post("/api/parse", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(await c.req.json().catch(() => null));
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
