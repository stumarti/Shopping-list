import type { Candidate, StoreAdapter } from "./types.js";

/**
 * Adapter for the pretend supermarket in test/fixtures/test-store.ts. It exercises the whole ordering
 * flow (sign-in, slot, search, add to basket) without touching a real store, and doubles as a worked
 * example of an adapter. Enabled when TEST_STORE_URL is set.
 */
export function testStore(baseUrl: string): StoreAdapter {
  const url = (path: string) => new URL(path, baseUrl).toString();
  return {
    id: "test",
    name: "Test Store",
    ordering: true,
    signInUrl: url("/login"),
    basketUrl: url("/basket"),

    async isSignedIn(page) {
      await page.goto(url("/account"), { waitUntil: "domcontentloaded" });
      return (await page.getByTestId("signed-in").count()) > 0;
    },

    async getSlot(page) {
      await page.goto(url("/slot"), { waitUntil: "domcontentloaded" });
      const slot = page.getByTestId("slot");
      if (!(await slot.count())) return null;
      return { kind: (await slot.getAttribute("data-kind")) === "delivery" ? "delivery" : "collect", label: (await slot.innerText()).trim() };
    },

    async search(page, query) {
      await page.goto(url(`/search?q=${encodeURIComponent(query)}`), { waitUntil: "domcontentloaded" });
      const tiles = page.getByTestId("product");
      const out: Candidate[] = [];
      for (const tile of await tiles.all()) {
        const price = await tile.getAttribute("data-price");
        const member = await tile.getAttribute("data-member-price");
        out.push({
          ref: (await tile.getAttribute("data-id"))!,
          name: (await tile.getByTestId("name").innerText()).trim(),
          size: (await tile.getAttribute("data-size")) || null,
          price: price ? Number(price) : null,
          memberPrice: member ? Number(member) : null,
          available: (await tile.getAttribute("data-available")) !== "false",
        });
      }
      return out;
    },

    async addToBasket(page, candidate, qty) {
      await page.goto(url(`/product/${encodeURIComponent(candidate.ref)}`), { waitUntil: "domcontentloaded" });
      await page.getByLabel("Quantity").fill(String(qty));
      await page.getByRole("button", { name: "Add to basket" }).click();
      await page.getByTestId("added").waitFor({ timeout: 10_000 });
    },
  };
}
