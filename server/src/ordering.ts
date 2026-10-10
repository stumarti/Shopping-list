import { randomUUID } from "node:crypto";
import type { Assistant, Classified, StoreProduct, WantedItem } from "./ai/index.js";
import type { DB } from "./db.js";
import type { FetchFn } from "./products.js";

// Online ordering: check a slot is booked, match every item on the list to a product in the store,
// let the person pick substitutes where there's no exact match, then fill their real basket.
// Checkout and payment stay in the store's own app or website.

export interface Candidate extends StoreProduct {
  memberPrice: number | null;
}

export interface Slot {
  kind: "delivery" | "collect";
  label: string;
}

export interface OnlineStore {
  id: string;
  name: string;
  ordering: boolean;
  basketUrl: string;
}

export type RemoteInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: "Enter" | "Tab" | "Backspace" | "Escape" }
  | { type: "scroll"; dy: number }
  | { type: "back" };

/** The worker's store-account endpoints. `owner` is always the signed-in person's id. */
export interface StoreWorker {
  stores(): Promise<OnlineStore[]>;
  slot(owner: string, store: string): Promise<{ signedIn: boolean; slot: Slot | null }>;
  search(owner: string, store: string, query: string): Promise<Candidate[]>;
  add(owner: string, store: string, items: Array<{ candidate: Candidate; qty: number }>): Promise<Array<{ ref: string; ok: boolean; error?: string }>>;
  openAccount(owner: string, store: string): Promise<{ width: number; height: number }>;
  screenshot(owner: string, store: string): Promise<ArrayBuffer>;
  input(owner: string, store: string, event: RemoteInput): Promise<void>;
  closeAccount(owner: string, store: string): Promise<void>;
}

export class WorkerError extends Error {
  constructor(
    message: string,
    public status: number,
    public notReady = false,
  ) {
    super(message);
  }
}

export class HttpStoreWorker implements StoreWorker {
  constructor(
    private baseUrl: string,
    private token?: string,
    private fetchFn: FetchFn = fetch,
  ) {}

  private async call(path: string, body?: unknown, timeoutMs = 120_000): Promise<Response> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; notReady?: boolean };
      throw new WorkerError(err.error ?? `worker returned ${res.status}`, res.status, Boolean(err.notReady));
    }
    return res;
  }

  private async json<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return (await (await this.call(path, body, timeoutMs)).json()) as T;
  }

  async stores() {
    return (await this.json<{ stores: OnlineStore[] }>("/stores")).stores;
  }
  slot(owner: string, store: string) {
    return this.json<{ signedIn: boolean; slot: Slot | null }>("/order/slot", { owner, store });
  }
  async search(owner: string, store: string, query: string) {
    return (await this.json<{ candidates: Candidate[] }>("/order/search", { owner, store, query })).candidates;
  }
  async add(owner: string, store: string, items: Array<{ candidate: Candidate; qty: number }>) {
    return (await this.json<{ results: Array<{ ref: string; ok: boolean; error?: string }> }>("/order/add", { owner, store, items }, 15 * 60_000)).results;
  }
  async openAccount(owner: string, store: string) {
    return (await this.json<{ view: { width: number; height: number } }>("/account/open", { owner, store })).view;
  }
  async screenshot(owner: string, store: string) {
    return (await this.call(`/account/screenshot?owner=${encodeURIComponent(owner)}&store=${encodeURIComponent(store)}`, undefined, 20_000)).arrayBuffer();
  }
  async input(owner: string, store: string, event: RemoteInput) {
    await this.call("/account/input", { owner, store, event }, 30_000);
  }
  async closeAccount(owner: string, store: string) {
    await this.call("/account/close", { owner, store });
  }
}

// ---- Matching ----

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/(\d)\s*(l|ltr|litre|liter|g|kg|ml|cl|pack|pk|x)\b/g, "$1$2")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);

/**
 * Exact without needing AI: every word of the item's brand and name appears in the product, and the
 * size (if the item has one) matches. Cheap, predictable, and catches most scanned items.
 */
export function ruleMatch(item: WantedItem, candidates: Candidate[]): Classified {
  const want = words([item.brand, item.name].filter(Boolean).join(" "));
  const size = item.size ? norm(item.size).replace(/\s/g, "") : null;
  const scored = candidates.map((c, i) => {
    const have = new Set(words(`${c.name} ${c.size ?? ""}`));
    const hits = want.filter((w) => have.has(w)).length;
    const sizeOk = !size || norm(`${c.name} ${c.size ?? ""}`).replace(/\s/g, "").includes(size);
    return { i, hits, exact: c.available && hits === want.length && sizeOk, score: hits / Math.max(want.length, 1) + (sizeOk ? 0.25 : 0) };
  });
  const exact = scored.find((s) => s.exact)?.i ?? null;
  const similar = scored
    .filter((s) => s.i !== exact && s.hits > 0 && candidates[s.i].available)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.i);
  return { exact, similar };
}

