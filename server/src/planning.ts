import { randomUUID } from "node:crypto";
import { nameKey, type DB } from "./db.js";
import { DAY, forecast, seasonalIndex, buyingDays, MONTHS, type Prediction, type PurchaseEvent } from "./forecast.js";

// The weekly plan (what you'll probably need), keeping the list topped up automatically, and the
// trends screen. All of it reads the same purchase history: ticked items plus confirmed receipts.

export function purchaseEvents(db: DB, listId: string, since = 0): PurchaseEvent[] {
  return (
    db
      .prepare("SELECT name_key AS key, name, brand, size, section_id AS sectionId, qty, bought_at AS at FROM purchases WHERE list_id = ? AND bought_at >= ? ORDER BY bought_at")
      .all(listId, since) as PurchaseEvent[]
  ).map((e) => ({ ...e, qty: e.qty || 1 }));
}

export interface PlanSettings {
  autoAdd: boolean;
  horizonDays: number;
  lastAutoRun: number | null;
}

export function getSettings(db: DB, listId: string): PlanSettings {
  const r = db.prepare("SELECT * FROM list_settings WHERE list_id = ?").get(listId) as
    | { auto_add: number; horizon_days: number; last_auto_run: number | null }
    | undefined;
  return { autoAdd: r?.auto_add === 1, horizonDays: r?.horizon_days ?? 7, lastAutoRun: r?.last_auto_run ?? null };
}

export function setSettings(db: DB, listId: string, s: { autoAdd?: boolean; horizonDays?: number }) {
  const cur = getSettings(db, listId);
  db.prepare(
    `INSERT INTO list_settings (list_id, auto_add, horizon_days) VALUES (?, ?, ?)
     ON CONFLICT(list_id) DO UPDATE SET auto_add = excluded.auto_add, horizon_days = excluded.horizon_days`,
  ).run(listId, (s.autoAdd ?? cur.autoAdd) ? 1 : 0, Math.max(1, Math.min(31, s.horizonDays ?? cur.horizonDays)));
  return getSettings(db, listId);
}

function onListKeys(db: DB, listId: string): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM items WHERE list_id = ? AND deleted = 0 AND done = 0").all(listId) as Array<{ name: string }>).map((r) => nameKey(r.name)),
  );
}

function snoozedKeys(db: DB, listId: string, now: number): Set<string> {
  return new Set((db.prepare("SELECT name_key FROM item_snoozes WHERE list_id = ? AND until > ?").all(listId, now) as Array<{ name_key: string }>).map((r) => r.name_key));
}

/** What you'll probably need in the next `horizonDays`, minus what's already on the list or snoozed. */
export function plan(db: DB, listId: string, now = Date.now(), horizonDays?: number): Prediction[] {
  const events = purchaseEvents(db, listId);
  if (!events.length) return [];
  const skip = new Set([...onListKeys(db, listId), ...snoozedKeys(db, listId, now)]);
  return forecast(events, now, { horizonDays: horizonDays ?? getSettings(db, listId).horizonDays, skip });
}

/** Add predicted items to the list. Returns the names added. */
export function addToList(db: DB, listId: string, predictions: Prediction[], now = Date.now()): string[] {
  const insert = db.prepare(`
    INSERT INTO items (id, list_id, name, brand, size, qty, section_id, done, source, barcode, added_by, added_by_user, created_at, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'plan', NULL, 'Weekly plan', NULL, ?, ?, 0)
  `);
  db.transaction(() => {
    for (const p of predictions) insert.run(randomUUID(), listId, p.name, p.brand, p.size, p.qty, p.sectionId, now, now);
  })();
  return predictions.map((p) => p.name);
}

/**
 * Keep lists topped up: for every list with auto-add on, add what's due that we're fairly sure of.
 * Runs hourly; each list at most once every 12 hours so removed items don't bounce straight back.
 */
