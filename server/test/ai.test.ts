import { describe, expect, it, vi } from "vitest";
import { createAssistant, LocalFirstAssistant, NotUnderstoodError, type Assistant } from "../src/ai/index.js";
import { OllamaAssistant } from "../src/ai/ollama.js";
import { DEFAULT_SECTIONS } from "../src/sections.js";

const ollamaReply = (content: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(content) }, done: true })));

describe("OllamaAssistant", () => {
  it("sends the photo, a JSON schema and the section list to /api/chat", async () => {
    const fetchFn = ollamaReply({ name: "Oat drink", brand: "Alpro", size: "1 L", sectionId: "dairy", confidence: "high" });
    const ai = new OllamaAssistant("http://mini.local:11434/", "some-vision-model", fetchFn as unknown as typeof fetch);
    const out = await ai.identifyPhoto("BASE64", "image/jpeg", DEFAULT_SECTIONS);
    expect(out).toMatchObject({ name: "Oat drink", sectionId: "dairy" });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://mini.local:11434/api/chat");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: "some-vision-model", stream: false });
    expect(body.messages[1].images).toEqual(["BASE64"]);
    expect(body.messages[0].content).toContain("- dairy: Dairy & eggs");
    expect(body.format.properties.sectionId.enum).toContain("frozen");
  });

  it("rejects answers that don't fit the schema", async () => {
    const ai = new OllamaAssistant("http://x", "m", ollamaReply({ name: "Milk", sectionId: "not-a-section" }) as unknown as typeof fetch);
    await expect(ai.identifyPhoto("B", "image/jpeg", DEFAULT_SECTIONS)).rejects.toBeInstanceOf(NotUnderstoodError);
  });

  it("clamps parsed quantities", async () => {
    const ai = new OllamaAssistant("http://x", "m", ollamaReply({ items: [{ name: "Eggs", qty: 0, brand: null, size: null, sectionId: "dairy" }] }) as unknown as typeof fetch);
    expect((await ai.parseText("eggs", DEFAULT_SECTIONS))[0].qty).toBe(1);
  });
});

describe("LocalFirstAssistant", () => {
  const make = (identify: Assistant["identifyPhoto"]): Assistant => ({ name: "x", identifyPhoto: identify, parseText: vi.fn(), matchOffer: vi.fn(), classify: vi.fn(), readReceipt: vi.fn() });
  const sure = { name: "Milk", brand: null, size: null, sectionId: "dairy", confidence: "high" as const };

  it("keeps the local answer when it's confident", async () => {
    const cloud = vi.fn();
    const ai = new LocalFirstAssistant(make(async () => sure), make(cloud));
    expect(await ai.identifyPhoto("b", "image/jpeg", DEFAULT_SECTIONS)).toBe(sure);
    expect(cloud).not.toHaveBeenCalled();
  });

  it("asks Claude when the local model is unsure or fails", async () => {
    const cloud = vi.fn(async () => sure);
    await new LocalFirstAssistant(make(async () => ({ ...sure, confidence: "low" })), make(cloud)).identifyPhoto("b", "image/jpeg", DEFAULT_SECTIONS);
    await new LocalFirstAssistant(make(async () => { throw new Error("down"); }), make(cloud)).identifyPhoto("b", "image/jpeg", DEFAULT_SECTIONS);
    expect(cloud).toHaveBeenCalledTimes(2);
  });
});

describe("createAssistant", () => {
  it("picks a backend from the environment", () => {
    expect(createAssistant({}).backend).toBe("none");
    expect(createAssistant({ OLLAMA_MODEL: "m" }).assistant?.name).toBe("Ollama (m)");
    expect(createAssistant({ ANTHROPIC_API_KEY: "k" }).assistant?.name).toBe("Claude");
    expect(createAssistant({ ANTHROPIC_API_KEY: "k", OLLAMA_MODEL: "m", AI_BACKEND: "ollama-then-claude" }).assistant?.name).toBe("Ollama (m), then Claude");
  });

  it("explains missing settings", () => {
    expect(() => createAssistant({ AI_BACKEND: "ollama" })).toThrow("OLLAMA_MODEL");
    expect(() => createAssistant({ AI_BACKEND: "gpt" })).toThrow("Unknown AI_BACKEND");
  });
});
