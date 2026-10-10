import Constants from "expo-constants";
import type { Item, List, ListState, Op, Section } from "./ops";

export interface Connection {
  serverUrl: string;
  token: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  name: string;
}

export interface Person extends User {
  devices: number;
  lastSeen: number | null;
  isMe: boolean;
}

export interface ActiveTrip {
  id: string;
  listId: string;
  userId: string;
  name: string;
  startedAt: number;
  ticked: number;
}

export interface ServerState extends ListState {
  lists: List[];
  sections: Section[];
  items: Item[];
  activeTrips: ActiveTrip[];
  serverTime: number;
}

export interface Product {
  barcode: string;
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
}

export interface Identified {
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
  confidence: "low" | "medium" | "high";
}

export interface ParsedItem {
  name: string;
  qty: number;
  brand: string | null;
  size: string | null;
  sectionId: string;
}

export interface Suggestion {
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
  timesBought: number;
  lastBoughtDaysAgo: number;
  usualEveryDays: number;
}

export interface TripSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  items: Array<{ name: string; brand: string | null; size: string | null; qty: number }>;
}

export interface PastTrip extends TripSummary {
  shopper: string;
  count: number;
}

export interface Health {
  ok: boolean;
  version?: string;
  ai?: { backend: string; name: string } | null;
  priceCheck?: boolean;
  onlineOrdering?: boolean;
  stores?: Array<{ id: string; name: string }>;
}

export interface Offer {
  name: string;
  price: number;
  memberPrice: number | null;
  unitPrice: number | null;
  unitLabel: string | null;
  promo: string | null;
}

export interface CheckedItem {
  itemId: string;
  name: string;
  qty: number;
  query: string;
  match: Offer | null;
  confidence: "low" | "medium" | "high" | null;
  lineTotal: number | null;
  error?: string;
}

export interface PriceCheck {
  id: string;
  listId: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  stores: Array<{ id: string; name: string; items: CheckedItem[]; total: number; found: number; missing: number }>;
  comparison: { items: number; totals: Record<string, number>; cheapest: string | null; saving: number } | null;
  progress: { done: number; total: number };
}

export interface OnlineStore {
  id: string;
  name: string;
  ordering: boolean;
  basketUrl: string;
}

export interface Slot {
  kind: "delivery" | "collect";
  label: string;
}

export interface StoreProduct {
  ref: string;
  name: string;
  size: string | null;
  price: number | null;
  memberPrice: number | null;
  available: boolean;
}

export type LineStatus = "pending" | "exact" | "choose" | "chosen" | "not_found" | "skipped" | "added" | "failed";

export interface OrderLine {
  itemId: string;
  name: string;
  brand: string | null;
  size: string | null;
  qty: number;
  status: LineStatus;
  chosen: StoreProduct | null;
  options: StoreProduct[];
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

export type RemoteInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: "Enter" | "Tab" | "Backspace" | "Escape" }
  | { type: "scroll"; dy: number }
  | { type: "back" };

export function baseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function deviceName(): string {
  return Constants.deviceName ?? "Phone";
}

export class ConflictError extends ApiError {
  constructor(
    message: string,
    public code: string | undefined,
  ) {
    super(409, message);
  }
}

