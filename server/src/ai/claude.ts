import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { Section } from "../sections.js";
import { classifyTask, identifyTask, offerTask, parseTask } from "./prompts.js";
import { NotUnderstoodError, type Assistant, type ImageMediaType, type StoreProduct, type WantedItem } from "./types.js";

export class ClaudeAssistant implements Assistant {
  readonly name = "Claude";

  constructor(
    private client = new Anthropic(),
    private model = process.env.CLAUDE_MODEL || "claude-opus-5-5",
    /** Price matching reads whole results pages; a cheaper model can be set for it alone. */
    private priceModel = process.env.CLAUDE_PRICE_MODEL || model,
  ) {}

  private async run<T extends z.ZodType>(model: string, schema: T, system: string, content: Anthropic.Beta.BetaContentBlockParam[]) {
    const response = await this.client.beta.messages.parse({
      model,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new NotUnderstoodError("Claude could not answer that");
    }
    return response.parsed_output as z.infer<T>;
  }

  identifyPhoto(imageBase64: string, mediaType: ImageMediaType, sections: Section[]) {
    const t = identifyTask(sections);
    return this.run(this.model, t.schema, t.system, [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: t.prompt },
    ]);
  }

  async parseText(text: string, sections: Section[]) {
    const t = parseTask(sections);
    const out = await this.run(this.model, t.schema, t.system, [{ type: "text", text }]);
    return out.items.map((i) => ({ ...i, qty: Math.min(99, Math.max(1, i.qty)) }));
  }

  matchOffer(item: WantedItem, store: string, pageText: string) {
    const t = offerTask(item, store, pageText);
    return this.run(this.priceModel, t.schema, t.system, [{ type: "text", text: t.prompt }]);
  }

  classify(item: WantedItem, candidates: StoreProduct[]) {
    const t = classifyTask(item, candidates);
    return this.run(this.model, t.schema, t.system, [{ type: "text", text: t.prompt }]);
  }
}
