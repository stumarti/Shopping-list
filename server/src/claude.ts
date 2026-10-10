import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { categorize, type Section } from "./sections.js";

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

/** What the HTTP layer needs from Claude; tests swap in a fake. */
export interface Assistant {
  identifyPhoto(imageBase64: string, mediaType: ImageMediaType, sections: Section[]): Promise<Identified>;
  parseText(text: string, sections: Section[]): Promise<ParsedItem[]>;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export class NotUnderstoodError extends Error {}

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

function sectionList(sections: Section[]): string {
  return sections.map((s) => `- ${s.id}: ${s.name}`).join("\n");
}

function sectionEnum(sections: Section[]) {
  return z.enum(sections.map((s) => s.id) as [string, ...string[]]);
}

export class ClaudeAssistant implements Assistant {
  constructor(private client = new Anthropic()) {}

  private async run<T extends z.ZodType>(schema: T, system: string, content: Anthropic.Beta.BetaContentBlockParam[]) {
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new NotUnderstoodError("Claude could not identify this");
    }
    return response.parsed_output as z.infer<T>;
  }

  async identifyPhoto(imageBase64: string, mediaType: ImageMediaType, sections: Section[]): Promise<Identified> {
    const schema = z.object({
      name: z.string().describe("Generic product type in plain English, e.g. 'Oat drink', 'Mature cheddar'"),
      brand: z.string().nullable().describe("Brand exactly as printed on the pack, or null if not visible"),
      size: z.string().nullable().describe("Pack size such as '1 L', '500 g', '6 pack', or null if not visible"),
      sectionId: sectionEnum(sections),
      confidence: z.enum(["low", "medium", "high"]),
    });
    const system =
      "You identify grocery and household products from a phone photo so they can be added to a shopping list. " +
      "Name the product type generically and read the brand and pack size from the packaging. " +
      "Do not guess a brand you cannot see. Pick the supermarket section it is usually shelved in:\n" +
      sectionList(sections);
    return this.run(schema, system, [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: "What is this product?" },
    ]);
  }

  async parseText(text: string, sections: Section[]): Promise<ParsedItem[]> {
    const schema = z.object({
      items: z.array(
        z.object({
          name: z.string(),
          qty: z.number().int(),
          brand: z.string().nullable(),
          size: z.string().nullable(),
          sectionId: sectionEnum(sections),
        }),
      ),
    });
    const system =
      "Split the user's shopping-list entry into separate items. Keep names short and natural (capitalise the first letter). " +
      "qty is the number of packs (default 1); sizes like '2L' or '500g' go in size, not qty. " +
      "Only fill brand when the user names one. Sections:\n" +
      sectionList(sections);
    const out = await this.run(schema, system, [{ type: "text", text }]);
    return out.items.map((i: ParsedItem) => ({ ...i, qty: Math.min(99, Math.max(1, i.qty)) }));
  }
}

/** Used when no API key is configured: comma/newline split + keyword sections. */
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