async function classify(assistant: Assistant | undefined, item: WantedItem, candidates: Candidate[]): Promise<Classified> {
  const rule = ruleMatch(item, candidates);
  if (rule.exact !== null || !assistant) return rule;
  try {
    const ai = await assistant.classify(item, candidates);
    const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < candidates.length;
    const exact = ai.exact !== null && ok(ai.exact) && candidates[ai.exact].available ? ai.exact : null;
    const similar = [...new Set(ai.similar.filter((i) => ok(i) && i !== exact && candidates[i].available))].slice(0, 5);
    return { exact, similar: similar.length ? similar : rule.similar };
  } catch (err) {
    console.warn("AI matching failed, using word matching", err);
    return rule;
  }
}

// ---- Orders ----

export type LineStatus = "pending" | "exact" | "choose" | "chosen" | "not_found" | "skipped" | "added" | "failed";

export interface OrderLine {
  itemId: string;
  name: string;
  brand: string | null;
  size: string | null;
  qty: number;
  status: LineStatus;
  /** The product that will go in the basket (exact match or the person's pick). */
  chosen: Candidate | null;
  /** Substitutes to pick from, best first. */
  options: Candidate[];
  error: string | null;
}

export interface Order {
  id: string;
  listId: string;
  store: string;
  status: "matching" | "review" | "filling" | "done" | "failed";
  slot: Slot;
  basketUrl: string;
  error: string | null;
  createdAt: number;
  lines: OrderLine[];
}

export function getOrder(db: DB, id: string, userId: string): Order | null {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(id, userId) as Record<string, string | number | null> | undefined;
  if (!o) return null;
  const lines = (db.prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY position").all(id) as Array<Record<string, string | number | null>>).map(
    (l): OrderLine => ({
      itemId: l.item_id as string,
      name: l.name as string,
      brand: l.brand as string | null,
      size: l.size as string | null,
      qty: l.qty as number,
      status: l.status as LineStatus,
      chosen: l.chosen_json ? (JSON.parse(l.chosen_json as string) as Candidate) : null,
      options: JSON.parse((l.options_json as string) || "[]") as Candidate[],
      error: l.error as string | null,
    }),
  );
  return {
    id: o.id as string,
    listId: o.list_id as string,
    store: o.store as string,
    status: o.status as Order["status"],
    slot: { kind: o.slot_kind as Slot["kind"], label: o.slot_label as string },
    basketUrl: o.basket_url as string,
    error: o.error as string | null,
    createdAt: o.created_at as number,
    lines,
  };
}

export function latestOrder(db: DB, userId: string, listId: string): Order | null {
  const row = db.prepare("SELECT id FROM orders WHERE user_id = ? AND list_id = ? ORDER BY created_at DESC LIMIT 1").get(userId, listId) as { id: string } | undefined;
  return row ? getOrder(db, row.id, userId) : null;
}

interface Deps {
  db: DB;
  worker: StoreWorker;
  assistant?: Assistant;
}

