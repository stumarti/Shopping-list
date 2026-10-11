import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { plan } from "../src/planning.js";
import { getState } from "../src/sync.js";
import { milk, setup } from "./helpers.js";

async function two() {
  const env = setup();
  const sam = await env.register("Sam");
  const { code } = await (await sam.post("/api/invites")).json();
  const alex = env.as((await (await env.join(code, "Alex")).json()).token);
  return { ...env, sam, alex };
}

describe("shared list", () => {
  it("seeds the household list and default sections in supermarket order", async () => {
    const { sam } = await two();
    const state = await (await sam.call("/api/state")).json();
    expect(state.lists).toEqual([{ id: "household", name: "Shopping", private: false, ownerId: null }]);
    expect(state.sections[0].id).toBe("produce");
  });

  it("adds, ticks and deletes items, and names who added them from the token", async () => {
    const { sam, alex } = await two();
    let state = await sam.sync([{ type: "item.upsert", at: 1, item: milk }]);
    expect(state.items[0]).toMatchObject({ name: "Whole milk", listId: "household", addedBy: "Sam", done: false });

    state = await alex.sync([{ type: "item.upsert", at: 2, item: { ...milk, done: true } }]);
    expect(state.items[0].done).toBe(true);
    expect(state.items[0].addedBy).toBe("Sam");

    state = await alex.sync([{ type: "item.delete", at: 3, id: "i1" }]);
    expect(state.items).toHaveLength(0);
  });

  it("keeps the newest write when phones sync out of order", async () => {
    const { sam, alex } = await two();
    await sam.sync([{ type: "item.upsert", at: 10, item: { ...milk, qty: 3 } }]);
    const state = await alex.sync([{ type: "item.upsert", at: 5, item: { ...milk, qty: 1 } }]);
    expect(state.items[0].qty).toBe(3);
  });

  it("does not resurrect an item deleted after a stale edit", async () => {
    const { sam } = await two();
    await sam.sync([{ type: "item.upsert", at: 1, item: milk }, { type: "item.delete", at: 5, id: "i1" }]);
    const state = await sam.sync([{ type: "item.upsert", at: 3, item: { ...milk, done: true } }]);
    expect(state.items).toHaveLength(0);
  });

  it("clears ticked items only", async () => {
    const { sam } = await two();
    const state = await sam.sync([
      { type: "item.upsert", at: 1, item: { ...milk, done: true } },
      { type: "item.upsert", at: 1, item: { id: "i2", name: "Bread", sectionId: "bakery" } },
      { type: "items.clearDone", at: 2, listId: "household" },
    ]);
    expect(state.items.map((i: { id: string }) => i.id)).toEqual(["i2"]);
  });

  it("reorders sections for everyone", async () => {
    const { sam, alex } = await two();
    await sam.sync([{ type: "sections.reorder", at: 1, order: ["frozen", "produce"] }]);
    const state = await (await alex.call("/api/state")).json();
    expect(state.sections.slice(0, 3).map((s: { id: string }) => s.id)).toEqual(["frozen", "produce", "bakery"]);
  });

  it("rejects malformed ops", async () => {
    const { sam } = await two();
    const res = await sam.post("/api/sync", { ops: [{ type: "item.upsert", at: 1, item: { id: "x" } }] });
    expect(res.status).toBe(400);
  });
});

describe("private lists", () => {
  it("are invisible to others, and others' ops on them are ignored", async () => {
    const { sam, alex } = await two();
    await sam.sync([
      { type: "list.upsert", at: 1, list: { id: "gifts", name: "Gifts", private: true } },
      { type: "item.upsert", at: 2, item: { id: "g1", listId: "gifts", name: "Chocolates", sectionId: "cupboard" } },
    ]);

    let alexView = await (await alex.call("/api/state")).json();
    expect(alexView.lists.map((l: { id: string }) => l.id)).toEqual(["household"]);
    expect(alexView.items).toHaveLength(0);

    // Alex can't edit, delete, add to, or clear Sam's private list, even knowing the ids.
    alexView = await alex.sync([
      { type: "item.upsert", at: 9, item: { id: "g1", listId: "gifts", name: "Hacked", sectionId: "cupboard" } },
      { type: "item.upsert", at: 9, item: { id: "g2", listId: "gifts", name: "Sneaky", sectionId: "cupboard" } },
      { type: "item.upsert", at: 9, item: { id: "g1", listId: "household", name: "Moved", sectionId: "cupboard" } },
      { type: "item.delete", at: 9, id: "g1" },
      { type: "list.delete", at: 9, id: "gifts" },
    ]);
    const samView = await (await sam.call("/api/state")).json();
    expect(samView.items.map((i: { name: string; listId: string }) => [i.name, i.listId])).toEqual([["Chocolates", "gifts"]]);
    expect(samView.lists.map((l: { id: string }) => l.id)).toEqual(["household", "gifts"]);
  });

  it("can be renamed and deleted by the owner; the household list can't be deleted", async () => {
    const { sam } = await two();
    await sam.sync([{ type: "list.upsert", at: 1, list: { id: "gifts", name: "Gifts", private: true } }]);
    let state = await sam.sync([{ type: "list.upsert", at: 2, list: { id: "gifts", name: "Presents", private: true } }]);
    expect(state.lists[1].name).toBe("Presents");
    state = await sam.sync([
      { type: "list.delete", at: 3, id: "gifts" },
      { type: "list.delete", at: 3, id: "household" },
      { type: "list.upsert", at: 3, list: { id: "household", name: "Groceries", private: true } },
    ]);
    expect(state.lists).toEqual([{ id: "household", name: "Groceries", private: false, ownerId: null }]);
  });
});

