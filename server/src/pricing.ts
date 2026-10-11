import { randomUUID } from "node:crypto";
import type { Assistant, Offer, OfferMatch, WantedItem } from "./ai/index.js";
import type { DB } from "./db.js";
import type { FetchFn } from "./products.js";

// Read-only price comparison. The worker container (Playwright) loads each store's search page
// for an item and returns its visible text; the AI picks the best-matching product and reads its
// price. Nothing is added to any basket and nobody logs in.

export const STORES = [
  { id: "tesco", name: "Tesco" },
  { id: "dunnes", name: "Dunnes Stores" },
] as const;

export type StoreId = (typeof STORES)[number]["id"];

/** Results are reused for this long so re-running a check is cheap and polite to the stores. */
export const CACHE_MS = 12 * 60 * 60 * 1000;

export interface PriceWorker {
  searchPage(store: StoreId, query: string): Promise<string>;
}

export class HttpPriceWorker implements PriceWorker {
  constructor(
    private baseUrl: string,
    private token?: string,
    private fetchFn: FetchFn = fetch,
  ) {}

  async searchPage(store: StoreId, query: string): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ store, query }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? `worker returned ${res.status}`);
    return body.text;
  }
}

export function searchQuery(item: WantedItem): string {
  return [item.brand, item.name, item.size].filter(Boolean).join(" ").trim();
}

/**
 * Search pages are mostly navigation and filters. Keep only the lines around prices so the AI reads
 * a few thousand characters instead of the whole page.
 */
export function focusOnPrices(text: string, maxChars = 12_000): string {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (/€\s?\d|\d+[.,]\d{2}\s?€/.test(line)) for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
  });
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join("\n")
    .slice(0, maxChars);
}

/** The price you'd actually pay for one pack: loyalty price when the store shows one. */
export function bestPrice(offer: Offer): number {
  return offer.memberPrice != null && offer.memberPrice < offer.price ? offer.memberPrice : offer.price;
}

const round = (n: number) => Math.round(n * 100) / 100;

export interface CheckedItem {
  itemId: string;
  name: string;
  qty: number;
  query: string;
  match: Offer | null;
  confidence: OfferMatch["confidence"] | null;
  lineTotal: number | null;
  error?: string;
}

export interface StoreResult {
  id: StoreId;
  name: string;
  items: CheckedItem[];
  total: number;
  found: number;
  missing: number;
}

export interface PriceCheckResult {
  stores: StoreResult[];
  /** Totals over only the items every store had, so the comparison is like for like. */
  comparison: { items: number; totals: Record<string, number>; cheapest: StoreId | null; saving: number } | null;
  progress: { done: number; total: number };
}

export function summarise(stores: StoreResult[], progress: PriceCheckResult["progress"]): PriceCheckResult {
  for (const s of stores) {
    s.found = s.items.filter((i) => i.match).length;
    s.missing = s.items.filter((i) => !i.match && !i.error).length;
    s.total = round(s.items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0));
  }
  const ids = stores[0]?.items.map((i) => i.itemId) ?? [];
  const common = ids.filter((id) => stores.every((s) => s.items.find((i) => i.itemId === id)?.match));
  if (!common.length || stores.length < 2) return { stores, comparison: null, progress };
  const totals = Object.fromEntries(
    stores.map((s) => [s.id, round(s.items.filter((i) => common.includes(i.itemId)).reduce((sum, i) => sum + (i.lineTotal ?? 0), 0))]),
  );
  const sorted = [...stores].sort((a, b) => totals[a.id] - totals[b.id]);
  const saving = round(totals[sorted[1].id] - totals[sorted[0].id]);
  return { stores, comparison: { items: common.length, totals, cheapest: saving > 0 ? sorted[0].id : null, saving }, progress };
}

interface Deps {
  db: DB;
  assistant: Assistant;
  worker: PriceWorker;
  now?: () => number;
}

