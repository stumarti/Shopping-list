export type StoreProduct = { url: string; title: string };
export type Products = Partial<Record<string, StoreProduct>>;
export type CatalogItem = {
  id: number;
  name: string;
  category: string;
  custom: boolean;
  barcode: string;
  barcode_source: string;
  /** "item"; "group": a generic item with kinds under it; "or": a pick-one set (never bought itself). */
  kind: "item" | "group" | "or";
  /** The generic item this is a kind of. */
  group_id: number | null;
  /** The pick-one set this is in. */
  or_id: number | null;
  /** Calories per pack. */
  kcal: number | null;
  /** Shopping trips it was on (a generic item counts its kinds'). */
  trips: number;
  products: Products;
};
export type Aisle = { id: number; name: string; items: number; fallback: boolean };
export type FinderStatus = {
  running: boolean;
  total: number;
  done: number;
  waiting: number;
  current: string | null;
  error: string | null;
  found: { catalog_id: number; name: string; barcode: string; product: string; source: string }[];
};
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
export type PriceSummary = { now: number; now_on: string; first: number; first_on: string; low: number; high: number };
export type ItemSummary = {
  trips: number;
  first_bought: string;
  last_bought: string;
  every_days: number | null;
  usual_qty: number;
  next_expected: string | null;
  price: PriceSummary | null;
};
export type UsualItem = ItemSummary & { catalog_id: number; name: string; category: string; orders: number };
export type Suggestion = UsualItem & { reason: string; qty: number };
export type History = {
  orders: { store: string; order_ref: string; bought_on: string; products: number; units: number; source: string }[];
  usual: UsualItem[];
  suggestions: { will: Suggestion[]; might: Suggestion[]; extras: Suggestion[] };
};
export type ItemHistory = {
  item: { id: number; name: string };
  summary: ItemSummary;
  weekly: { week: string; qty: number; trips: number }[];
  purchases: { store: string; bought_on: string; bought_at: string; bought_as: string; qty: number; unit_price: number | null; source: string }[];
};
export type ClubcardResult = {
  trips: number;
  new_trips: number;
  already_imported: number;
  lines: number;
  new_common_items: number;
  not_groceries: number;
  from: string;
  to: string;
  saved_as: string;
};
export type ShopOption = { catalog_id: number; name: string; trips: number; due: boolean; qty: number; kcal: number | null };
export type ShopItem = {
  catalog_id: number | null;
  list_item_id: number | null;
  name: string;
  category: string;
  qty: number;
  badge: "weekly" | "scheduled" | "unsure" | "added";
  label: string;
  detail: string;
  trips: number;
  kind: "item" | "or";
  /** Calories per pack; a pick-one set not yet picked gives its options' range. */
  kcal_low: number | null;
  kcal_high: number | null;
  /** A pick-one set's options, most bought first, and the one picked for this shop. */
  options: ShopOption[] | null;
  chosen: number | null;
};
export type TypicalAisle = { aisle: string; products: number; units: number; spend: number | null; kcal: number | null; top: string[] };
export type TypicalShop = {
  trips: number;
  from: string;
  to: string;
  products: number;
  units: number;
  spend: number | null;
  kcal: number | null;
  kcal_known: number;
  aisles: TypicalAisle[];
} | null;
export type NextShop = {
  shop: { date: string; every_days: number; last_shop: string; reason: string } | null;
  items: ShopItem[];
  skipped: ShopItem[];
};
/** A change to a common item. group: the generic item it's a kind of ("" for none); or_set: its pick-one set. */
export type CommonChange = Partial<Pick<CatalogItem, "name" | "category" | "barcode" | "kcal">> & { group?: string; or_set?: string };
export type Product = { barcode: string; name: string; brand: string; quantity: string; category: string; source: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.headers ?? (init?.body ? { "Content-Type": "application/json" } : undefined),
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
  itemHistory: (catalogId: number) => call<ItemHistory>(`/history/items/${catalogId}`),
  /** Tesco's Clubcard data export, sent exactly as downloaded (.json or .zip). */
  importClubcard: (file: File) =>
    call<ClubcardResult>("/history/tesco/clubcard", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } }),
  barcode: (code: string) => call<Product>(`/barcode/${encodeURIComponent(code)}`),
  add: (name: string, category: string, qty = 1, barcode = "") =>
    call<ListItem>("/list", json("POST", { name, category, qty, barcode })),
  change: (id: number, change: Partial<Pick<ListItem, "qty" | "done" | "note">>) =>
    call<ListItem>(`/list/${id}`, json("PATCH", change)),
  remove: (id: number) => call<void>(`/list/${id}`, { method: "DELETE" }),
  clearDone: () => call<{ removed: number }>("/list/clear-done", { method: "POST" }),
  forget: (id: number) => call<void>(`/catalog/${id}`, { method: "DELETE" }),
  editCommon: (id: number, change: CommonChange) =>
    call<CatalogItem>(`/catalog/${id}`, json("PATCH", change)),
  setProduct: (catalogId: number, store: string, url: string) =>
    call<CatalogItem>(`/catalog/${catalogId}/products/${store}`, json("PUT", { url })),
  /** Save a product for an item on the list (creates its common item if it was deleted). */
  linkItem: (itemId: number, store: string, url: string) =>
    call<CatalogItem>(`/basket/${store}/link`, json("POST", { item_id: itemId, url })),
  forgetProduct: (catalogId: number, store: string) =>
    call<CatalogItem>(`/catalog/${catalogId}/products/${store}`, { method: "DELETE" }),
  aisles: () => call<Aisle[]>("/aisles"),
  addAisle: (name: string) => call<Aisle>("/aisles", json("POST", { name })),
  renameAisle: (id: number, name: string) => call<Aisle>(`/aisles/${id}`, json("PATCH", { name })),
  orderAisles: (ids: number[]) => call<Aisle[]>("/aisles/order", json("PUT", { ids })),
  removeAisle: (id: number, moveTo: number | null) =>
    call<Aisle[]>(`/aisles/${id}${moveTo ? `?move_to=${moveTo}` : ""}`, { method: "DELETE" }),
  finder: () => call<FinderStatus>("/barcodes/find"),
  findBarcodes: (retry = false) => call<FinderStatus>("/barcodes/find", json("POST", { retry })),
  stopFinding: () => call<FinderStatus>("/barcodes/find/stop", { method: "POST" }),
  nextShop: () => call<NextShop>("/next-shop"),
  /** Pick one option of a pick-one set for the next shop (null to unpick). */
  chooseForShop: (setId: number, catalogId: number | null) =>
    call<NextShop>(`/next-shop/choose/${setId}`, json("POST", { catalog_id: catalogId })),
  typicalShop: () => call<TypicalShop>("/typical-shop"),
  skipForShop: (catalogId: number) => call<NextShop>(`/next-shop/skip/${catalogId}`, { method: "POST" }),
  unskipForShop: (catalogId: number) => call<NextShop>(`/next-shop/skip/${catalogId}`, { method: "DELETE" }),
  clearCommon: () => call<{ removed: number }>("/catalog/clear", { method: "POST" }),
  rebuildCommon: () => call<{ added: number; purchases: number }>("/catalog/rebuild", { method: "POST" }),
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
