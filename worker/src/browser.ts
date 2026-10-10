import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { buildSearchUrl, cleanPageText, type StoreId } from "./stores.js";

export interface PageFetcher {
  search(store: StoreId, query: string): Promise<{ url: string; text: string }>;
}

// Buttons cookie banners commonly use; clicking one is enough for the results to show.
const CONSENT = /^(accept all( cookies)?|accept( cookies)?|allow all( cookies)?|i accept|agree|ok)$/i;

/**
 * One persistent browser profile per store (kept under PROFILE_DIR), so cookie consent, store choice
 * and, later, a signed-in session survive restarts.
 */
export class PlaywrightFetcher implements PageFetcher {
  private contexts = new Map<StoreId, Promise<BrowserContext>>();

  constructor(
    private urls: Record<StoreId, string>,
    private profileDir: string,
    private headless = true,
  ) {}

  private context(store: StoreId): Promise<BrowserContext> {
    let ctx = this.contexts.get(store);
    if (!ctx) {
      const dir = join(this.profileDir, store);
      mkdirSync(dir, { recursive: true });
      ctx = chromium.launchPersistentContext(dir, {
        headless: this.headless,
        locale: "en-IE",
        timezoneId: "Europe/Dublin",
        viewport: { width: 1280, height: 900 },
        // For running outside Docker against a locally installed Chromium.
        executablePath: process.env.CHROMIUM_PATH || undefined,
      });
      ctx.catch(() => this.contexts.delete(store));
      this.contexts.set(store, ctx);
    }
    return ctx;
  }

  async search(store: StoreId, query: string) {
    const url = buildSearchUrl(this.urls[store], query);
    const page = await (await this.context(store)).newPage();
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

  async close() {
    await Promise.all([...this.contexts.values()].map((c) => c.then((ctx) => ctx.close()).catch(() => {})));
  }
}
