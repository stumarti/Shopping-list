export type CatalogItem = { id: number; name: string; category: string; custom: boolean };
export type ListItem = { id: number; name: string; category: string; qty: number; note: string; done: boolean };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail : "Something went wrong. Try again.";
    throw new Error(detail);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  categories: () => call<string[]>("/categories"),
  catalog: () => call<CatalogItem[]>("/catalog"),
  list: () => call<ListItem[]>("/list"),
  add: (name: string, category: string, qty = 1) => call<ListItem>("/list", json("POST", { name, category, qty })),
  change: (id: number, change: Partial<Pick<ListItem, "qty" | "done" | "note">>) =>
    call<ListItem>(`/list/${id}`, json("PATCH", change)),
  remove: (id: number) => call<void>(`/list/${id}`, { method: "DELETE" }),
  clearDone: () => call<{ removed: number }>("/list/clear-done", { method: "POST" }),
  forget: (id: number) => call<void>(`/catalog/${id}`, { method: "DELETE" }),
};
