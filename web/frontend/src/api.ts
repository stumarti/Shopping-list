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
  /** Grams per pack. */
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  /** The food pyramid shelf you set ("" until you do), and the one guessed from its name and aisle. */
  food_group: string;
  food_group_guess: string;
  /** Never swap it for a cheaper or in-stock alternative. */
  exact: boolean;
  /** For a generic item: the average of its kinds' figures, used wherever it has none of its own. */
  kinds_average: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null } | null;
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
export type NutritionStatus = {
  running: boolean;
  total: number;
  done: number;
  waiting: number;
  current: string | null;
  error: string | null;
  filled: { catalog_id: number; name: string; filled: string[]; basis: string; kcal?: number; protein?: number; carbs?: number; fat?: number }[];
};
export type NutritionResult = { item: CatalogItem; found: boolean; filled: string[]; basis: string | null };
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
  stores: { id: string; name: string; home: string; search: string }[];
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
  /** generic: the generic item with all its kinds (the default); exact: just this product. */
  view: "generic" | "exact";
  summary: ItemSummary;
  /** Set when the timing covers a generic item and its kinds (this item is one of them, or has some). */
  kind: { id: number; name: string; kinds: number } | null;
  /** For a kind: how often this product itself was bought. */
  product: { trips: number; last_bought: string | null } | null;
  /** For a generic item with kinds: each kind's own count and price. */
  by_kind: { id: number; name: string; trips: number; last_bought: string; price: PriceSummary | null }[];
  /** shopped: whether you did any shopping at all that week. */
  weekly: { week: string; qty: number; trips: number; kinds?: string[]; shopped?: boolean }[];
  /** What you've spent on it, in euro. */
  spend: number;
  purchases: {
    store: string;
    bought_on: string;
    bought_at: string;
    bought_as: string;
    qty: number;
    unit_price: number | null;
    source: string;
    /** Which product (kind) it was. */
    catalog_id: number;
    kind_name: string;
  }[];
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
  /** Grams per pack, when known. */
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  /** Its food pyramid shelf; "" when it isn't food. */
  food_group: string;
};
export type BasketCheckItem = {
  id: number;
  /** The item on your list it's for (or what Claude called it, when it didn't match). */
  item: string;
  status: "added" | "swapped" | "missing";
  product: string;
  url: string;
  qty: number | null;
  note: string;
  catalog_id: number | null;
  /** Its product link was saved for the item; kept: a swap kept as the product from now on. */
  link_saved: boolean;
  kept: boolean;
};
export type BasketCheck = {
  id: number;
  store: string;
  shop_date: string | null;
  checked_at: string;
  total: string;
  items: BasketCheckItem[];
  /** On the shop, but Claude didn't say what it did. */
  unreported: string[];
  counts: { added: number; swapped: number; missing: number };
} | null;
export type ForgotItem = { catalog_id: number; name: string; category: string; qty: number; trips: number; reason: string };
export type Forgotten = { regulars: ForgotItem[]; due_soon: ForgotItem[] };
export type FoodGroup = { id: string; name: string; advice: string };
export type PriceMove = {
  catalog_id: number;
  name: string;
  before: number;
  after: number;
  change: number;
  /** How many you buy a month, and what the change adds (or saves) a month at that rate. */
  per_month: number;
  impact: number;
};
export type Spending = {
  total: number;
  from: string;
  to: string;
  trips: number;
  weeks: number;
  a_shop: number;
  a_week: number;
  months: { month: string; spend: number; trips: number }[];
  prices: { change: number; products: number; impact: number; up: PriceMove[]; down: PriceMove[] } | null;
  /** Your grocery price index by month: 100 is what things cost when you first bought them. */
  index: { month: string; index: number; products: number }[];
} | null;
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
  /** Weeks with any shopping, and calories bought a week over those weeks only. */
  weeks: number;
  kcal_week: number | null;
  aisles: TypicalAisle[];
} | null;
export type NextShop = {
  shop: { date: string; every_days: number; last_shop: string; reason: string } | null;
  items: ShopItem[];
  /** Not sure you'll need these: they're out of the shop until you add them. */
  maybe: ShopItem[];
  skipped: ShopItem[];
};
/** A change to a common item. group: the generic item it's a kind of ("" for none); or_set: its pick-one set. */
export type CommonChange = Partial<Pick<CatalogItem, "name" | "category" | "barcode" | "kcal" | "protein" | "carbs" | "fat" | "food_group" | "exact">> & {
  group?: string;
  or_set?: string;
};
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
  /** exact: just this product, instead of its generic item with every kind (the default). */
  itemHistory: (catalogId: number, exact = false) => call<ItemHistory>(`/history/items/${catalogId}${exact ? "?exact=true" : ""}`),
  /** Tesco's Clubcard data export, sent exactly as downloaded (.json or .zip). */
  /** A shop you did yourself, so the history and the next shop move on. */
  recordShop: (store: string, date: string, items: { name: string; qty: number; price: number | null }[]) =>
    call<{ order_ref: string; store: string; bought_on: string; products: number; new_common_items: number; cleared_from_list: number }>(
      "/history/manual",
      json("POST", { store, date, items }),
    ),
  forgetRecordedShop: (orderRef: string) => call<void>(`/history/manual/${encodeURIComponent(orderRef)}`, { method: "DELETE" }),
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
  /** Calories and macros per pack from Open Food Facts, by the item's barcode (only empty ones, unless overwrite). */
  fillNutrition: (catalogId: number, overwrite = false) => call<NutritionResult>(`/catalog/${catalogId}/nutrition`, json("POST", { overwrite })),
  mcpInfo: () => call<{ path: string; token_required: boolean }>("/mcp"),
  nutritionStatus: () => call<NutritionStatus>("/nutrition/fill"),
  fillAllNutrition: (retry: boolean) => call<NutritionStatus>("/nutrition/fill", json("POST", { retry })),
  stopFillingNutrition: () => call<NutritionStatus>("/nutrition/fill/stop", { method: "POST" }),
  nextShop: () => call<NextShop>("/next-shop"),
  /** Pick one option of a pick-one set for the next shop (null to unpick). */
  chooseForShop: (setId: number, catalogId: number | null) =>
    call<NextShop>(`/next-shop/choose/${setId}`, json("POST", { catalog_id: catalogId })),
  typicalShop: () => call<TypicalShop>("/typical-shop"),
  /** exact: price changes per product, instead of per generic item (the default). */
  spending: (exact = false) => call<Spending>(`/spending${exact ? "?exact=true" : ""}`),
  /** Regulars and things due soon that aren't on the next shop. */
  forgotten: () => call<Forgotten>("/next-shop/forgotten"),
  /** Claude in Chrome's reply, pasted back: what's in the basket, swapped and missing. */
  checkBasket: (store: string, text: string) => call<BasketCheck>(`/basket/${store}/check`, json("POST", { text })),
  basketCheck: (store: string) => call<BasketCheck>(`/basket/${store}/check`),
  clearBasketCheck: (store: string) => call<void>(`/basket/${store}/check`, { method: "DELETE" }),
  keepSwap: (itemId: number) => call<BasketCheck>(`/basket/check-items/${itemId}/keep`, { method: "POST" }),
  foodGroups: () => call<FoodGroup[]>("/food-groups"),
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
