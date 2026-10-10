import type { ListState, Op, Item } from "./ops";

export interface Settings {
  serverUrl: string;
  token: string;
  name: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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

export function baseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function request<T>(settings: Settings, path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<T> {
  if (!settings.serverUrl.trim()) throw new ApiError(0, "Set up your home server in Settings first.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(baseUrl(settings.serverUrl) + path, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.token.trim()}` },
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

export const api = {
  sync: (s: Settings, ops: Op[]) =>
    request<ListState & { serverTime: number }>(s, "/api/sync", { method: "POST", body: JSON.stringify({ ops }) }),

  barcode: (s: Settings, code: string) =>
    request<{ found: boolean; product?: Product }>(s, `/api/barcode/${encodeURIComponent(code)}`),

  rememberBarcode: (s: Settings, code: string, p: Omit<Product, "barcode">) =>
    request<{ ok: true }>(s, `/api/barcode/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(p) }),

  identify: (s: Settings, image: string) =>
    request<Identified>(s, "/api/identify", { method: "POST", body: JSON.stringify({ image, mediaType: "image/jpeg" }) }, 60000),

  parse: (s: Settings, text: string) =>
    request<{ items: ParsedItem[] }>(s, "/api/parse", { method: "POST", body: JSON.stringify({ text }) }, 30000),
};

export type { Item };
