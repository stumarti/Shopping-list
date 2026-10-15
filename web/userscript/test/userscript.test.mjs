// Runs the userscript in real Chromium on a pretend tesco.ie, talking to the real FastAPI server.
// Needs the backend's Python dependencies (PYTHON points at that interpreter; default python3) and Chromium
// (CHROMIUM_PATH, or Playwright's own: npx playwright install chromium).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "..", "..", "backend");
const scriptSource = readFileSync(join(here, "..", "shopping-list.user.js"), "utf8");

let server, serverUrl, tmp, browser;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function call(method, path, body) {
  const res = await fetch(serverUrl + "/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(res.ok, `${method} ${path} → ${res.status} ${await res.clone().text()}`);
  return res.status === 204 ? null : res.json();
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "userscript-test-"));
  const port = await freePort();
  serverUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.env.PYTHON || "python3", ["-m", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"], {
    cwd: backend,
    env: { ...process.env, DB_PATH: join(tmp, "test.db"), STATIC_DIR: join(tmp, "none") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(serverUrl + "/api/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

// ---- A pretend Tesco ----

const shell = (title, main) => `<!doctype html><html><head><title>${title}</title></head><body>
  <header><a href="/shop/en-IE/trolley">Trolley</a> <a href="/shop/en-IE/checkout">Checkout</a></header>
  <main>${main}</main></body></html>`;

const PRODUCTS = {
  111: { name: "Avonmore Fresh Milk 2 Litre", kind: "qty-input" },
  222: { name: "Brennans Family Pan 800g", kind: "out-of-stock" },
  333: { name: "Tesco Free Range Eggs 6 Pack", kind: "plus-button" },
};

function productPage(id) {
  const p = PRODUCTS[id];
  if (p.kind === "out-of-stock") {
    return shell(p.name, `<h1>${p.name}</h1><p>This product's currently out of stock</p><button>Add to favourites</button>`);
  }
  const qtyInput = p.kind === "qty-input" ? `<input type="number" name="quantity" aria-label="Quantity" value="1" min="1">` : "";
  return shell(
    p.name,
    `<h1>${p.name}</h1><button>Add to favourites</button><button>Checkout now</button>
     <div id="buy">${qtyInput}<button id="add">Add</button></div>
     <script>
       const buy = document.getElementById("buy");
       const send = (qty) => fetch("/fake/basket", { method: "POST", body: JSON.stringify({ id: ${id}, qty }) });
       document.getElementById("add").addEventListener("click", async () => {
         const input = buy.querySelector("input");
         let qty = input ? Number(input.value) : 1;
         await send(qty);
         buy.innerHTML = '<span id="count"></span> in trolley <button aria-label="Increase quantity">+</button>';
         const show = () => (document.getElementById("count").textContent = qty);
         show();
         buy.querySelector("button").addEventListener("click", async () => { qty += 1; await send(qty); show(); });
       });
     </script>`,
  );
}

async function openStore() {
  const basket = new Map(); // product id → quantity in the trolley
  const visited = [];
  const context = await browser.newContext();

  await context.route("https://www.tesco.ie/**", async (route) => {
    const url = new URL(route.request().url());
    visited.push(url.pathname);
    if (url.pathname === "/fake/basket") {
      const { id, qty } = JSON.parse(route.request().postData());
      basket.set(id, qty);
      return route.fulfill({ status: 204 });
    }
    const product = url.pathname.match(/^\/shop\/en-IE\/products\/(\d+)$/);
    const html = product ? productPage(product[1]) : shell("Tesco", `<h1>${url.pathname}</h1>`);
    return route.fulfill({ contentType: "text/html", body: html });
  });

  // What Tampermonkey provides: storage that survives page loads, and requests to the home server.
  await context.exposeBinding("__gmRequest", async (_source, req) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.data });
    return { status: res.status, responseText: await res.text() };
  });
  await context.addInitScript(() => {
    const key = (k) => "__gm:" + k;
    window.GM_getValue = (k, d) => (localStorage.getItem(key(k)) === null ? d : JSON.parse(localStorage.getItem(key(k))));
    window.GM_setValue = (k, v) => localStorage.setItem(key(k), JSON.stringify(v));
    window.GM_deleteValue = (k) => localStorage.removeItem(key(k));
    window.GM_xmlhttpRequest = (req) =>
      window.__gmRequest({ url: req.url, method: req.method, headers: req.headers, data: req.data }).then(req.onload, req.onerror);
  });
  const script = scriptSource.replaceAll("__SERVER__", serverUrl).replaceAll("__HOST__", "127.0.0.1");
  await context.addInitScript(`document.addEventListener("DOMContentLoaded", () => { ${script} });`);

  const page = await context.newPage();
  return { page, basket, visited, context };
}

