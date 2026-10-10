import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";

/** Price checks browse anonymously under this owner; signed-in sessions belong to a person's id. */
export const ANON = "_anon";

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export type Launch = (dir: string) => Promise<BrowserContext>;

export const defaultLaunch: Launch = (dir) =>
  chromium.launchPersistentContext(dir, {
    headless: process.env.HEADLESS !== "0",
    locale: "en-IE",
    timezoneId: "Europe/Dublin",
    viewport: { width: 1280, height: 900 },
    // For running outside Docker against a locally installed Chromium.
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });

/**
 * One persistent browser profile per person per store under PROFILE_DIR, so cookie consent, store
 * choice and a signed-in session survive restarts. Each person's store login stays separate.
 */
export class SessionManager {
  private contexts = new Map<string, Promise<BrowserContext>>();

  constructor(
    private profileDir: string,
    private launch: Launch = defaultLaunch,
  ) {}

  context(owner: string, store: string): Promise<BrowserContext> {
    if (!SAFE.test(owner) || !SAFE.test(store)) throw new Error("invalid session id");
    const key = `${owner}/${store}`;
    let ctx = this.contexts.get(key);
    if (!ctx) {
      const dir = join(this.profileDir, owner, store);
      mkdirSync(dir, { recursive: true });
      ctx = this.launch(dir);
      ctx.catch(() => this.contexts.delete(key));
      this.contexts.set(key, ctx);
    }
    return ctx;
  }

  async close() {
    await Promise.all([...this.contexts.values()].map((c) => c.then((ctx) => ctx.close()).catch(() => {})));
    this.contexts.clear();
  }
}
