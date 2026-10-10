import { z } from "zod";
import type { FetchFn } from "../products.js";
import type { Section } from "../sections.js";
import { identifyTask, offerTask, parseTask } from "./prompts.js";
import { NotUnderstoodError, type Assistant, type ImageMediaType, type WantedItem } from "./types.js";

/**
 * A model running locally under Ollama (e.g. on the Mac mini or the Windows PC).
 * Uses /api/chat with a JSON schema in `format`, so answers come back in the same shape as Claude's.
 * Photo identification needs a vision-capable model.
 */
export class OllamaAssistant implements Assistant {
  readonly name: string;

  constructor(
    private baseUrl: string,
    private model: string,
    private fetchFn: FetchFn = fetch,
    private timeoutMs = 120_000,
  ) {
    this.name = `Ollama (${model})`;
  }

  private async run<T extends z.ZodType>(schema: T, system: string, prompt: string, images?: string[]): Promise<z.infer<T>> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: z.toJSONSchema(schema),
        options: { temperature: 0 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt, ...(images ? { images } : {}) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { message?: { content?: string } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.message?.content ?? "");
    } catch {
      throw new NotUnderstoodError("The local model didn't return valid JSON");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new NotUnderstoodError("The local model's answer didn't fit the expected shape");
    return result.data;
  }

  identifyPhoto(imageBase64: string, _mediaType: ImageMediaType, sections: Section[]) {
    const t = identifyTask(sections);
    return this.run(t.schema, t.system, t.prompt, [imageBase64]);
  }

  async parseText(text: string, sections: Section[]) {
    const t = parseTask(sections);
    const out = await this.run(t.schema, t.system, text);
    return out.items.map((i) => ({ ...i, qty: Math.min(99, Math.max(1, i.qty)) }));
  }

  matchOffer(item: WantedItem, store: string, pageText: string) {
    const t = offerTask(item, store, pageText);
    return this.run(t.schema, t.system, t.prompt);
  }
}