const setOrder = (db: DB, id: string, fields: { status: Order["status"]; error?: string | null }) =>
  db.prepare("UPDATE orders SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(fields.status, fields.error ?? null, Date.now(), id);

const setLine = (db: DB, orderId: string, itemId: string, f: { status: LineStatus; chosen?: Candidate | null; options?: Candidate[]; error?: string | null }) =>
  db
    .prepare(
      `UPDATE order_lines SET status = @status,
         chosen_json = CASE WHEN @setChosen THEN @chosen ELSE chosen_json END,
         options_json = CASE WHEN @setOptions THEN @options ELSE options_json END,
         error = @error
       WHERE order_id = @orderId AND item_id = @itemId`,
    )
    .run({
      orderId,
      itemId,
      status: f.status,
      setChosen: f.chosen !== undefined ? 1 : 0,
      chosen: f.chosen ? JSON.stringify(f.chosen) : null,
      setOptions: f.options !== undefined ? 1 : 0,
      options: JSON.stringify(f.options ?? []),
      error: f.error ?? null,
    });

export type StartResult =
  | { ok: true; id: string }
  | { ok: false; code: "not_linked" | "no_slot" | "not_ready" | "empty"; message: string };

/** Checks the slot, then matches every unticked item in the background. */
export async function startOrder({ db, worker, assistant }: Deps, userId: string, listId: string, store: OnlineStore): Promise<StartResult> {
  if (!store.ordering) return { ok: false, code: "not_ready", message: `Online ordering for ${store.name} isn't set up yet.` };
  const { signedIn, slot } = await worker.slot(userId, store.id);
  if (!signedIn) return { ok: false, code: "not_linked", message: `Link your ${store.name} account first.` };
  if (!slot) return { ok: false, code: "no_slot", message: `Book a delivery or click & collect slot in the ${store.name} app first, then try again.` };

  const items = db
    .prepare("SELECT id, name, brand, size, qty FROM items WHERE list_id = ? AND deleted = 0 AND done = 0 ORDER BY created_at")
    .all(listId) as Array<{ id: string; name: string; brand: string | null; size: string | null; qty: number }>;
  if (!items.length) return { ok: false, code: "empty", message: "There's nothing left to buy on this list." };

  const id = randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO orders (id, user_id, list_id, store, status, slot_kind, slot_label, basket_url, created_at, updated_at) VALUES (?, ?, ?, ?, 'matching', ?, ?, ?, ?, ?)",
    ).run(id, userId, listId, store.id, slot.kind, slot.label, store.basketUrl, now, now);
    const add = db.prepare("INSERT INTO order_lines (order_id, item_id, position, name, brand, size, qty, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')");
    items.forEach((it, i) => add.run(id, it.id, i, it.name, it.brand, it.size, it.qty));
  })();

  void (async () => {
    try {
      for (const it of items) {
        await matchLine({ db, worker, assistant }, id, userId, store.id, it.id, { name: it.name, brand: it.brand, size: it.size });
      }
      setOrder(db, id, { status: "review" });
    } catch (err) {
      setOrder(db, id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return { ok: true, id };
}

async function matchLine({ db, worker, assistant }: Deps, orderId: string, userId: string, store: string, itemId: string, item: WantedItem, query?: string) {
  try {
    const found = await worker.search(userId, store, query ?? [item.brand, item.name, item.size].filter(Boolean).join(" "));
    const { exact, similar } = await classify(assistant, item, found);
    const options = similar.map((i) => found[i]);
    if (exact !== null) setLine(db, orderId, itemId, { status: "exact", chosen: found[exact], options });
    else if (options.length) setLine(db, orderId, itemId, { status: "choose", chosen: null, options });
    else setLine(db, orderId, itemId, { status: "not_found", chosen: null, options: [] });
  } catch (err) {
    setLine(db, orderId, itemId, { status: "not_found", chosen: null, options: [], error: err instanceof Error ? err.message : String(err) });
  }
}

export type LineChange = { choose: string } | { skip: true } | { qty: number } | { search: string };

/** The person's decisions on the review screen. */
export async function changeLine(deps: Deps, userId: string, orderId: string, itemId: string, change: LineChange): Promise<Order | null> {
  const order = getOrder(deps.db, orderId, userId);
  const line = order?.lines.find((l) => l.itemId === itemId);
  if (!order || !line || order.status !== "review") return null;
  if ("choose" in change) {
    const pick = [...line.options, ...(line.chosen ? [line.chosen] : [])].find((c) => c.ref === change.choose);
    if (!pick) return null;
    setLine(deps.db, orderId, itemId, { status: line.status === "exact" && pick.ref === line.chosen?.ref ? "exact" : "chosen", chosen: pick });
  } else if ("skip" in change) {
    setLine(deps.db, orderId, itemId, { status: "skipped", chosen: null });
  } else if ("qty" in change) {
    deps.db.prepare("UPDATE order_lines SET qty = ? WHERE order_id = ? AND item_id = ?").run(Math.max(1, Math.min(99, change.qty)), orderId, itemId);
  } else {
    await matchLine(deps, orderId, userId, order.store, itemId, { name: change.search, brand: null, size: null }, change.search);
  }
  return getOrder(deps.db, orderId, userId);
}

export type FillResult = { ok: true } | { ok: false; message: string };

/** Puts every matched or chosen product in the person's basket. */
export function fillBasket({ db, worker }: Deps, userId: string, orderId: string): FillResult {
  const order = getOrder(db, orderId, userId);
  if (!order) return { ok: false, message: "unknown order" };
  if (order.status !== "review") return { ok: false, message: "This order isn't ready to add to the basket." };
  const undecided = order.lines.filter((l) => l.status === "choose" || l.status === "pending");
  if (undecided.length) return { ok: false, message: `Choose or skip ${undecided.length} item${undecided.length === 1 ? "" : "s"} first.` };

  const toAdd = order.lines.filter((l) => (l.status === "exact" || l.status === "chosen") && l.chosen);
  setOrder(db, orderId, { status: "filling" });
  void (async () => {
    try {
      const results = await worker.add(
        userId,
        order.store,
        toAdd.map((l) => ({ candidate: l.chosen!, qty: l.qty })),
      );
      toAdd.forEach((l, i) => {
        const r = results[i];
        setLine(db, orderId, l.itemId, { status: r?.ok ? "added" : "failed", error: r?.ok ? null : (r?.error ?? "Not added") });
      });
      setOrder(db, orderId, { status: "done" });
    } catch (err) {
      setOrder(db, orderId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return { ok: true };
}
