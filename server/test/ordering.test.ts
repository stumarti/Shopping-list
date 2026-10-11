import { describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/ai/index.js";
import { ruleMatch, type Candidate, type StoreWorker } from "../src/ordering.js";
import { setup } from "./helpers.js";

const c = (ref: string, name: string, size: string | null, available = true, price = 2): Candidate => ({ ref, name, size, price, memberPrice: null, available });

const CATALOG: Record<string, Candidate[]> = {
  "Avonmore Whole milk 2 L": [c("p1", "Avonmore Fresh Whole Milk 2L", "2 L"), c("p2", "Avonmore Fresh Whole Milk 1L", "1 L"), c("p3", "Store Brand Whole Milk 2L", "2 L")],
  Sourdough: [c("p5", "Store Brand Sourdough Loaf 400g", "400 g"), c("p4", "Brennans White Bread 800g", "800 g")],
  "Alpro Oat drink 1 L": [c("p7", "Alpro Oat Drink 1L", "1 L", false), c("p8", "Oatly Oat Drink Barista 1L", "1 L")],
  "Unicorn tears": [],
  "Oat milk": [c("p8", "Oatly Oat Drink Barista 1L", "1 L")],
};

function fakeWorker(over: Partial<StoreWorker> = {}): StoreWorker & { added: unknown[] } {
  const added: unknown[] = [];
  return {
    added,
    stores: async () => [
      { id: "test", name: "Test Store", ordering: true, basketUrl: "http://store/basket" },
      { id: "tesco", name: "Tesco", ordering: false, basketUrl: "x" },
    ],
    slot: async () => ({ signedIn: true, slot: { kind: "collect", label: "Sat 14:00–15:00" } }),
    search: async (_o, _s, q) => CATALOG[q] ?? [],
    add: async (_o, _s, items) => {
      added.push(...items);
      return items.map((i) => (i.candidate.ref === "p5" ? { ref: i.candidate.ref, ok: false, error: "Out of stock" } : { ref: i.candidate.ref, ok: true }));
    },
    openAccount: async () => ({ width: 390, height: 720 }),
    screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    input: async () => {},
    closeAccount: async () => {},
    ...over,
  };
}

describe("ruleMatch", () => {
  it("finds the exact product by brand, name and size", () => {
    const r = ruleMatch({ name: "Whole milk", brand: "Avonmore", size: "2 L" }, CATALOG["Avonmore Whole milk 2 L"]);
    expect(r.exact).toBe(0);
    expect(r.similar[0]).toBe(1);
  });

  it("never calls an out-of-stock product exact", () => {
    const r = ruleMatch({ name: "Oat drink", brand: "Alpro", size: "1 L" }, CATALOG["Alpro Oat drink 1 L"]);
    expect(r.exact).toBeNull();
    expect(r.similar).toEqual([1]);
  });

  it("treats '2L' and '2 L' as the same size", () => {
    expect(ruleMatch({ name: "milk", brand: null, size: "2l" }, [c("x", "Milk 2 L", null)]).exact).toBe(0);
  });
});

async function env(worker = fakeWorker(), assistant?: Assistant) {
  const e = setup({ assistant });
  const { createApp } = await import("../src/app.js");
  const app = createApp({ db: e.db, setupToken: "setup-secret", storeWorker: worker, assistant });
  const signUp = async (name: string) => {
    const res = await app.request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: "setup-secret", name }) });
    const { token } = await res.json();
    const call = (path: string, method = "GET", body?: unknown) =>
      app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return call;
  };
  const sam = await signUp("Sam");
  await sam("/api/sync", "POST", {
    ops: [
      { type: "item.upsert", at: 1, item: { id: "milk", name: "Whole milk", brand: "Avonmore", size: "2 L", qty: 2, sectionId: "dairy" } },
      { type: "item.upsert", at: 2, item: { id: "bread", name: "Sourdough", sectionId: "bakery" } },
      { type: "item.upsert", at: 3, item: { id: "oat", name: "Oat drink", brand: "Alpro", size: "1 L", sectionId: "dairy" } },
      { type: "item.upsert", at: 4, item: { id: "odd", name: "Unicorn tears", sectionId: "other" } },
      { type: "item.upsert", at: 5, item: { id: "got", name: "Already got", sectionId: "other", done: true } },
    ],
  });
  return { app, sam, signUp, worker, db: e.db };
}

