export type StoreProduct = { url: string; title: string };
export type Products = Partial<Record<string, StoreProduct>>;
export type CatalogItem = { id: number; name: string; category: string; custom: boolean; barcode: string; products: Products };
export type ListItem = {
  id: number;
  name: string;
  category: string;
  qty: number;
  note: string;
  done: boolean;
  barcode: string;
  catalog_id: number | null;
  products: Products;
};
export type Links = {
  stores: { id: string; name: string; search: string }[];
  barcodes: { name: string; product: string; search: string };
};
export type History = {
  orders: { store: string; order_ref: string; bought_on: string; products: number; units: number }[];
  usual: { catalog_id: number; name: string; category: string; orders: number; last_bought: string; usual_qty: number }[];
};
export type Product = { barcode: string; name: string; brand: string; quantity: string; category: string; source: string };

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
  links: () => call<Links>("/links"),
  history: () => call<History>("/history"),
  barcode: (code: string) => call<Product>(`/barcode/${encodeURIComponent(code)}`),
  add: (name: string, category: string, qty = 1, barcode = "") =>
    call<ListItem>("/list", json("POST", { name, category, qty, barcode })),
  change: (id: number, change: Partial<Pick<ListItem, "qty" | "done" | "note">>) =>
    call<ListItem>(`/list/${id}`, json("PATCH", change)),
  remove: (id: number) => call<void>(`/list/${id}`, { method: "DELETE" }),
  clearDone: () => call<{ removed: number }>("/list/clear-done", { method: "POST" }),
  forget: (id: number) => call<void>(`/catalog/${id}`, { method: "DELETE" }),
  editCommon: (id: number, change: Partial<Pick<CatalogItem, "name" | "category" | "barcode">>) =>
    call<CatalogItem>(`/catalog/${id}`, json("PATCH", change)),
  setProduct: (catalogId: number, store: string, url: string) =>
    call<CatalogItem>(`/catalog/${catalogId}/products/${store}`, json("PUT", { url })),
  /** Save a product for an item on the list (creates its common item if it was deleted). */
  linkItem: (itemId: number, store: string, url: string) =>
    call<CatalogItem>(`/basket/${store}/link`, json("POST", { item_id: itemId, url })),
  forgetProduct: (catalogId: number, store: string) =>
    call<CatalogItem>(`/catalog/${catalogId}/products/${store}`, { method: "DELETE" }),
  addCommon: (text: string, category: string) =>
    call<{ added: string[]; skipped: string[] }>("/catalog/bulk", json("POST", { text, category })),
};

export const isBarcode = (text: string) => /^\d{8,14}$/.test(text.trim());

/** Fill a link template's {q} or {code}. */
export const fillLink = (template: string, value: string) =>
  template.replace("{q}", encodeURIComponent(value.trim())).replace("{code}", encodeURIComponent(value.trim()));

export function itemLinks(links: Links | null, item: { name: string; barcode: string }) {
  if (!links) return [];
  return [
    ...links.stores.map((s) => ({ label: s.name, href: fillLink(s.search, item.name), title: `Search ${s.name} for ${item.name}` })),
    item.barcode
      ? { label: "Barcode", href: fillLink(links.barcodes.product, item.barcode), title: `${item.barcode} on ${links.barcodes.name}` }
      : { label: "Barcode", href: fillLink(links.barcodes.search, item.name), title: `Find ${item.name} on ${links.barcodes.name}` },
  ];
}
