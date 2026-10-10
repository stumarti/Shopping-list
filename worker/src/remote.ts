import type { Page } from "playwright";
import type { SessionManager } from "./sessions.js";

/** Phone-shaped, so the screenshots fit the app without zooming. */
export const VIEW = { width: 390, height: 720 };

export type RemoteInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: "Enter" | "Tab" | "Backspace" | "Escape" }
  | { type: "scroll"; dy: number }
  | { type: "back" };

/**
 * A live view of the worker's browser, shown in the app as a stream of screenshots, so each person
 * signs in to their own store account themselves (including any one-time codes). The worker keeps the
 * resulting session cookies in that person's profile; it never sees or stores a password separately.
 */
export class RemoteView {
  private pages = new Map<string, Page>();

  constructor(private sessions: SessionManager) {}

  private key(owner: string, store: string) {
    return `${owner}/${store}`;
  }

  async open(owner: string, store: string, url: string) {
    await this.close(owner, store);
    const page = await (await this.sessions.context(owner, store)).newPage();
    await page.setViewportSize(VIEW);
    this.pages.set(this.key(owner, store), page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    return VIEW;
  }

  private page(owner: string, store: string): Page {
    const page = this.pages.get(this.key(owner, store));
    if (!page || page.isClosed()) throw new Error("No sign-in view open. Start linking the account again.");
    return page;
  }

  async screenshot(owner: string, store: string): Promise<Buffer> {
    return this.page(owner, store).screenshot({ type: "jpeg", quality: 60 });
  }

  async input(owner: string, store: string, ev: RemoteInput) {
    const page = this.page(owner, store);
    switch (ev.type) {
      case "click":
        await page.mouse.click(Math.round(ev.x), Math.round(ev.y));
        break;
      case "type":
        await page.keyboard.type(ev.text, { delay: 20 });
        break;
      case "key":
        await page.keyboard.press(ev.key);
        break;
      case "scroll":
        await page.mouse.wheel(0, ev.dy);
        break;
      case "back":
        await page.goBack({ timeout: 15_000 }).catch(() => {});
        break;
    }
    // Let the page react before the next screenshot.
    await page.waitForTimeout(250);
  }

  async close(owner: string, store: string) {
    const page = this.pages.get(this.key(owner, store));
    this.pages.delete(this.key(owner, store));
    await page?.close().catch(() => {});
  }
}
