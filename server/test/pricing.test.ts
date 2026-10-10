import { describe, expect, it, vi } from "vitest";
import type { Assistant, OfferMatch, WantedItem } from "../src/ai/index.js";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { bestPrice, focusOnPrices, HttpPriceWorker, startPriceCheck, summarise, type PriceWorker, type StoreResult } from "../src/pricing.js";

const offer = (price: number, memberPrice: number | null = null) => ({ name: "x", price, memberPrice, unitPrice: null, unitLabel: null, promo: null });

describe("focusOnPrices", () => {
  it("keeps the lines around prices and drops page furniture", () => {
    const page = ["Home", "Groceries", "Filters", "Sort by", "Avonmore Fresh Milk 2L", "€2.39", "€1.20/litre", "Add", "Footer", "Privacy"].join("\n");
    const out = focusOnPrices(page);
    expect(out).toContain("Avonmore Fresh Milk 2L");
    expect(out).toContain("€2.39");
    expect(out).not.toContain("Privacy");
  });

  it("returns nothing when the page has no prices (no results or a challenge page)", () => {
    expect(focusOnPrices("Please verify you are a human")).toBe("");
  });
});

describe("summarise", () => {
  it("compares stores only on items both have", () => {
    const item = (itemId: string, lineTotal: number | null) => ({ itemId, name: itemId, qty: 1, query: itemId, match: lineTotal ? offer(lineTotal) : null, confidence: "high" as const, lineTotal });
    const stores: StoreResult[] = [
      { id: "tesco", name: "Tesco", items: [item("milk", 2.4), item("bread", 3), item("caviar", 50)], total: 0, found: 0, missing: 0 },
      { id: "dunnes", name: "Dunnes Stores", items: [item("milk", 2.2), item("bread", 2.5), item("caviar", null)], total: 0, found: 0, missing: 0 },
    ];
    const r = summarise(stores, { done: 6, total: 6 });
    expect(r.stores[0]).toMatchObject({ total: 55.4, found: 3, missing: 0 });
    expect(r.stores[1]).toMatchObject({ total: 4.7, found: 2, missing: 1 });
    expect(r.comparison).toEqual({ items: 2, totals: { tesco: 5.4, dunnes: 4.7 }, cheapest: "dunnes", saving: 0.7 });
  });

  it("uses the loyalty price when it's lower", () => {
    expect(bestPrice(offer(3, 2.5))).toBe(2.5);
    expect(bestPrice(offer(3, null))).toBe(3);
  });
});

describe("HttpPriceWorker", () => {
  it("posts the store and query with the worker token", async () => {
    const fetchFn = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(JSON.stringify({ text: "page" })));
    const w = new HttpPriceWorker("http://worker:8788/", "secret", fetchFn as unknown as typeof fetch);
    expect(await w.searchPage("tesco", "milk")).toBe("page");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://worker:8788/search");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(init!.body as string)).toEqual({ store: "tesco", query: "milk" });
  });
});

