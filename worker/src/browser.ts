import { ANON, type SessionManager } from "./sessions.js";
import { buildSearchUrl, cleanPageText, type StoreId } from "./stores/search-urls.js";

export interface PageFetcher {
  search(store: StoreId, query: string): Promise<{ url: string; text: string }>;
}

// Buttons cookie banners commonly use; clicking one is enough for the results to show.
export const CONSENT = /^(accept all( cookies)?|accept( cookies)?|allow all( cookies)?|i accept|agree|ok)$/i;

/** Anonymous search-page text for read-only price checks. */
export class PlaywrightFetcher implements PageFetcher {
  constructor(
    private urls: Record<StoreId, string>,
    private sessions: SessionManager,
  ) {}

  async search(store: StoreId, query: string) {
    const url = buildSearchUrl(this.urls[store], query);
    const page = await (await this.sessions.context(ANON, store)).newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const consent = page.getByRole("button", { name: CONSENT }).first();
      if (await consent.isVisible({ timeout: 3000 }).catch(() => false)) {
        await consent.click().catch(() => {});
      }
      // Results are rendered client-side; give them time, and scroll once for lazy-loaded tiles.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.mouse.wheel(0, 2500).catch(() => {});
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return { url: page.url(), text: cleanPageText(text) };
    } finally {
      await page.close().catch(() => {});
    }
  }
}