async function matchAtStore({ db, assistant, worker, now = Date.now }: Deps, store: StoreId, item: WantedItem): Promise<OfferMatch> {
  const query = searchQuery(item);
  const cached = db.prepare("SELECT match_json, fetched_at FROM price_cache WHERE store = ? AND query = ?").get(store, query.toLowerCase()) as
    | { match_json: string; fetched_at: number }
    | undefined;
  if (cached && now() - cached.fetched_at < CACHE_MS) return JSON.parse(cached.match_json) as OfferMatch;

  const page = focusOnPrices(await worker.searchPage(store, query));
  // No prices on the page: no results, or the store showed a challenge page. Either way, no match.
  const result: OfferMatch = page ? await assistant.matchOffer(item, STORES.find((s) => s.id === store)!.name, page) : { match: null, confidence: "high" };
  db.prepare(
    "INSERT INTO price_cache (store, query, match_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(store, query) DO UPDATE SET match_json = excluded.match_json, fetched_at = excluded.fetched_at",
  ).run(store, query.toLowerCase(), JSON.stringify(result), now());
  return result;
}

/** Starts a check in the background and returns its id. One check per list runs at a time. */
export function startPriceCheck(deps: Deps, listId: string, userId: string): { id: string; alreadyRunning: boolean } {
  const { db } = deps;
  const running = db.prepare("SELECT id FROM price_checks WHERE list_id = ? AND status = 'running' AND started_at > ?").get(listId, Date.now() - 30 * 60_000) as
    | { id: string }
    | undefined;
  if (running) return { id: running.id, alreadyRunning: true };

  const items = db
    .prepare("SELECT id, name, brand, size, qty FROM items WHERE list_id = ? AND deleted = 0 AND done = 0 ORDER BY created_at")
    .all(listId) as Array<{ id: string; name: string; brand: string | null; size: string | null; qty: number }>;
  const id = randomUUID();
  const stores: StoreResult[] = STORES.map((s) => ({ id: s.id, name: s.name, items: [], total: 0, found: 0, missing: 0 }));
  const progress = { done: 0, total: items.length * STORES.length };
  const save = (status: string, error: string | null = null) =>
    db
      .prepare("UPDATE price_checks SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, JSON.stringify(summarise(stores, progress)), error, status === "running" ? null : Date.now(), id);

  db.prepare("INSERT INTO price_checks (id, list_id, user_id, status, started_at, result) VALUES (?, ?, ?, 'running', ?, ?)").run(
    id,
    listId,
    userId,
    Date.now(),
    JSON.stringify(summarise(stores, progress)),
  );

  void (async () => {
    try {
      for (const store of stores) {
        for (const it of items) {
          const wanted = { name: it.name, brand: it.brand, size: it.size };
          const row: CheckedItem = { itemId: it.id, name: it.name, qty: it.qty, query: searchQuery(wanted), match: null, confidence: null, lineTotal: null };
          try {
            const m = await matchAtStore(deps, store.id, wanted);
            row.match = m.match;
            row.confidence = m.confidence;
            row.lineTotal = m.match ? round(bestPrice(m.match) * it.qty) : null;
          } catch (err) {
            row.error = err instanceof Error ? err.message : String(err);
          }
          store.items.push(row);
          progress.done++;
          save("running");
        }
      }
      save("done");
    } catch (err) {
      save("failed", err instanceof Error ? err.message : String(err));
    }
  })();
  return { id, alreadyRunning: false };
}

export function getPriceCheck(db: DB, id: string) {
  const row = db.prepare("SELECT * FROM price_checks WHERE id = ?").get(id) as
    | { id: string; list_id: string; status: string; started_at: number; finished_at: number | null; result: string; error: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    listId: row.list_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    ...(JSON.parse(row.result) as PriceCheckResult),
  };
}

export function latestPriceCheck(db: DB, listId: string) {
  const row = db.prepare("SELECT id FROM price_checks WHERE list_id = ? ORDER BY started_at DESC LIMIT 1").get(listId) as { id: string } | undefined;
  return row ? getPriceCheck(db, row.id) : null;
}