const settle = async (call: (p: string) => Promise<Response> | Response, id: string, from: string) => {
  for (let i = 0; i < 100; i++) {
    const { order } = await (await call(`/api/orders/${id}`)).json();
    if (order.status !== from) return order;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("order didn't settle");
};

describe("starting an order", () => {
  it("needs a linked account and a booked slot, and a store that's ready", async () => {
    const notLinked = await env(fakeWorker({ slot: async () => ({ signedIn: false, slot: null }) }));
    let res = await notLinked.sam("/api/orders", "POST", { listId: "household", store: "test" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_linked");

    const noSlot = await env(fakeWorker({ slot: async () => ({ signedIn: true, slot: null }) }));
    res = await noSlot.sam("/api/orders", "POST", { listId: "household", store: "test" });
    expect(await res.json()).toMatchObject({ code: "no_slot", error: expect.stringContaining("Book a delivery or click & collect slot") });

    const { sam } = await env();
    expect((await (await sam("/api/orders", "POST", { listId: "household", store: "tesco" })).json()).code).toBe("not_ready");
  });

  it("matches each unticked item: exact, choose a substitute, or not found", async () => {
    const { sam } = await env();
    const { id } = await (await sam("/api/orders", "POST", { listId: "household", store: "test" })).json();
    const order = await settle(sam, id, "matching");
    expect(order.status).toBe("review");
    expect(order.slot).toEqual({ kind: "collect", label: "Sat 14:00–15:00" });
    const byId = Object.fromEntries(order.lines.map((l: { itemId: string }) => [l.itemId, l]));
    expect(Object.keys(byId)).toEqual(["milk", "bread", "oat", "odd"]);
    expect(byId.milk).toMatchObject({ status: "exact", qty: 2, chosen: { ref: "p1" } });
    expect(byId.oat).toMatchObject({ status: "choose", chosen: null, options: [{ ref: "p8" }] });
    expect(byId.odd).toMatchObject({ status: "not_found", options: [] });
  });

  it("asks the AI only when word matching finds no exact product", async () => {
    const classify = vi.fn(async () => ({ exact: 0, similar: [1] }));
    const assistant: Assistant = { name: "fake", identifyPhoto: vi.fn(), parseText: vi.fn(), matchOffer: vi.fn(), classify, readReceipt: vi.fn() };
    const { sam } = await env(fakeWorker(), assistant);
    const { id } = await (await sam("/api/orders", "POST", { listId: "household", store: "test" })).json();
    const order = await settle(sam, id, "matching");
    // milk matched by rules; bread and oat went to the AI; "unicorn tears" had no results.
    expect(classify).toHaveBeenCalledTimes(2);
    const bread = order.lines.find((l: { itemId: string }) => l.itemId === "bread");
    expect(bread).toMatchObject({ status: "exact", chosen: { ref: "p5" } });
    // The AI said the out-of-stock Alpro was exact; that's overruled.
    expect(order.lines.find((l: { itemId: string }) => l.itemId === "oat").status).toBe("choose");
  });
});

describe("reviewing and filling the basket", () => {
  it("won't fill until every item is decided, then adds them and reports failures", async () => {
    const { sam, worker } = await env();
    const { id } = await (await sam("/api/orders", "POST", { listId: "household", store: "test" })).json();
    await settle(sam, id, "matching");

    let res = await sam(`/api/orders/${id}/fill`, "POST");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Choose or skip 1 item first.");

    // Pick the substitute for the oat drink, search again for the odd one, change a quantity.
    await sam(`/api/orders/${id}/lines/oat`, "PATCH", { choose: "p8" });
    let { order } = await (await sam(`/api/orders/${id}/lines/odd`, "PATCH", { search: "Oat milk" })).json();
    // A free-text search offers what it found to choose from.
    expect(order.lines.find((l: { itemId: string }) => l.itemId === "odd")).toMatchObject({ status: "choose", options: [{ ref: "p8" }] });
    await sam(`/api/orders/${id}/lines/odd`, "PATCH", { skip: true });
    await sam(`/api/orders/${id}/lines/milk`, "PATCH", { qty: 3 });
    expect((await sam(`/api/orders/${id}/lines/milk`, "PATCH", { choose: "nope" })).status).toBe(409);

    res = await sam(`/api/orders/${id}/fill`, "POST");
    expect(res.status).toBe(202);
    order = await settle(sam, id, "filling");
    expect(order.status).toBe("done");
    expect(worker.added).toEqual([
      { candidate: expect.objectContaining({ ref: "p1" }), qty: 3 },
      { candidate: expect.objectContaining({ ref: "p5" }), qty: 1 },
      { candidate: expect.objectContaining({ ref: "p8" }), qty: 1 },
    ]);
    const status = Object.fromEntries(order.lines.map((l: { itemId: string; status: string }) => [l.itemId, l.status]));
    expect(status).toEqual({ milk: "added", bread: "failed", oat: "added", odd: "skipped" });
    expect(order.lines.find((l: { itemId: string }) => l.itemId === "bread").error).toBe("Out of stock");
    expect(order.basketUrl).toBe("http://store/basket");
  });

  it("keeps orders personal", async () => {
    const { sam, signUp } = await env();
    const { id } = await (await sam("/api/orders", "POST", { listId: "household", store: "test" })).json();
    const alex = await signUp("Alex");
    expect((await alex(`/api/orders/${id}`)).status).toBe(404);
    expect((await alex(`/api/orders/${id}/fill`, "POST")).status).toBe(409);
    expect((await (await alex("/api/orders?listId=household")).json()).order).toBeNull();
    expect((await (await sam("/api/orders?listId=household")).json()).order.id).toBe(id);
  });
});

describe("linking an account", () => {
  it("proxies the live view and passes the signed-in person's id, never one from the request", async () => {
    const openAccount = vi.fn(async () => ({ width: 390, height: 720 }));
    const input = vi.fn(async () => {});
    const { sam, db } = await env(fakeWorker({ openAccount, input }));
    const samId = (db.prepare("SELECT id FROM users WHERE name = 'Sam'").get() as { id: string }).id;

    expect(await (await sam("/api/online/test/link", "POST", { owner: "someone-else" })).json()).toEqual({ view: { width: 390, height: 720 } });
    expect(openAccount).toHaveBeenCalledWith(samId, "test");
    const shot = await sam("/api/online/test/link/screenshot");
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    await sam("/api/online/test/link/input", "POST", { type: "click", x: 10, y: 20 });
    expect(input).toHaveBeenCalledWith(samId, "test", { type: "click", x: 10, y: 20 });
    expect((await sam("/api/online/test/link/input", "POST", { type: "eval", js: "x" })).status).toBe(400);
    expect(await (await sam("/api/online/test/link/done", "POST")).json()).toMatchObject({ signedIn: true });
  });

  it("is off without the worker", async () => {
    const e = setup();
    const sam = await e.register("Sam");
    expect((await sam.call("/api/online/stores")).status).toBe(503);
  });
});