export function runAutoPlan(db: DB, now = Date.now()): Array<{ listId: string; added: string[] }> {
  const lists = db
    .prepare(
      `SELECT s.list_id FROM list_settings s JOIN lists l ON l.id = s.list_id
       WHERE s.auto_add = 1 AND l.deleted = 0 AND (s.last_auto_run IS NULL OR s.last_auto_run < ?)`,
    )
    .all(now - 12 * 60 * 60 * 1000) as Array<{ list_id: string }>;
  const results = [];
  for (const { list_id } of lists) {
    const sure = plan(db, list_id, now).filter((p) => p.confidence !== "low");
    const added = addToList(db, list_id, sure, now);
    db.prepare("UPDATE list_settings SET last_auto_run = ? WHERE list_id = ?").run(now, list_id);
    results.push({ listId: list_id, added });
  }
  return results;
}

/** Removing something the plan added means "not this time": don't suggest it again for a while. */
export function snooze(db: DB, listId: string, name: string, days: number, now = Date.now()) {
  db.prepare(
    "INSERT INTO item_snoozes (list_id, name_key, until) VALUES (?, ?, ?) ON CONFLICT(list_id, name_key) DO UPDATE SET until = excluded.until",
  ).run(listId, nameKey(name), now + days * DAY);
}

// ---- Trends ----

const ym = (t: number) => new Date(t).toISOString().slice(0, 7);

export function trends(db: DB, listId: string, now = Date.now()) {
  // Spend by month from receipts (the only place with real totals), last 24 months.
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - 23, 1);
  const months: string[] = [];
  for (const d = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)); d.getTime() <= now; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(ym(d.getTime()));
  const spendRows = db
    .prepare(
      `SELECT substr(purchased_on, 1, 7) AS month, SUM(total) AS total, COUNT(*) AS receipts FROM receipts
       WHERE list_id = ? AND status = 'confirmed' AND purchased_on >= ? GROUP BY month`,
    )
    .all(listId, `${months[0]}-01`) as Array<{ month: string; total: number; receipts: number }>;
  const spend = months.map((m) => {
    const r = spendRows.find((x) => x.month === m);
    return { month: m, total: Math.round((r?.total ?? 0) * 100) / 100, receipts: r?.receipts ?? 0 };
  });

  // Seasonal favourites: products whose buying clearly peaks in some months.
  const events = purchaseEvents(db, listId);
  const firstSeen = events.length ? events[0].at : now;
  const byKey = new Map<string, PurchaseEvent[]>();
  for (const e of events) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const seasonal = [];
  for (const [key, list] of byKey) {
    const days = buyingDays(list);
    const index = seasonalIndex(days, firstSeen, now);
    if (!index) continue;
    const peak = index.flatMap((v, m) => (v >= 1.8 ? [m] : []));
    if (!peak.length || peak.length > 6) continue;
    const latest = list[list.length - 1];
    seasonal.push({ key, name: latest.name, sectionId: latest.sectionId, peakMonths: peak, peakLabel: peak.map((m) => MONTHS[m].slice(0, 3)).join(", "), index: index.map((v) => Math.round(v * 10) / 10), timesBought: days.length });
  }
  seasonal.sort((a, b) => Math.max(...b.index) - Math.max(...a.index));
  const thisMonth = new Date(now).getUTCMonth();

  // What you buy most, last 90 days.
  const recent = events.filter((e) => e.at > now - 90 * DAY);
  const counts = new Map<string, { name: string; sectionId: string; times: number }>();
  for (const e of recent) counts.set(e.key, { name: e.name, sectionId: e.sectionId, times: (counts.get(e.key)?.times ?? 0) + 1 });
  const top = [...counts.values()].sort((a, b) => b.times - a.times).slice(0, 10);

  return {
    spend,
    historyFrom: events.length ? new Date(firstSeen).toISOString().slice(0, 10) : null,
    hasSeasons: now - firstSeen >= 300 * DAY,
    inSeasonNow: seasonal.filter((s) => s.peakMonths.includes(thisMonth)).slice(0, 10),
    seasonal: seasonal.slice(0, 20),
    top,
  };
}
