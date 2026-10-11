import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { Assistant, ReceiptDraft } from "../src/ai/index.js";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { DAY } from "../src/forecast.js";
import { processInbox } from "../src/inbox.js";
import { runAutoPlan } from "../src/planning.js";

const line = (name: string, lineTotal: number, extra: Partial<ReceiptDraft["lines"][number]> = {}) => ({
  raw: name.toUpperCase(),
  name,
  brand: null,
  size: null,
  qty: 1,
  unitPrice: lineTotal,
  lineTotal,
  sectionId: "dairy",
  isProduct: true,
  ...extra,
});

const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

/** A pretend weekly Tesco shop: milk and bread every week, plus whatever's passed in. */
const weekly = (n: number, extra: ReceiptDraft["lines"] = []): ReceiptDraft => ({
  store: "Tesco",
  date: daysAgo(n),
  total: 6.5 + n / 100,
  lines: [line("Whole milk", 2.39, { qty: 2 }), line("Sourdough", 3.0, { sectionId: "bakery" }), line("Bag levy", 0.22, { isProduct: false }), ...extra],
});

function env(drafts: ReceiptDraft[]) {
  const db = openDb(":memory:");
  const readReceipt = vi.fn(async (_files: Array<{ data: string }>, _sections: unknown, _known: string[]) => drafts.shift()!);
  const assistant: Assistant = { name: "fake", identifyPhoto: vi.fn(), parseText: vi.fn(), matchOffer: vi.fn(), classify: vi.fn(), readReceipt };
  const app = createApp({ db, assistant });
  return { db, app, readReceipt };
}

