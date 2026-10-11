export type StoreId = "tesco" | "dunnes";

/**
 * Search page for each store. {q} is replaced with the URL-encoded query.
 * Override with TESCO_SEARCH_URL / DUNNES_SEARCH_URL if a store changes its URLs. Dunnes' online shop
 * is per-branch: open it in a browser, pick your store, search for anything, and copy that URL with {q}
 * in place of your search term.
 */
export const DEFAULT_SEARCH_URLS: Record<StoreId, string> = {
  tesco: "https://www.tesco.ie/groceries/en-IE/search?query={q}",
  dunnes: "https://www.dunnesstoresgrocery.com/sm/delivery/rsid/258/results?q={q}",
};

export function searchUrls(env: NodeJS.ProcessEnv = process.env): Record<StoreId, string> {
  return {
    tesco: env.TESCO_SEARCH_URL || DEFAULT_SEARCH_URLS.tesco,
    dunnes: env.DUNNES_SEARCH_URL || DEFAULT_SEARCH_URLS.dunnes,
  };
}

export function buildSearchUrl(template: string, query: string): string {
  return template.replace("{q}", encodeURIComponent(query.trim()));
}

/** Collapse whitespace and blank lines, and cap the size of what goes back to the server. */
export function cleanPageText(text: string, maxChars = 60_000): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars);
}
