import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { NotUnderstoodError, parseTextLocally, type Assistant } from "../src/claude.js";
import { openDb } from "../src/db.js";
import { categorize, sectionFromOffTags } from "../src/sections.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function setup(extra: { assistant?: Assistant; fetchFn?: typeof fetch } = {}) {
  const db = openDb(":memory:");
  const app = createApp({ db, token: TOKEN, ...extra });
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
  const sync = async (ops: unknown[]) => (await call("/api/sync", { method: "POST", body: JSON.stringify({ ops }) })).json();
  return { db, app, call, sync };
}

const milk = { id: "i1", name: "Whole milk", sectionId: "dairy", brand: "Avonmore", size: "2 L" };

describe("auth", () => {
  it("rejects missing or wrong tokens but leaves health open", async () => {
    const { app } = setup();
    expect((await app.request("/api/state")).status).toBe(401);
    expect((await app.request("/api/state", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request("/api/health")).status).toBe(200);
  });
});

describe("sync", () => {
  it("seeds default sections in supermarket order", async () => {
    const { call } = setup();
    const state = await (await call("/api/state")).json();
    expect(state.sections[0].id).toBe("produce");
    expect(state.sections.map((s: { id: string }) => s.id)).toContain("frozen");
  });

  it("adds, ticks and deletes items", async () => {
    const { sync } = setup();
    let state = await sync([{ type: "item.upsert", at: 1, item: milk }]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ name: "Whole milk", qty: 1, done: false, source: "text" });

    state = await sync([{ type: "item.upsert", at: 2, item: { ...milk, done: true } }]);
    expect(state.items[0].done).toBe(true);

    state = await sync([{ type: "item.delete", at: 3, id: "i1" }]);
    expect(state.items).toHaveLength(0);
  });

  it("keeps the newest write when phones sync out of order", async () => {
    const { sync } = setup();
    await sync([{ type: "item.upsert", at: 10, item: { ...milk, qty: 3 } }]);
    const state = await sync([{ type: "item.upsert", at: 5, item: { ...milk, qty: 1 } }]);
    expect(state.items[0].qty).toBe(3);
  });

  it("does not resurrect an item deleted after a stale edit", async () => {
    const { sync } = setup();
    await sync([{ type: "item.upsert", at: 1, item: milk }, { type: "item.delete", at: 5, id: "i1" }]);
    const state = await sync([{ type: "item.upsert", at: 3, item: { ...milk, done: true } }]);
    expect(state.items).toHaveLength(0);
  });

  it("clears ticked items only", async () => {
    const { sync } = setup();
    const state = await sync([
      { type: "item.upsert", at: 1, item: { ...milk, done: true } },
      { type: "item.upsert", at: 1, item: { id: "i2", name: "Bread", sectionId: "bakery" } },
      { type: "items.clearDone", at: 2 },
    ]);
    expect(state.items.map((i: { id: string }) => i.id)).toEqual(["i2"]);
  });

  it("reorders sections", async () => {
    const { sync } = setup();
    const state = await sync([{ type: "sections.reorder", at: 1, order: ["frozen", "produce"] }]);
    expect(state.sections.slice(0, 2).map((s: { id: string }) => s.id)).toEqual(["frozen", "produce"]);
  });

  it("rejects malformed ops", async () => {
    const { call } = setup();
    const res = await call("/api/sync", { method: "POST", body: JSON.stringify({ ops: [{ type: "item.upsert", at: 1, item: { id: "x" } }] }) });
    expect(res.status).toBe(400);
  });
});

describe("barcode lookup", () => {
  const offResponse = {
    status: 1,
    product: { product_name: "Whole Milk", brands: "Avonmore, Glanbia", quantity: "2 L", categories_tags: ["en:dairies", "en:milks"] },
  };

  it("maps Open Food Facts results and caches them", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(offResponse)));
    const { call } = setup({ fetchFn: fetchFn as unknown as typeof fetch });
    const body = await (await call("/api/barcode/5391508150011")).json();
    expect(body).toEqual({
      found: true,
      product: { barcode: "5391508150011", name: "Whole Milk", brand: "Avonmore", size: "2 L", sectionId: "dairy", source: "openfoodfacts" },
    });
    await call("/api/barcode/5391508150011");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports unknown barcodes, then remembers one identified by photo", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 0 })));
    const { call } = setup({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(await (await call("/api/barcode/12345678")).json()).toEqual({ found: false });

    const put = await call("/api/barcode/12345678", {
      method: "PUT",
      body: JSON.stringify({ name: "Oat drink", brand: "Alpro", size: "1 L", sectionId: "dairy" }),
    });
    expect(put.status).toBe(200);
    const body = await (await call("/api/barcode/12345678")).json();
    expect(body.product).toMatchObject({ name: "Oat drink", source: "photo" });
  });

  it("rejects non-numeric barcodes", async () => {
    const { call } = setup();
    expect((await call("/api/barcode/abc")).status).toBe(400);
  });
});