function fakes() {
  const pages: Record<string, string> = {
    "tesco:Avonmore Whole milk 2 L": "Avonmore Fresh Milk 2L\n€2.39\nClubcard Price €2.10",
    "dunnes:Avonmore Whole milk 2 L": "Avonmore Fresh Milk 2L\n€2.29",
    "tesco:Sourdough": "Tesco Finest Sourdough 400g\n€3.00",
    "dunnes:Sourdough": "No results for Sourdough",
  };
  const worker: PriceWorker = { searchPage: vi.fn(async (store, q) => pages[`${store}:${q}`] ?? "") };
  const prices: Record<string, OfferMatch> = {
    "Tesco:Whole milk": { match: offer(2.39, 2.1), confidence: "high" },
    "Dunnes Stores:Whole milk": { match: offer(2.29), confidence: "high" },
    "Tesco:Sourdough": { match: offer(3), confidence: "medium" },
  };
  const matchOffer = vi.fn(async (item: WantedItem, store: string) => prices[`${store}:${item.name}`] ?? { match: null, confidence: "high" as const });
  const assistant: Assistant = { name: "fake", identifyPhoto: vi.fn(), parseText: vi.fn(), matchOffer, classify: vi.fn() };
  return { worker, assistant, matchOffer };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("price check", () => {
  function seeded() {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u', 'Sam', 0)").run();
    const add = db.prepare("INSERT INTO items (id, list_id, name, brand, size, qty, section_id, done, created_at, updated_at) VALUES (?, 'household', ?, ?, ?, ?, 'x', ?, ?, 0)");
    add.run("milk", "Whole milk", "Avonmore", "2 L", 2, 0, 1);
    add.run("bread", "Sourdough", null, null, 1, 0, 2);
    add.run("ticked", "Already got", null, null, 1, 1, 3);
    return db;
  }

  it("checks every unticked item at every store, then caches the results", async () => {
    const db = seeded();
    const { worker, assistant, matchOffer } = fakes();
    const { id } = startPriceCheck({ db, assistant, worker }, "household", "u");
    const status = () => (db.prepare("SELECT status FROM price_checks WHERE id = ?").get(id) as { status: string }).status;
    await until(() => status() !== "running");
    expect(status()).toBe("done");

    const result = JSON.parse((db.prepare("SELECT result FROM price_checks WHERE id = ?").get(id) as { result: string }).result);
    expect(result.progress).toEqual({ done: 4, total: 4 });
    const [tesco, dunnes] = result.stores;
    expect(tesco.items.map((i: { lineTotal: number }) => i.lineTotal)).toEqual([4.2, 3]); // 2 × Clubcard €2.10
    expect(dunnes.items.map((i: { lineTotal: number | null }) => i.lineTotal)).toEqual([4.58, null]);
    expect(result.comparison).toEqual({ items: 1, totals: { tesco: 4.2, dunnes: 4.58 }, cheapest: "tesco", saving: 0.38 });
    // "No results" page had no prices, so the AI wasn't asked about it.
    expect(matchOffer).toHaveBeenCalledTimes(3);

    const second = startPriceCheck({ db, assistant, worker }, "household", "u");
    await until(() => (db.prepare("SELECT status FROM price_checks WHERE id = ?").get(second.id) as { status: string }).status !== "running");
    expect(worker.searchPage).toHaveBeenCalledTimes(4);
  });

  it("records a failing store page against that item and carries on", async () => {
    const db = seeded();
    const { assistant } = fakes();
    const worker: PriceWorker = { searchPage: vi.fn(async () => { throw new Error("timed out"); }) };
    const { id } = startPriceCheck({ db, assistant, worker }, "household", "u");
    await until(() => (db.prepare("SELECT status FROM price_checks WHERE id = ?").get(id) as { status: string }).status !== "running");
    const result = JSON.parse((db.prepare("SELECT result FROM price_checks WHERE id = ?").get(id) as { result: string }).result);
    expect(result.stores[0].items[0].error).toBe("timed out");
  });

  it("is reachable over the API, off unless configured, and private lists stay private", async () => {
    const db = openDb(":memory:");
    const { worker, assistant } = fakes();
    const signUp = async (app: ReturnType<typeof createApp>, name: string) =>
      (await (await app.request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json()).token as string;

    const off = createApp({ db, assistant });
    const t0 = await signUp(off, "Sam");
    const res0 = await off.request("/api/lists/household/price-check", { method: "POST", headers: { authorization: `Bearer ${t0}` } });
    expect(res0.status).toBe(503);
    expect((await (await off.request("/api/health")).json()).priceCheck).toBe(false);

    const app = createApp({ db, assistant, priceWorker: worker });
    const alex = await signUp(app, "Alex");
    const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
    await app.request("/api/sync", { method: "POST", headers: auth(t0), body: JSON.stringify({ ops: [{ type: "list.upsert", at: 1, list: { id: "gifts", name: "Gifts", private: true } }] }) });
    expect((await app.request("/api/lists/gifts/price-check", { method: "POST", headers: auth(alex) })).status).toBe(404);

    const started = await (await app.request("/api/lists/household/price-check", { method: "POST", headers: auth(alex) })).json();
    expect((await (await app.request(`/api/price-checks/${started.id}`, { headers: auth(t0) })).json()).check.listId).toBe("household");
    expect((await (await app.request("/api/lists/household/price-check", { headers: auth(alex) })).json()).check.id).toBe(started.id);
  });
});