describe("shopping trips and history", () => {
  it("records ticks as purchases on the shopper's trip and shows the active shopper to others", async () => {
    const { sam, alex } = await two();
    await sam.sync([
      { type: "item.upsert", at: 1, item: milk },
      { type: "item.upsert", at: 1, item: { id: "i2", name: "Bread", sectionId: "bakery" } },
    ]);
    const trip = await (await alex.post("/api/trips", { listId: "household" })).json();

    const samView = await (await sam.call("/api/state")).json();
    expect(samView.activeTrips).toMatchObject([{ name: "Alex", listId: "household", ticked: 0 }]);

    await alex.sync([
      { type: "item.upsert", at: 2, item: { ...milk, done: true } },
      { type: "item.upsert", at: 2, item: { id: "i2", name: "Bread", sectionId: "bakery", done: true } },
      { type: "item.upsert", at: 3, item: { id: "i2", name: "Bread", sectionId: "bakery", done: false } }, // oops
    ]);
    const summary = await (await alex.post(`/api/trips/${trip.id}/finish`)).json();
    expect(summary.items).toEqual([{ name: "Whole milk", brand: "Avonmore", size: "2 L", qty: 1 }]);

    const history = await (await sam.call("/api/lists/household/history")).json();
    expect(history.trips).toMatchObject([{ shopper: "Alex", count: 1 }]);
    expect((await (await sam.call("/api/state")).json()).activeTrips).toEqual([]);
  });

  it("won't let someone finish another person's trip or read a private list's history", async () => {
    const { sam, alex } = await two();
    const trip = await (await sam.post("/api/trips", { listId: "household" })).json();
    expect((await alex.post(`/api/trips/${trip.id}/finish`)).status).toBe(404);
    await sam.sync([{ type: "list.upsert", at: 1, list: { id: "gifts", name: "Gifts", private: true } }]);
    expect((await alex.call("/api/lists/gifts/history")).status).toBe(404);
    expect((await alex.post("/api/trips", { listId: "gifts" })).status).toBe(404);
  });
});

describe("usual items", () => {
  const DAY = 86_400_000;

  it("suggests regular buys that are due and not already on the list", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u', 'Sam', 0)").run();
    const buy = db.prepare(
      "INSERT INTO purchases (item_id, user_id, list_id, name, name_key, qty, section_id, bought_at) VALUES ('x', 'u', 'household', ?, ?, 1, ?, ?)",
    );
    const now = 100 * DAY;
    // Milk every ~7 days, last bought 8 days ago: due.
    for (const d of [71, 78, 85, 92]) buy.run("Milk", "milk", "dairy", d * DAY);
    // Coffee every ~30 days, last bought 5 days ago: not due.
    for (const d of [35, 65, 95]) buy.run("Coffee", "coffee", "drinks", d * DAY);
    // Bread is due but already on the list.
    for (const d of [80, 87, 92]) buy.run("Bread", "bread", "bakery", d * DAY);
    db.prepare("INSERT INTO items (id, list_id, name, section_id, created_at, updated_at) VALUES ('b', 'household', 'bread', 'bakery', 0, 0)").run();
    // Two packs on one trip count as one buy, so a single shop isn't "regular".
    buy.run("Crisps", "crisps", "cupboard", 50 * DAY);
    buy.run("Crisps", "crisps", "cupboard", 50 * DAY + 1000);

    const out = plan(db, "household", now);
    expect(out.map((s) => s.name)).toEqual(["Milk"]);
    expect(out[0]).toMatchObject({ lastBoughtDaysAgo: 8, usualEveryDays: 7, timesBought: 4 });
  });
});

describe("upgrading an existing database", () => {
  it("moves a v1 single-list database into the household list", () => {
    const file = pathJoin(mkdtempSync(pathJoin(tmpdir(), "shop-")), "old.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, size TEXT, qty INTEGER NOT NULL DEFAULT 1, section_id TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'text', barcode TEXT, added_by TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE products (barcode TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, size TEXT, section_id TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO sections VALUES ('dairy', 'Dairy & eggs', '#3B82C4', 0, 0);
      INSERT INTO items (id, name, section_id, added_by, created_at, updated_at) VALUES ('old', 'Milk', 'dairy', 'Sam', 1, 1);
    `);
    old.close();

    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u', 'Sam', 0)").run();
    const state = getState(db, "u");
    expect(state.items).toMatchObject([{ id: "old", listId: "household", addedBy: "Sam" }]);
    db.close();
    expect(openDb(file).pragma("user_version", { simple: true })).toBe(5); // re-opening is a no-op
  });
});
