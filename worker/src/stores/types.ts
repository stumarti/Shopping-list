import type { Page } from "playwright";

/** A product on a store's site that could go in the basket. */
export interface Candidate {
  /** Whatever the adapter needs to add this exact product later (product id, URL…). */
  ref: string;
  name: string;
  price: number | null;
  memberPrice: number | null;
  size: string | null;
  available: boolean;
}

export interface Slot {
  kind: "delivery" | "collect";
  /** As the store shows it, e.g. "Sat 18 Oct, 14:00–15:00". */
  label: string;
}

/**
 * Everything the ordering flow needs from one store. Each method gets a page in that person's
 * signed-in browser profile. Adapters for real stores live next to this file; see docs/STORE-AUTOMATION.md.
 */
export interface StoreAdapter {
  id: string;
  name: string;
  /** False until the adapter has been written against the live site. */
  ordering: boolean;
  signInUrl: string;
  /** Opened after the order is filled, to check out in the browser or the store's app. */
  basketUrl: string;
  isSignedIn(page: Page): Promise<boolean>;
  /** The booked slot, or null when none is booked. */
  getSlot(page: Page): Promise<Slot | null>;
  search(page: Page, query: string): Promise<Candidate[]>;
  /** Put `qty` of this product in the basket. Throws with a readable message on failure. */
  addToBasket(page: Page, candidate: Candidate, qty: number): Promise<void>;
}

export class NotReadyError extends Error {
  constructor(store: string) {
    super(`Online ordering for ${store} isn't set up yet. It needs finishing against the live site (see docs/STORE-AUTOMATION.md).`);
  }
}
