import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp } from "../src/app.js";
import { PoliteQueue } from "../src/limiter.js";
import { Ordering } from "../src/ordering.js";
import { RemoteView, VIEW } from "../src/remote.js";
import { SessionManager } from "../src/sessions.js";
import { storeAdapters } from "../src/stores/index.js";
import { startTestStore } from "./fixtures/test-store.js";

// Drives a real Chromium against the pretend store. Skipped where no browser is installed.
const executable = process.env.CHROMIUM_PATH || chromium.executablePath();
const hasBrowser = existsSync(executable);

describe.skipIf(!hasBrowser)("ordering against the test store (real browser)", () => {
  let store: Awaited<ReturnType<typeof startTestStore>>;
  let sessions: SessionManager;
  let app: ReturnType<typeof createWorkerApp>;

  beforeAll(async () => {
    store = await startTestStore();
    sessions = new SessionManager(mkdtempSync(join(tmpdir(), "profiles-")), (dir) =>
      chromium.launchPersistentContext(dir, { headless: true, executablePath: process.env.CHROMIUM_PATH || undefined }),
    );
    const ordering = new Ordering(sessions, storeAdapters({ TEST_STORE_URL: store.url }));
    app = createWorkerApp({ fetcher: { search: async () => ({ url: "", text: "" }) }, queue: new PoliteQueue(0), ordering, remote: new RemoteView(sessions) });
  }, 60_000);

  afterAll(async () => {
    await sessions?.close();
    store?.close();
  });

  const post = async (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const me = { owner: "user-1", store: "test" };

  it("lists stores, with real stores not ready yet", async () => {
    const { stores } = await (await app.request("/stores")).json();
    expect(stores.map((s: { id: string; ordering: boolean }) => [s.id, s.ordering])).toEqual([["tesco", false], ["dunnes", false], ["test", true]]);
    const res = await post("/order/slot", { owner: "user-1", store: "tesco" });
    expect(res.status).toBe(501);
    expect((await res.json()).notReady).toBe(true);
  });

  it("reports not signed in before linking", async () => {
    expect(await (await post("/order/slot", me)).json()).toEqual({ signedIn: false, slot: null });
  });

  it("signs in through the live view by tapping and typing", async () => {
    expect((await (await post("/account/open", me)).json()).view).toEqual(VIEW);
    const shot = await app.request(`/account/screenshot?owner=user-1&store=test`);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    // Find the fields' positions the way a person would: by looking at the page.
    const page = await (await sessions.context("user-1", "test")).pages().find((p) => p.url().includes("/login"))!;
    const centre = async (label: string) => {
      const box = (await page.getByLabel(label).boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    await post("/account/input", { ...me, event: { type: "click", ...(await centre("Email")) } });
    await post("/account/input", { ...me, event: { type: "type", text: "sam@example.com" } });
    await post("/account/input", { ...me, event: { type: "click", ...(await centre("Password")) } });
    await post("/account/input", { ...me, event: { type: "type", text: "correct-horse" } });
    await post("/account/input", { ...me, event: { type: "key", key: "Enter" } });
    await post("/account/close", me);

    expect(await (await post("/order/slot", me)).json()).toEqual({ signedIn: true, slot: { kind: "collect", label: "Click & collect · Sat 18 Oct, 14:00–15:00" } });
    // Another person on the same server is still signed out.
    expect((await (await post("/order/slot", { owner: "user-2", store: "test" })).json()).signedIn).toBe(false);
  }, 60_000);

  it("searches and fills the basket, reporting items that couldn't be added", async () => {
    const { candidates } = await (await post("/order/search", { ...me, query: "whole milk" })).json();
    expect(candidates.map((c: { ref: string }) => c.ref)).toEqual(["p1", "p2", "p3"]);
    expect(candidates[0]).toMatchObject({ name: "Avonmore Fresh Whole Milk 2 L", size: "2 L", price: 2.39, memberPrice: 2.1, available: true });

    const oat = (await (await post("/order/search", { ...me, query: "oat drink" })).json()).candidates;
    const { results } = await (
      await post("/order/add", { ...me, items: [{ candidate: candidates[0], qty: 2 }, { candidate: oat[0], qty: 1 }] })
    ).json();
    expect(results[0]).toEqual({ ref: "p1", ok: true });
    expect(results[1].ok).toBe(false);
    expect(store.baskets()).toContainEqual({ p1: 2 });
  }, 60_000);

  it("sees when no slot is booked", async () => {
    store.setSlot(null);
    expect(await (await post("/order/slot", me)).json()).toEqual({ signedIn: true, slot: null });
  });
});
