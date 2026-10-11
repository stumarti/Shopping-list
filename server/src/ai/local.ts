import { categorize } from "../sections.js";
import type { ParsedItem } from "./types.js";

/** Used when no AI is configured: comma/newline split + keyword sections. */
export function parseTextLocally(text: string): ParsedItem[] {
  return text
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const m = raw.match(/^(\d+)\s*x?\s+(.+)$/i);
      const qty = m ? Math.min(99, Math.max(1, Number(m[1]))) : 1;
      const rest = m ? m[2] : raw;
      const name = rest.charAt(0).toUpperCase() + rest.slice(1);
      return { name, qty, brand: null, size: null, sectionId: categorize(name) };
    });
}
