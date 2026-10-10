import type { DB } from "./db.js";
import { categorize, sectionFromOffTags } from "./sections.js";

export interface Product {
  barcode: string;
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
  source: OpenFactsSource | "photo" | "manual";
}

export type FetchFn = typeof fetch;

const USER_AGENT = "ShoppingList/0.1 (self-hosted personal app)";

export function getCachedProduct(db: DB, barcode: string): Product | null {
  const r = db.prepare("SELECT * FROM products WHERE barcode = ?").get(barcode) as Record<string, string> | undefined;
  if (!r) return null;
  return {
    barcode: r.barcode,
    name: r.name,
    brand: r.brand ?? null,
    size: r.size ?? null,
    sectionId: r.section_id,
    source: r.source as Product["source"],
  };
}

export function rememberProduct(db: DB, p: Product): void {
  db.prepare(`
    INSERT INTO products (barcode, name, brand, size, section_id, source, updated_at)
    VALUES (@barcode, @name, @brand, @size, @sectionId, @source, @at)
    ON CONFLICT(barcode) DO UPDATE SET name = excluded.name, brand = excluded.brand, size = excluded.size,
      section_id = excluded.section_id, source = excluded.source, updated_at = excluded.updated_at
  `).run({ ...p, at: Date.now() });
}

/**
 * The Open Food Facts family: one free, open database per kind of product, all with the same API.
 * Searched in order, so food (by far the most common scan) is tried first.
 */
export const OPEN_FACTS = [
  { source: "openfoodfacts", host: "world.openfoodfacts.org", section: null },
  { source: "openbeautyfacts", host: "world.openbeautyfacts.org", section: "health" },
  { source: "openproductsfacts", host: "world.openproductsfacts.org", section: "household" },
  { source: "openpetfoodfacts", host: "world.openpetfoodfacts.org", section: "other" },
] as const;

export type OpenFactsSource = (typeof OPEN_FACTS)[number]["source"];

async function lookupOne(db: (typeof OPEN_FACTS)[number], barcode: string, fetchFn: FetchFn): Promise<Product | null> {
  const url =
    `https://${db.host}/api/v2/product/${encodeURIComponent(barcode)}.json` +
    `?fields=product_name,product_name_en,generic_name,brands,quantity,categories_tags`;
  const res = await fetchFn(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${db.host} returned ${res.status}`);
  const body = (await res.json()) as {
    status?: number;
    product?: {
      product_name?: string;
      product_name_en?: string;
      generic_name?: string;
      brands?: string;
      quantity?: string;
      categories_tags?: string[];
    };
  };
  const p = body.product;
  const name = (p?.product_name_en || p?.product_name || p?.generic_name || "").trim();
  if (body.status !== 1 || !p || !name) return null;
  return {
    barcode,
    name,
    brand: p.brands?.split(",")[0]?.trim() || null,
    size: p.quantity?.trim() || null,
    sectionId: db.section ?? sectionFromOffTags(p.categories_tags) ?? categorize(name),
    source: db.source,
  };
}

/** Tries each Open Facts database in turn. Fails only if none answered and one was unreachable. */
export async function lookupOpenFacts(barcode: string, fetchFn: FetchFn = fetch): Promise<Product | null> {
  let failure: unknown = null;
  for (const db of OPEN_FACTS) {
    try {
      const found = await lookupOne(db, barcode, fetchFn);
      if (found) return found;
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return null;
}

/** Local cache first (includes barcodes you identified by photo), then the Open Facts databases. */
export async function lookupBarcode(db: DB, barcode: string, fetchFn: FetchFn = fetch): Promise<Product | null> {
  const cached = getCachedProduct(db, barcode);
  if (cached) return cached;
  const found = await lookupOpenFacts(barcode, fetchFn);
  if (found) rememberProduct(db, found);
  return found;
}