describe("photo identification", () => {
  const fake = (impl: Assistant["identifyPhoto"]): Assistant => ({ identifyPhoto: impl, parseText: async () => [] });
  const image = "A".repeat(200);

  it("returns 503 when no API key is configured", async () => {
    const { call } = setup();
    expect((await call("/api/identify", { method: "POST", body: JSON.stringify({ image }) })).status).toBe(503);
  });

  it("passes the photo and current sections to Claude", async () => {
    const identify = vi.fn(async () => ({ name: "Oat drink", brand: "Alpro", size: "1 L", sectionId: "dairy", confidence: "high" as const }));
    const { call } = setup({ assistant: fake(identify) });
    const res = await call("/api/identify", { method: "POST", body: JSON.stringify({ image }) });
    expect(await res.json()).toMatchObject({ name: "Oat drink", sectionId: "dairy" });
    const [, mediaType, sections] = identify.mock.calls[0] as unknown as [string, string, Array<{ id: string }>];
    expect(mediaType).toBe("image/jpeg");
    expect(sections.length).toBeGreaterThan(5);
  });

  it("returns 422 when Claude can't tell what it is", async () => {
    const { call } = setup({ assistant: fake(async () => { throw new NotUnderstoodError("no"); }) });
    expect((await call("/api/identify", { method: "POST", body: JSON.stringify({ image }) })).status).toBe(422);
  });
});

describe("text entry", () => {
  it("splits lists locally without an API key", async () => {
    const { call } = setup();
    const body = await (await call("/api/parse", { method: "POST", body: JSON.stringify({ text: "2 bananas, sourdough\nfrozen peas" }) })).json();
    expect(body.via).toBe("local");
    expect(body.items).toEqual([
      { name: "Bananas", qty: 2, brand: null, size: null, sectionId: "produce" },
      { name: "Sourdough", qty: 1, brand: null, size: null, sectionId: "bakery" },
      { name: "Frozen peas", qty: 1, brand: null, size: null, sectionId: "frozen" },
    ]);
  });

  it("uses Claude for multi-item text and falls back if it fails", async () => {
    const parseText = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([
      { name: "Milk", qty: 1, brand: null, size: "2 L", sectionId: "dairy" },
    ]);
    const { call } = setup({ assistant: { identifyPhoto: vi.fn(), parseText } });
    const first = await (await call("/api/parse", { method: "POST", body: JSON.stringify({ text: "2L milk, bread" }) })).json();
    expect(first.via).toBe("local");
    const second = await (await call("/api/parse", { method: "POST", body: JSON.stringify({ text: "2L milk" }) })).json();
    expect(second).toMatchObject({ via: "claude", items: [{ name: "Milk", size: "2 L" }] });
  });
});

describe("categorize", () => {
  it.each([
    ["Frozen peas", "frozen"],
    ["Ice cream", "frozen"],
    ["Oat drink", "dairy"],
    ["Toilet roll", "household"],
    ["Chicken thighs", "meat"],
    ["Free-range eggs", "dairy"],
    ["Watermelon", "produce"],
    ["Mystery thing", "other"],
  ])("%s → %s", (name, section) => {
    expect(categorize(name)).toBe(section);
  });

  it("maps Open Food Facts tags with frozen taking priority", () => {
    expect(sectionFromOffTags(["en:dairies", "en:frozen-foods"])).toBe("frozen");
    expect(sectionFromOffTags(["en:snacks"])).toBe("cupboard");
    expect(sectionFromOffTags([])).toBeNull();
  });
});

describe("parseTextLocally", () => {
  it("handles '3x' quantities", () => {
    expect(parseTextLocally("3x yoghurt")[0]).toMatchObject({ name: "Yoghurt", qty: 3, sectionId: "dairy" });
  });
});
