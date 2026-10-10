import { describe, expect, it, vi } from "vitest";
import { NotUnderstoodError, parseTextLocally, type Assistant } from "../src/claude.js";
import { categorize, sectionFromOffTags } from "../src/sections.js";
import { setup as base } from "./helpers.js";

// Most tests only need one signed-in person.
async function setup(extra: Parameters<typeof base>[0] = {}) {
  const env = base(extra);
  const me = await env.register("Sam");
  return { ...env, call: me.call };
}

describe("barcode lookup", () => {
  const offResponse = {
    status: 1,
    product: { product_name: "Whole Milk", brands: "Avonmore, Glanbia", quantity: "2 L", categories_tags: ["en:dairies", "en:milks"] },
  };

  it("maps Open Food Facts results and caches them", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(offResponse)));
    const { call } = await setup({ fetchFn: fetchFn as unknown as typeof fetch });
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
    const { call } = await setup({ fetchFn: fetchFn as unknown as typeof fetch });
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
    const { call } = await setup();
    expect((await call("/api/barcode/abc")).status).toBe(400);
  });
});

describe("photo identification", () => {
  const fake = (impl: Assistant["identifyPhoto"]): Assistant => ({ identifyPhoto: impl, parseText: async () => [] });
  const image = "A".repeat(200);

  it("returns 503 when no API key is configured", async () => {
    const { call } = await setup();
    expect((await call("/api/identify", { method: "POST", body: JSON.stringify({ image }) })).status).toBe(503);
  });

  it("passes the photo and current sections to Claude", async () => {
    const identify = vi.fn(async () => ({ name: "Oat drink", brand: "Alpro", size: "1 L", sectionId: "dairy", confidence: "high" as const }));
    const { call } = await setup({ assistant: fake(identify) });
    const res = await call("/api/identify", { method: "POST", body: JSON.stringify({ image }) });
    expect(await res.json()).toMatchObject({ name: "Oat drink", sectionId: "dairy" });
    const [, mediaType, sections] = identify.mock.calls[0] as unknown as [string, string, Array<{ id: string }>];
    expect(mediaType).toBe("image/jpeg");
    expect(sections.length).toBeGreaterThan(5);
  });

  it("returns 422 when Claude can't tell what it is", async () => {
    const { call } = await setup({ assistant: fake(async () => { throw new NotUnderstoodError("no"); }) });
    expect((await call("/api/identify", { method: "POST", body: JSON.stringify({ image }) })).status).toBe(422);
  });
});

describe("text entry", () => {
  it("splits lists locally without an API key", async () => {
    const { call } = await setup();
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
    const { call } = await setup({ assistant: { identifyPhoto: vi.fn(), parseText } });
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
