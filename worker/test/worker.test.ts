import { describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "../src/app.js";
import { PoliteQueue } from "../src/limiter.js";
import { buildSearchUrl, cleanPageText, DEFAULT_SEARCH_URLS, searchUrls } from "../src/stores.js";

describe("stores", () => {
  it("builds encoded search URLs and honours overrides", () => {
    expect(buildSearchUrl(DEFAULT_SEARCH_URLS.tesco, " Avonmore milk 2 L ")).toBe("https://www.tesco.ie/groceries/en-IE/search?query=Avonmore%20milk%202%20L");
    expect(searchUrls({ DUNNES_SEARCH_URL: "https://d.example/s?q={q}" }).dunnes).toBe("https://d.example/s?q={q}");
  });

  it("tidies page text", () => {
    expect(cleanPageText("  Milk   2L \n\n\n  €2.39  \n")).toBe("Milk 2L\n€2.39");
    expect(cleanPageText("x".repeat(100), 10)).toHaveLength(10);
  });
});

describe("PoliteQueue", () => {
  it("spaces jobs for the same store and runs them in order, but not across stores", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const q = new PoliteQueue(4000, async (ms) => { sleeps.push(ms); clock += ms; }, () => clock);
    const order: string[] = [];
    await Promise.all([
      q.run("tesco", async () => order.push("t1")),
      q.run("tesco", async () => order.push("t2")),
      q.run("dunnes", async () => order.push("d1")),
    ]);
    expect(order).toEqual(["t1", "d1", "t2"]);
    expect(sleeps).toEqual([4000]);
  });

  it("keeps going after a failed job", async () => {
    const q = new PoliteQueue(0);
    await expect(q.run("s", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await q.run("s", async () => 1)).toBe(1);
  });
});

describe("worker API", () => {
  const fetcher = { search: vi.fn(async (store: string, query: string) => ({ url: `https://${store}/?q=${query}`, text: "€1.00" })) };
  const app = createWorkerApp({ fetcher, queue: new PoliteQueue(0), token: "secret" });
  const post = (body: unknown, token = "secret") =>
    app.request("/search", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("returns page text for a store search", async () => {
    const res = await post({ store: "tesco", query: "milk" });
    expect(await res.json()).toEqual({ url: "https://tesco/?q=milk", text: "€1.00" });
  });

  it("rejects bad tokens and unknown stores", async () => {
    expect((await post({ store: "tesco", query: "milk" }, "nope")).status).toBe(401);
    expect((await post({ store: "aldi", query: "milk" })).status).toBe(400);
  });

  it("reports browser failures as 502", async () => {
    fetcher.search.mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED at https://www.tesco.ie\nstack"));
    const res = await post({ store: "tesco", query: "milk" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Couldn't load tesco: net::ERR_NAME_NOT_RESOLVED at https://www.tesco.ie");
  });
});