async function signIn(app: ReturnType<typeof createApp>) {
  const { token } = await (await app.request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sam" }) })).json();
  return (path: string, method = "GET", body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

const photo = { data: "A".repeat(200), mediaType: "image/jpeg" };

describe("receipts", () => {
  it("reads a receipt for review, takes corrections, and turns it into history once confirmed", async () => {
    const { app, readReceipt, db } = env([weekly(3)]);
    const call = await signIn(app);
    const res = await call("/api/lists/household/receipts", "POST", { files: [photo] });
    expect(res.status).toBe(201);
    const { receipt } = await res.json();
    expect(receipt).toMatchObject({ store: "Tesco", status: "review", total: 6.53 });
    expect(receipt.lines.map((l: { name: string }) => l.name)).toEqual(["Whole milk", "Sourdough", "Bag levy"]);
    // The AI is told the names the household already uses.
    expect(readReceipt.mock.calls[0][2]).toEqual([]);

    const edited = { store: "Tesco", date: receipt.purchasedOn, total: 6.53, lines: receipt.lines.map((l: object, i: number) => (i === 1 ? { ...l, name: "Sourdough loaf" } : l)) };
    expect((await call(`/api/receipts/${receipt.id}`, "PATCH", edited)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM purchases").get()).toEqual({ n: 0 });

    const confirmed = (await (await call(`/api/receipts/${receipt.id}/confirm`, "POST")).json()).receipt;
    expect(confirmed.status).toBe("confirmed");
    const rows = db.prepare("SELECT name, qty, price FROM purchases ORDER BY name").all();
    expect(rows).toEqual([
      { name: "Sourdough loaf", qty: 1, price: 3 },
      { name: "Whole milk", qty: 2, price: 2.39 },
    ]);
    expect((await call(`/api/receipts/${receipt.id}`, "PATCH", edited)).status).toBe(409);
  });

  it("refuses the same receipt twice", async () => {
    const same = weekly(3);
    const { app } = env([same, { ...same }]);
    const call = await signIn(app);
    const { receipt } = await (await call("/api/lists/household/receipts", "POST", { files: [photo] })).json();
    await call(`/api/receipts/${receipt.id}/confirm`, "POST");
    const again = await call("/api/lists/household/receipts", "POST", { files: [photo] });
    expect(again.status).toBe(409);
    expect((await again.json()).existingId).toBe(receipt.id);
  });

  it("doesn't count an item twice when it was ticked and is also on the receipt", async () => {
    const { app, db } = env([weekly(0)]);
    const call = await signIn(app);
    await call("/api/sync", "POST", { ops: [{ type: "item.upsert", at: Date.now(), item: { id: "m", name: "Whole milk", sectionId: "dairy", done: true } }] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE name = 'Whole milk'").get()).toEqual({ n: 1 });
    const { receipt } = await (await call("/api/lists/household/receipts", "POST", { files: [photo] })).json();
    await call(`/api/receipts/${receipt.id}/confirm`, "POST");
    expect(db.prepare("SELECT receipt_id IS NOT NULL AS fromReceipt FROM purchases WHERE name = 'Whole milk'").all()).toEqual([{ fromReceipt: 1 }]);
  });

  it("deleting a receipt removes its history", async () => {
    const { app, db } = env([weekly(3)]);
    const call = await signIn(app);
    const { receipt } = await (await call("/api/lists/household/receipts", "POST", { files: [photo] })).json();
    await call(`/api/receipts/${receipt.id}/confirm`, "POST");
    await call(`/api/receipts/${receipt.id}`, "DELETE");
    expect(db.prepare("SELECT COUNT(*) AS n FROM purchases").get()).toEqual({ n: 0 });
    expect((await (await call("/api/lists/household/receipts")).json()).receipts).toEqual([]);
  });

  it("needs an AI backend", async () => {
    const db = openDb(":memory:");
    const call = await signIn(createApp({ db }));
    expect((await call("/api/lists/household/receipts", "POST", { files: [photo] })).status).toBe(503);
  });
});

async function withHistory() {
  // Eight weekly shops: milk and bread every week, coffee every four weeks.
  const drafts = [49, 42, 35, 28, 21, 14, 7, 6].map((n, i) =>
    i === 7 ? { ...weekly(n), lines: [line("Ground coffee", 6, { sectionId: "drinks" })], total: 6 } : weekly(n, n % 28 === 0 ? [line("Ground coffee", 6, { sectionId: "drinks" })] : []),
  );
  const e = env([...drafts]);
  const call = await signIn(e.app);
  for (let i = 0; i < drafts.length; i++) {
    const { receipt } = await (await call("/api/lists/household/receipts", "POST", { files: [photo] })).json();
    await call(`/api/receipts/${receipt.id}/confirm`, "POST");
  }
  return { ...e, call };
}

describe("weekly plan", () => {
  it("predicts this week's shop from receipts, with quantities and reasons", async () => {
    const { call } = await withHistory();
    const { predictions, settings } = await (await call("/api/lists/household/plan")).json();
    expect(settings).toEqual({ autoAdd: false, horizonDays: 7, lastAutoRun: null });
    expect(predictions.map((p: { name: string }) => p.name)).toEqual(["Sourdough", "Whole milk"]);
    expect(predictions[1]).toMatchObject({ qty: 2, usualEveryDays: 7, confidence: "high", reason: "About every week · last bought 7 days ago" });
  });

  it("adds chosen predictions to the list, and they're then not suggested again", async () => {
    const { call } = await withHistory();
    const { predictions } = await (await call("/api/lists/household/plan")).json();
    const { added } = await (await call("/api/lists/household/plan/add", "POST", { keys: [predictions[1].key] })).json();
    expect(added).toEqual(["Whole milk"]);
    const state = await (await call("/api/state")).json();
    expect(state.items).toMatchObject([{ name: "Whole milk", qty: 2, source: "plan", addedBy: "Weekly plan" }]);
    expect((await (await call("/api/lists/household/plan")).json()).predictions.map((p: { name: string }) => p.name)).toEqual(["Sourdough"]);
  });

  it("tops the list up automatically, and removing a planned item snoozes it", async () => {
    const { call, db } = await withHistory();
    await call("/api/lists/household/plan/settings", "PUT", { autoAdd: true });
    let state = await (await call("/api/state")).json();
    expect(state.items.map((i: { name: string }) => i.name).sort()).toEqual(["Sourdough", "Whole milk"]);

    const milk = state.items.find((i: { name: string }) => i.name === "Whole milk");
    await call("/api/sync", "POST", { ops: [{ type: "item.delete", at: Date.now(), id: milk.id }] });
    // Next run (13 hours later): milk stays off this week.
    runAutoPlan(db, Date.now() + 13 * 60 * 60 * 1000);
    state = await (await call("/api/state")).json();
    expect(state.items.map((i: { name: string }) => i.name)).toEqual(["Sourdough"]);
  });

  it("shows trends: monthly spend from receipts and what you buy most", async () => {
    const { call } = await withHistory();
    const t = await (await call("/api/lists/household/trends")).json();
    expect(t.spend).toHaveLength(24);
    expect(t.spend.reduce((s: number, m: { receipts: number }) => s + m.receipts, 0)).toBe(8);
    expect(t.top.slice(0, 2).map((x: { name: string }) => x.name).sort()).toEqual(["Sourdough", "Whole milk"]);
    expect(t.hasSeasons).toBe(false);
  });
});

describe("receipts inbox", () => {
  it("imports photos and multi-part receipts from a folder, and sorts out duplicates and bad files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-"));
    const jpeg = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    writeFileSync(join(dir, "2025-03-01 tesco.jpg"), jpeg);
    mkdirSync(join(dir, "long dunnes receipt"));
    writeFileSync(join(dir, "long dunnes receipt", "1.jpg"), jpeg);
    writeFileSync(join(dir, "long dunnes receipt", "2.jpg"), jpeg);
    writeFileSync(join(dir, "copy of tesco.jpg"), jpeg);
    writeFileSync(join(dir, "IMG_0001.HEIC"), "x");
    // Pretend everything finished copying a minute ago.
    const old = new Date(Date.now() - 60_000);
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
    for (const f of readdirSync(join(dir, "long dunnes receipt"))) utimesSync(join(dir, "long dunnes receipt", f), old, old);

    const tesco = weekly(10);
    const dunnes: ReceiptDraft = { store: "Dunnes Stores", date: daysAgo(20), total: 12, lines: [line("Eggs", 4)] };
    // Files are processed in name order: "2025-03-01 tesco.jpg", "copy of tesco.jpg", "long dunnes receipt".
    const { db, readReceipt } = env([tesco, { ...tesco }, dunnes]);
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u', 'Sam', 0)").run();

    const summary = await processInbox({ db, assistant: { readReceipt } as unknown as Assistant, sections: () => [{ id: "dairy", name: "Dairy", color: "#000" }], dir, listId: "household", userId: () => "u" });
    expect(summary).toEqual({ imported: 2, duplicates: 1, failed: 1 });
    // Big photos were shrunk before reading; the two-part receipt was sent as two images.
    const parts = readReceipt.mock.calls.map((c) => c[0].length);
    expect(parts).toEqual([1, 1, 2]);
    const meta = await sharp(Buffer.from(readReceipt.mock.calls[0][0][0].data, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2000);

    expect(readdirSync(join(dir, "done")).sort()).toEqual(["2025-03-01 tesco.jpg", "long dunnes receipt"]);
    expect(readdirSync(join(dir, "duplicate"))).toContain("copy of tesco.jpg");
    expect(readFileSync(join(dir, "failed", "IMG_0001.HEIC.txt"), "utf8")).toContain("Most Compatible");
    expect(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE status = 'confirmed'").get()).toEqual({ n: 2 });
  });

  it("leaves files alone while they're still being copied in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-"));
    writeFileSync(join(dir, "new.jpg"), "still copying");
    const { db, readReceipt } = env([]);
    const summary = await processInbox({ db, assistant: { readReceipt } as unknown as Assistant, sections: () => [], dir, listId: "household", userId: () => "u" });
    expect(summary).toEqual({ imported: 0, duplicates: 0, failed: 0 });
    expect(readdirSync(dir)).toEqual(["new.jpg"]);
  });
});
