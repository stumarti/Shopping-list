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

export function baseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function deviceName(): string {
  return Constants.deviceName ?? "Phone";
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
  const body = (await res.json().catch(() => ({}))) as { error?: string };
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

  barcode: (c: Connection, code: string) => request<{ found: boolean; product?: Product }>(c, `/api/barcode/${encodeURIComponent(code)}`),
  rememberBarcode: (c: Connection, code: string, p: Omit<Product, "barcode">) =>
    request<{ ok: true }>(c, `/api/barcode/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(p) }),
  identify: (c: Connection, image: string) => request<Identified>(c, "/api/identify", post({ image, mediaType: "image/jpeg" }), 60000),
  parse: (c: Connection, text: string) => request<{ items: ParsedItem[] }>(c, "/api/parse", post({ text }), 30000),
};