async function request<T>(conn: Connection, path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<T> {
  if (!conn.serverUrl.trim()) throw new ApiError(0, "Set up your home server first.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(baseUrl(conn.serverUrl) + path, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}) },
    });
  } catch {
    throw new ApiError(0, "Can't reach your home server.");
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (res.status === 409) throw new ConflictError(body.error ?? "Conflict", body.code);
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Server error ${res.status}`);
  return body as T;
}

const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  setup: (c: Connection, setupToken: string, name: string) =>
    request<{ user: User; token: string }>(c, "/api/setup", post({ setupToken, name, device: deviceName() })),
  join: (c: Connection, code: string, name?: string) =>
    request<{ user: User; token: string }>(c, "/api/join", post({ code, name, device: deviceName() })),
  me: (c: Connection) => request<{ user: User; people: Person[] }>(c, "/api/me"),
  rename: (c: Connection, name: string) => request<{ ok: true }>(c, "/api/me", { method: "PATCH", body: JSON.stringify({ name }) }),
  invite: (c: Connection, forMe: boolean) => request<{ code: string; expiresAt: number }>(c, "/api/invites", post({ forMe })),
  logout: (c: Connection) => request<{ ok: true }>(c, "/api/logout", post()),
  revoke: (c: Connection, userId: string) => request<{ ok: true }>(c, `/api/people/${encodeURIComponent(userId)}/revoke`, post()),

  sync: (c: Connection, ops: Op[]) => request<ServerState>(c, "/api/sync", post({ ops })),

  startTrip: (c: Connection, listId: string) => request<{ id: string; startedAt: number }>(c, "/api/trips", post({ listId })),
  finishTrip: (c: Connection, id: string) => request<TripSummary>(c, `/api/trips/${encodeURIComponent(id)}/finish`, post()),
  history: (c: Connection, listId: string) => request<{ trips: PastTrip[] }>(c, `/api/lists/${encodeURIComponent(listId)}/history`),
  suggestions: (c: Connection, listId: string) =>
    request<{ suggestions: Suggestion[] }>(c, `/api/lists/${encodeURIComponent(listId)}/suggestions`),

  health: (c: Connection) => request<Health>(c, "/api/health"),

  startPriceCheck: (c: Connection, listId: string) =>
    request<{ id: string; alreadyRunning: boolean }>(c, `/api/lists/${encodeURIComponent(listId)}/price-check`, post()),
  latestPriceCheck: (c: Connection, listId: string) =>
    request<{ check: PriceCheck | null }>(c, `/api/lists/${encodeURIComponent(listId)}/price-check`),
  priceCheck: (c: Connection, id: string) => request<{ check: PriceCheck }>(c, `/api/price-checks/${encodeURIComponent(id)}`),

  onlineStores: (c: Connection) => request<{ stores: OnlineStore[] }>(c, "/api/online/stores"),
  onlineStatus: (c: Connection, store: string) => request<{ signedIn: boolean; slot: Slot | null }>(c, `/api/online/${store}/status`, {}, 60000),
  linkStart: (c: Connection, store: string) => request<{ view: { width: number; height: number } }>(c, `/api/online/${store}/link`, post(), 60000),
  linkInput: (c: Connection, store: string, event: RemoteInput) => request<{ ok: true }>(c, `/api/online/${store}/link/input`, post(event), 30000),
  linkDone: (c: Connection, store: string) => request<{ signedIn: boolean; slot: Slot | null }>(c, `/api/online/${store}/link/done`, post(), 60000),
  /** The live sign-in view as a data: URI, ready for <Image>. */
  async linkScreenshot(c: Connection, store: string): Promise<string> {
    const res = await fetch(`${baseUrl(c.serverUrl)}/api/online/${store}/link/screenshot`, { headers: { authorization: `Bearer ${c.token}` } });
    if (!res.ok) throw new ApiError(res.status, "No picture from the store yet");
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  },

  startOrder: (c: Connection, listId: string, store: string) => request<{ id: string }>(c, "/api/orders", post({ listId, store }), 60000),
  order: (c: Connection, id: string) => request<{ order: Order }>(c, `/api/orders/${encodeURIComponent(id)}`),
  latestOrder: (c: Connection, listId: string) => request<{ order: Order | null }>(c, `/api/orders?listId=${encodeURIComponent(listId)}`),
  changeLine: (c: Connection, id: string, itemId: string, change: { choose: string } | { skip: true } | { qty: number } | { search: string }) =>
    request<{ order: Order }>(c, `/api/orders/${encodeURIComponent(id)}/lines/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify(change) }, 60000),
  fillBasket: (c: Connection, id: string) => request<{ ok: true }>(c, `/api/orders/${encodeURIComponent(id)}/fill`, post()),

  barcode: (c: Connection, code: string) => request<{ found: boolean; product?: Product }>(c, `/api/barcode/${encodeURIComponent(code)}`),
  rememberBarcode: (c: Connection, code: string, p: Omit<Product, "barcode">) =>
    request<{ ok: true }>(c, `/api/barcode/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(p) }),
  identify: (c: Connection, image: string) => request<Identified>(c, "/api/identify", post({ image, mediaType: "image/jpeg" }), 60000),
  parse: (c: Connection, text: string) => request<{ items: ParsedItem[] }>(c, "/api/parse", post({ text }), 30000),
};
