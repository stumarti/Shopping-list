import { ClaudeAssistant } from "./claude.js";
import { OllamaAssistant } from "./ollama.js";
import type { Assistant } from "./types.js";

export * from "./types.js";
export { parseTextLocally } from "./local.js";

/**
 * Try the local model first; use Claude when it fails, or when it isn't sure what a photo shows.
 * Keeps photos at home most of the time while staying accurate on the hard ones.
 */
export class LocalFirstAssistant implements Assistant {
  readonly name: string;

  constructor(
    private local: Assistant,
    private cloud: Assistant,
  ) {
    this.name = `${local.name}, then ${cloud.name}`;
  }

  async identifyPhoto(...args: Parameters<Assistant["identifyPhoto"]>) {
    try {
      const result = await this.local.identifyPhoto(...args);
      if (result.confidence !== "low") return result;
    } catch (err) {
      console.warn("local model failed, asking Claude", err);
    }
    return this.cloud.identifyPhoto(...args);
  }

  async parseText(...args: Parameters<Assistant["parseText"]>) {
    try {
      return await this.local.parseText(...args);
    } catch (err) {
      console.warn("local model failed, asking Claude", err);
      return this.cloud.parseText(...args);
    }
  }

  async matchOffer(...args: Parameters<Assistant["matchOffer"]>) {
    try {
      const result = await this.local.matchOffer(...args);
      if (result.confidence !== "low") return result;
    } catch (err) {
      console.warn("local model failed, asking Claude", err);
    }
    return this.cloud.matchOffer(...args);
  }

  async readReceipt(...args: Parameters<Assistant["readReceipt"]>) {
    try {
      return await this.local.readReceipt(...args);
    } catch (err) {
      console.warn("local model couldn't read the receipt, asking Claude", err);
      return this.cloud.readReceipt(...args);
    }
  }

  async classify(...args: Parameters<Assistant["classify"]>) {
    try {
      return await this.local.classify(...args);
    } catch (err) {
      console.warn("local model failed, asking Claude", err);
      return this.cloud.classify(...args);
    }
  }
}

export type AiBackend = "claude" | "ollama" | "ollama-then-claude" | "none";

/**
 * AI_BACKEND picks who answers. Unset: Claude if ANTHROPIC_API_KEY is set, else Ollama if OLLAMA_MODEL is set, else none.
 */
export function createAssistant(env: NodeJS.ProcessEnv = process.env): { backend: AiBackend; assistant?: Assistant } {
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY);
  const hasOllama = Boolean(env.OLLAMA_MODEL);
  const backend = (env.AI_BACKEND as AiBackend | undefined) ?? (hasClaude ? "claude" : hasOllama ? "ollama" : "none");
  const ollama = () => new OllamaAssistant(env.OLLAMA_URL || "http://localhost:11434", env.OLLAMA_MODEL!);

  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`AI_BACKEND=${backend} needs ${what}`);
  };
  switch (backend) {
    case "claude":
      need(hasClaude, "ANTHROPIC_API_KEY");
      return { backend, assistant: new ClaudeAssistant() };
    case "ollama":
      need(hasOllama, "OLLAMA_MODEL");
      return { backend, assistant: ollama() };
    case "ollama-then-claude":
      need(hasClaude && hasOllama, "both ANTHROPIC_API_KEY and OLLAMA_MODEL");
      return { backend, assistant: new LocalFirstAssistant(ollama(), new ClaudeAssistant()) };
    case "none":
      return { backend };
    default:
      throw new Error(`Unknown AI_BACKEND "${backend}" (use claude, ollama, ollama-then-claude or none)`);
  }
}