test("fills the basket with saved products, skips what it can't, and never goes near checkout", { timeout: 90_000 }, async () => {
  for (const [name, qty] of [["Milk", 2], ["Sliced pan", 1], ["Eggs", 3], ["Butter", 1]]) {
    await call("POST", "/list", { name, qty, category: "Other" });
  }
  const catalog = await call("GET", "/catalog");
  const id = (name) => catalog.find((c) => c.name === name).id;
  await call("PUT", `/catalog/${id("Milk")}/products/tesco`, { url: "https://www.tesco.ie/shop/en-IE/products/111" });
  await call("PUT", `/catalog/${id("Sliced pan")}/products/tesco`, { url: "www.tesco.ie/shop/en-IE/products/222?x=1" });

  const { page, basket, visited, context } = await openStore();

  // Save a product from the store page itself: open the eggs and save them for "Eggs".
  await page.goto("https://www.tesco.ie/shop/en-IE/products/333");
  await page.getByRole("combobox", { name: "Item on your list" }).selectOption({ label: "Eggs" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved. Next time").waitFor();
  const eggs = (await call("GET", "/catalog")).find((c) => c.name === "Eggs");
  assert.equal(eggs.products.tesco.url, "https://www.tesco.ie/shop/en-IE/products/333");
  assert.equal(eggs.products.tesco.title, "Tesco Free Range Eggs 6 Pack");

  // Fill the basket.
  await page.goto("https://www.tesco.ie/shop/en-IE/search?query=anything");
  await page.getByRole("button", { name: "Fill basket from my list" }).click();
  await page.getByText(/^Done: /).waitFor({ timeout: 60_000 });

  assert.deepEqual(Object.fromEntries(basket), { 111: 2, 333: 3 });
  assert.ok(!visited.some((p) => /checkout/.test(p)), "never opened checkout: " + visited.join(", "));

  const status = await page.getByRole("status").textContent();
  assert.match(status, /2 of 3 added/);
  const panelText = await page.locator("#shopping-list-panel").evaluate((el) => el.shadowRoot.textContent);
  assert.match(panelText, /Sliced pan: Out of stock/);
  assert.match(panelText, /Butter/); // no product saved: offered as a search link
  const butterLink = await page.getByRole("link", { name: "Butter" }).getAttribute("href");
  assert.equal(butterLink, "https://www.tesco.ie/shop/en-IE/search?query=Butter");

  // What made it into the basket is ticked off the list; the rest is still to sort out.
  const list = await call("GET", "/list");
  const done = Object.fromEntries(list.map((i) => [i.name, i.done]));
  assert.deepEqual(done, { Milk: true, "Sliced pan": false, Eggs: true, Butter: false });

  await context.close();
});

test("the server hands out the script pointed back at itself", async () => {
  const res = await fetch(serverUrl + "/userscript/shopping-list.user.js");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, new RegExp(`@connect\\s+127\\.0\\.0\\.1`));
  assert.ok(text.includes(`const SERVER = "${serverUrl}"`));
  assert.ok(text.includes(`@updateURL    ${serverUrl}/userscript/shopping-list.user.js`));
  assert.ok(!text.includes("__SERVER__"));
});
