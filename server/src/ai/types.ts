import type { Section } from "../sections.js";

export interface Identified {
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
  confidence: "low" | "medium" | "high";
}

export interface ParsedItem {
  name: string;
  qty: number;
  brand: string | null;
  size: string | null;
  sectionId: string;
}

export interface WantedItem {
  name: string;
  brand: string | null;
  size: string | null;
}

/** One product as listed on a supermarket website. Prices in euro. */
export interface Offer {
  name: string;
  price: number;
  /** Lower price for loyalty-card members (e.g. Tesco Clubcard), if shown. */
  memberPrice: number | null;
  unitPrice: number | null;
  unitLabel: string | null;
  promo: string | null;
}

export interface OfferMatch {
  match: Offer | null;
  confidence: "low" | "medium" | "high";
}

/** A product found on a store's site while filling a basket. */
export interface StoreProduct {
  ref: string;
  name: string;
  size: string | null;
  price: number | null;
  available: boolean;
}

export interface Classified {
  /** Index into the candidates of the product that IS the item (same brand, product and size), or null. */
  exact: number | null;
  /** Up to five next-best substitutes, best first, as indexes into the candidates. */
  similar: number[];
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

/** The AI jobs the server needs. Claude, a local Ollama model, or a chain of both implement it. */
export interface Assistant {
  readonly name: string;
  identifyPhoto(imageBase64: string, mediaType: ImageMediaType, sections: Section[]): Promise<Identified>;
  parseText(text: string, sections: Section[]): Promise<ParsedItem[]>;
  /** Pick the product on a store's search-results page that best matches a list item. */
  matchOffer(item: WantedItem, store: string, pageText: string): Promise<OfferMatch>;
  /** Decide which search result is exactly the list item, and rank the rest as substitutes. */
  classify(item: WantedItem, candidates: StoreProduct[]): Promise<Classified>;
}

export class NotUnderstoodError extends Error {}
