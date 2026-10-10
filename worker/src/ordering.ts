import type { Page } from "playwright";
import type { SessionManager } from "./sessions.js";
import { NotReadyError, type Candidate, type Slot, type StoreAdapter } from "./stores/index.js";

export interface AddResult {
  ref: string;
  ok: boolean;
  error?: string;
}

/** Runs the store adapters inside each person's own signed-in browser profile. */
export class Ordering {
  constructor(
    private sessions: SessionManager,
    private adapters: Map<string, StoreAdapter>,
  ) {}

  adapter(store: string): StoreAdapter {
    const a = this.adapters.get(store);
    if (!a) throw new Error(`Unknown store "${store}"`);
    return a;
  }

  private async withPage<T>(owner: string, store: string, fn: (page: Page, a: StoreAdapter) => Promise<T>): Promise<T> {
    const a = this.adapter(store);
    if (!a.ordering) throw new NotReadyError(a.name);
    const page = await (await this.sessions.context(owner, store)).newPage();
    try {
      return await fn(page, a);
    } finally {
      await page.close().catch(() => {});
    }
  }

  signedIn(owner: string, store: string): Promise<boolean> {
    return this.withPage(owner, store, (page, a) => a.isSignedIn(page));
  }

  slot(owner: string, store: string): Promise<{ signedIn: boolean; slot: Slot | null }> {
    return this.withPage(owner, store, async (page, a) => {
      if (!(await a.isSignedIn(page))) return { signedIn: false, slot: null };
      return { signedIn: true, slot: await a.getSlot(page) };
    });
  }

  search(owner: string, store: string, query: string): Promise<Candidate[]> {
    return this.withPage(owner, store, (page, a) => a.search(page, query));
  }

  /** Adds items one by one and carries on past failures, reporting each. */
  add(owner: string, store: string, items: Array<{ candidate: Candidate; qty: number }>): Promise<AddResult[]> {
    return this.withPage(owner, store, async (page, a) => {
      const results: AddResult[] = [];
      for (const { candidate, qty } of items) {
        try {
          await a.addToBasket(page, candidate, qty);
          results.push({ ref: candidate.ref, ok: true });
        } catch (err) {
          results.push({ ref: candidate.ref, ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
        }
      }
      return results;
    });
  }
}
