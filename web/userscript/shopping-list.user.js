// ==UserScript==
// @name         Shopping list → basket
// @namespace    shopping-list
// @version      1.2.0
// @description  Fill your Tesco or Dunnes basket from your shopping list. It never checks out, pays or books a slot.
// @match        https://www.tesco.ie/*
// @match        https://www.dunnesstoresgrocery.com/*
// @connect      __HOST__
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @updateURL    __SERVER__/userscript/shopping-list.user.js
// @downloadURL  __SERVER__/userscript/shopping-list.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Served by the shopping list server, which fills in __SERVER__. Bump @version when you change this file so
// Tampermonkey picks up the update.

(function () {
  "use strict";

  const SERVER = "__SERVER__";

  // How each store's pages look. Checked October 2026; when a store changes its site, this is the part to fix.
  const STORES = {
    "www.tesco.ie": {
      id: "tesco",
      name: "Tesco",
      productPath: /^\/(?:shop|groceries)\/en-IE\/products\/\d+\/?$/,
      orderPath: /order/i,
    },
    "www.dunnesstoresgrocery.com": {
      id: "dunnes",
      name: "Dunnes",
      productPath: /^\/product\/[a-z0-9-]*?\d{6,}\/?$/,
      orderPath: /order/i,
    },
  };

  // Never touch anything that spends money or changes a slot.
  const FORBIDDEN = /check\s*out|checkout|pay\b|payment|place (my )?order|confirm (my )?order|book (a )?slot|change slot|reserve/i;
  const ADD_BUTTON = /^(add|add to (basket|trolley|cart))$/i;
  const NOT_ADD = /favourite|list|review|note|recipe|substitut/i;
  const INCREASE = /increase|add one|one more|plus|^\+$/i;
  const OUT_OF_STOCK = /out of stock|currently unavailable|not available|sold out/i;
  const WAIT_BETWEEN_MS = [2000, 4000]; // pause between products, so it shops at a person's pace

  const store = STORES[location.host];
  if (!store) return;

  const STATE_KEY = "run:" + store.id;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = () => sleep(WAIT_BETWEEN_MS[0] + Math.random() * (WAIT_BETWEEN_MS[1] - WAIT_BETWEEN_MS[0]));
  const productPath = (url) => new URL(url, location.href).pathname.replace(/\/$/, "");
  const onProductPage = () => store.productPath.test(location.pathname);

  // ---- Talking to the home server ----

  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SERVER + "/api" + path,
        headers: body ? { "Content-Type": "application/json" } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: (res) => {
          let data = null;
          try {
            data = res.responseText ? JSON.parse(res.responseText) : null;
          } catch (e) {
            /* not JSON */
          }
          if (res.status >= 200 && res.status < 300) resolve(data);
          else reject(new Error((data && typeof data.detail === "string" && data.detail) || "The shopping list server said no (" + res.status + ")"));
        },
        onerror: () => reject(new Error("Can't reach your shopping list at " + SERVER)),
        ontimeout: () => reject(new Error("Your shopping list server didn't answer in time")),
      });
    });
  }

  const loadState = () => GM_getValue(STATE_KEY, null);
  const saveState = (state) => GM_setValue(STATE_KEY, state);
  const clearState = () => GM_deleteValue(STATE_KEY);

  // ---- Reading and pressing things on the store's page ----

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
  const safe = (el) => !FORBIDDEN.test(label(el)) && !FORBIDDEN.test(el.getAttribute("href") || "");
  const mainArea = () => document.querySelector("main") || document.body;

  function buttons() {
    return [...mainArea().querySelectorAll("button, [role=button], input[type=submit]")].filter(
      (b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && safe(b),
    );
  }

  function findAddButton() {
    return buttons().find((b) => ADD_BUTTON.test(label(b)) && !NOT_ADD.test(label(b)));
  }

  function findQuantityInput() {
    return [...mainArea().querySelectorAll("input")].find(
      (i) => visible(i) && (i.type === "number" || /quantity|qty/i.test(i.name + " " + (i.getAttribute("aria-label") || "") + " " + i.id)),
    );
  }

  function setInputValue(input, value) {
    // React-style sites ignore .value = …; go through the native setter and fire the events they listen for.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function press(el) {
    if (!safe(el)) throw new Error("Refused to press " + label(el));
    el.click();
  }

  async function waitFor(find, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = find();
      if (found) return found;
      await sleep(250);
    }
    return null;
  }

  /** Add `qty` of the product on this page. Returns {status, detail}. */
  async function addHere(qty) {
    const add = await waitFor(findAddButton, 12000);
    if (!add) {
      return OUT_OF_STOCK.test(mainArea().textContent || "")
        ? { status: "unavailable", detail: "Out of stock" }
        : { status: "failed", detail: "Couldn't find the Add button" };
    }
    const qtyInput = findQuantityInput();
    if (qtyInput) setInputValue(qtyInput, qty);
    const before = label(add);
    press(add);

    // Something on the page should change: the button goes, its label changes, or a quantity control appears.
    const changed = await waitFor(() => !document.contains(add) || label(add) !== before || buttons().some((b) => INCREASE.test(label(b))), 6000);

    let added = qtyInput ? qty : 1;
    if (!qtyInput && qty > 1) {
      for (; added < qty; added++) {
        const plus = buttons().find((b) => INCREASE.test(label(b)));
        if (!plus) break;
        press(plus);
        await sleep(700);
      }
    }
    if (added < qty) return { status: "check", detail: `Added ${added} of ${qty}. Check the quantity` };
    if (!changed) return { status: "check", detail: "Pressed Add, but couldn't see the basket change" };
    return { status: "added", detail: qty > 1 ? `${qty} added` : "Added" };
  }

  // ---- The run: one product page after another, surviving each page load ----

  async function start() {
    panel.busy("Getting your list…");
    try {
      const basket = await api("GET", "/basket/" + store.id);
      const ready = basket.items.filter((i) => i.product);
      const notLinked = basket.items.filter((i) => !i.product);
      if (!ready.length) {
        panel.render(null, notLinked);
        panel.message(
          notLinked.length
            ? "None of your items has a " + store.name + " product saved yet. Open a product and use “Save for”."
            : "Your list is empty.",
        );
        return;
      }
      saveState({ queue: ready, index: 0, results: [], notLinked });
      await step();
    } catch (e) {
      panel.message(e.message);
    }
  }

  async function step() {
    const state = loadState();
    if (!state) return;
    if (state.index >= state.queue.length) return finish(state);
    const item = state.queue[state.index];
    if (productPath(location.href) !== productPath(item.product.url)) {
      panel.busy(`Opening ${item.name} (${state.index + 1} of ${state.queue.length})…`);
      location.assign(item.product.url);
      return;
    }
    panel.busy(`Adding ${item.qty} × ${item.name} (${state.index + 1} of ${state.queue.length})…`);
    let result;
    try {
      result = await addHere(item.qty);
    } catch (e) {
      result = { status: "failed", detail: e.message };
    }
    // Tick it off the list once it's in the basket, so the list shows what's left to sort out.
    if (result.status === "added") {
      await api("PATCH", "/list/" + item.id, { done: true }).catch(() => {});
    }
    const latest = loadState();
    if (!latest) return; // stopped while we were busy
    latest.results.push({ ...item, ...result });
    latest.index += 1;
    saveState(latest);
    await pause();
    return step();
  }

  function finish(state) {
    clearState();
    panel.render(state.results, state.notLinked);
    const added = state.results.filter((r) => r.status === "added").length;
    panel.message(`Done: ${added} of ${state.results.length} added. Check your basket, then check out yourself when you're ready.`);
  }

  function stop() {
    const state = loadState();
    clearState();
    panel.render(state ? state.results : null, state ? state.notLinked : null);
    panel.message("Stopped. Nothing else will be added.");
  }

  // ---- Past orders: read the products off an order page and send them home ----

  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  function productLinkPath(a) {
    try {
      const url = new URL(a.getAttribute("href"), location.href);
      return url.host === location.host && store.productPath.test(url.pathname) ? url.pathname.replace(/\/$/, "") : null;
    } catch (e) {
      return null;
    }
  }

  /** The element holding one order line: climb from the link until the next step up holds another product. */
  function lineContainer(a) {
    let el = a;
    for (let i = 0; i < 8 && el.parentElement && el.parentElement !== document.body; i++) {
      const paths = new Set([...el.parentElement.querySelectorAll("a[href]")].map(productLinkPath).filter(Boolean));
      if (paths.size > 1) break;
      el = el.parentElement;
    }
    return el;
  }

  function quantityIn(box, name) {
    const field = box.querySelector("input[type=number], select");
    if (field && /^\d{1,2}$/.test(field.value)) return Number(field.value);
    // Leave the product name out, so "6 x 330ml" isn't read as six of them.
    const text = clean(box.textContent).replace(name, " ");
    const m =
      text.match(/(?:qty|quantity)\s*:?\s*(\d{1,2})\b/i) || text.match(/\b(\d{1,2})\s*[x×](?:\s|$)/) || text.match(/[x×]\s*(\d{1,2})\b/);
    return m ? Math.max(1, Math.min(99, Number(m[1]))) : 1;
  }

  /** What the order line cost, e.g. "€4.38" (the first euro amount on the line), or null. */
  function priceIn(box, name) {
    const m = clean(box.textContent).replace(name, " ").match(/€\s?(\d{1,4}(?:[.,]\d{2}))/);
    return m ? Number(m[1].replace(",", ".")) : null;
  }

  function readOrder() {
    const lines = new Map();
    for (const a of document.querySelectorAll("a[href]")) {
      const path = productLinkPath(a);
      if (!path) continue;
      const box = lineContainer(a);
      const name =
        clean(a.textContent) ||
        clean(a.querySelector("img") && a.querySelector("img").alt) ||
        clean((box.querySelector("h2, h3, h4, [class*=title i], [class*=name i]") || {}).textContent);
      const line = lines.get(path);
      if (line) {
        if (!line.name && name) line.name = name; // the picture and the title often link to the same product
        continue;
      }
      lines.set(path, { name, box, url: location.origin + path });
    }
    return [...lines.values()]
      .filter((l) => l.name)
      .map((l) => ({ name: l.name, qty: quantityIn(l.box, l.name), url: l.url, price: priceIn(l.box, l.name) }));
  }

  function orderDate() {
    const text = clean(mainArea().textContent);
    let m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+(\d{4})\b/i);
    if (m) return iso(m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, m[1]);
    m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
    if (m) return iso(m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]);
    m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/); // Irish order: day/month/year
    if (m) return iso(m[3], m[2], m[1]);
    m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    return m ? iso(m[1], m[2], m[3]) : "";
  }
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  function orderRef() {
    const params = new URL(location.href).searchParams;
    for (const k of ["orderId", "orderNumber", "order", "id"]) if (params.get(k)) return params.get(k);
    const parts = location.pathname.split("/").filter(Boolean);
    const last = parts.reverse().find((p) => /\d/.test(p) && p.length >= 4);
    return last || location.pathname;
  }

  const onOrderPage = () => store.orderPath.test(location.pathname) && readOrder().length > 0;

  async function importOrder() {
    const items = readOrder();
    const date = orderDate();
    const r = await api("POST", `/history/${store.id}/import`, { order_ref: orderRef(), date, items });
    if (r.already_imported) return "This order was already imported.";
    return (
      `Imported ${r.products} products from ${r.bought_on}.` +
      (r.new_common_items ? ` ${r.new_common_items} new common items, each with its ${store.name} product saved.` : "") +
      (r.skipped ? ` Skipped ${r.skipped} links that weren't products.` : "")
    );
  }

  // ---- A copy of this page, cleaned of personal details, for fixing the helper when a store changes ----

  const REDACT = [
    [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
    [/\b[AC-FHKNPRTV-Y]\d{2}\s?[AC-FHKNPRTV-Y0-9]{4}\b/g, "[eircode]"], // upper case only, so class names survive
    [/(?:\+353[\s-]?|\b0)\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}\b/g, "[phone]"],
    [/\b(?:\d[ -]?){12,19}\b/g, "[number]"],
  ];

  function snapshot(extraWords) {
    const words = extraWords.map((w) => w.trim()).filter((w) => w.length > 1).map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
    let hidden = 0;
    const redact = (text) => {
      let out = text;
      for (const [pattern, mark] of REDACT) out = out.replace(pattern, () => (hidden++, mark));
      for (const w of words) out = out.replace(w, () => (hidden++, "[hidden]"));
      return out;
    };
    const doc = document.documentElement.cloneNode(true);
    doc.querySelectorAll("script, noscript, iframe, object, embed, template, link[rel=preload], link[rel=prefetch], #shopping-list-panel").forEach((e) => e.remove());
    doc.querySelectorAll("svg").forEach((e) => e.replaceChildren());
    doc.querySelectorAll("input, textarea, select").forEach((e) => {
      e.removeAttribute("value");
      if (e.tagName !== "INPUT") e.textContent = "";
    });
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_ALL);
    const comments = [];
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === Node.COMMENT_NODE) comments.push(n);
      else if (n.nodeType === Node.TEXT_NODE) n.nodeValue = redact(n.nodeValue);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        for (const attr of [...n.attributes]) {
          if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
          else n.setAttribute(attr.name, redact(attr.value));
        }
      }
    }
    comments.forEach((c) => c.remove());
    const note = `<!-- Saved by the shopping list helper from ${location.origin}${location.pathname} on ${new Date().toISOString()}.
     Scripts, form values, emails, phone numbers, Eircodes, long numbers and your words were removed (${hidden} places).
     Look it over before sharing. -->`;
    const html = "<!doctype html>\n" + note + "\n" + doc.outerHTML;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = `${store.id}${location.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "")}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return hidden;
  }

  async function linkThisProduct(itemId) {
    const title = (document.querySelector("h1") || {}).textContent || document.title;
    await api("POST", `/basket/${store.id}/link`, { item_id: itemId, url: location.href, title: title.trim() });
  }

  // ---- The panel in the corner of the store's page ----

  const panel = (() => {
    const host = document.createElement("div");
    host.id = "shopping-list-panel";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 300px; max-height: 70vh;
               overflow: auto; background: #fff; color: #1d2420; border: 1px solid #dfe3dd; border-radius: 14px;
               box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px;
                border-bottom: 1px solid #dfe3dd; font-weight: 600; }
        .body { padding: 10px 12px; }
        button { font: inherit; cursor: pointer; border-radius: 9px; padding: 7px 12px; border: 1px solid #dfe3dd;
                 background: #fff; color: inherit; }
        button.primary { background: #1a7f4b; color: #fff; border-color: #1a7f4b; font-weight: 600; }
        button.icon { border: none; padding: 2px 6px; color: #5f6b64; }
        select { font: inherit; max-width: 100%; padding: 6px; border-radius: 8px; border: 1px solid #dfe3dd; }
        p { margin: 6px 0; }
        .muted { color: #5f6b64; }
        ul { list-style: none; margin: 6px 0; padding: 0; }
        li { padding: 4px 0; border-top: 1px solid #eef0ec; }
        li:first-child { border-top: none; }
        .added { color: #1a7f4b; } .check { color: #8a5a00; } .failed, .unavailable { color: #b3261e; }
        a { color: #1a7f4b; }
        .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
        .min .body { display: none; }
        .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid #eef0ec; }
        button.small { font-size: 12px; padding: 4px 8px; color: #5f6b64; }
      </style>
      <div class="box">
        <div class="head"><span>Shopping list</span><button class="icon" data-act="toggle" aria-label="Minimise">–</button></div>
        <div class="body">
          <div class="row"><button class="primary" data-act="start">Fill basket from my list</button>
            <button data-act="stop" hidden>Stop</button></div>
          <p class="status muted" role="status"></p>
          <div class="link" hidden>
            <p class="muted">Save this product for:</p>
            <div class="row"><select aria-label="Item on your list"></select><button data-act="link">Save</button></div>
          </div>
          <div class="order" hidden>
            <p class="muted">This looks like a past order.</p>
            <div class="row"><button data-act="import">Import this order</button></div>
          </div>
          <div class="results"></div>
          <div class="row foot"><button class="small" data-act="snapshot">Save page for Claude</button></div>
        </div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

    root.addEventListener("click", async (e) => {
      const act = e.target.closest && e.target.closest("[data-act]");
      if (!act) return;
      const what = act.dataset.act;
      if (what === "toggle") $(".box").classList.toggle("min");
      if (what === "start") start();
      if (what === "stop") stop();
      if (what === "import") {
        panelApi.busy("Importing this order…");
        try {
          panelApi.message(await importOrder());
        } catch (err) {
          panelApi.message(err.message);
        }
      }
      if (what === "snapshot") {
        const words = prompt("Words to blank out as well, like your name or street (optional, separate with commas):", "");
        if (words === null) return;
        const hidden = snapshot(words.split(","));
        panelApi.message(`Saved a copy of this page (${hidden} personal details blanked). Look it over, then share it.`);
      }
      if (what === "link") {
        const id = Number($(".link select").value);
        if (!id) return;
        try {
          await linkThisProduct(id);
          panelApi.message("Saved. Next time it'll be added automatically.");
          refreshLinkChoices();
        } catch (err) {
          panelApi.message(err.message);
        }
      }
    });

    const panelApi = {
      mount() {
        document.body.appendChild(host);
      },
      busy(text) {
        $("[data-act=start]").hidden = true;
        $("[data-act=stop]").hidden = false;
        $(".status").textContent = text;
      },
      message(text) {
        $("[data-act=start]").hidden = false;
        $("[data-act=stop]").hidden = true;
        $(".status").textContent = text;
      },
      render(results, notLinked) {
        let html = "";
        if (results && results.length) {
          html += "<ul>" + results.map((r) => `<li class="${r.status}">${esc(r.name)}: ${esc(r.detail)}</li>`).join("") + "</ul>";
        }
        if (notLinked && notLinked.length) {
          html +=
            `<p class="muted">No ${esc(store.name)} product saved yet. Find each one, open it, and use “Save for”:</p><ul>` +
            notLinked.map((i) => `<li><a href="${esc(i.search)}">${esc(i.name)}</a> ×${i.qty}</li>`).join("") +
            "</ul>";
        }
        $(".results").innerHTML = html;
      },
      order(show) {
        $(".order").hidden = !show;
      },
      linkChoices(items) {
        const box = $(".link");
        box.hidden = !items.length;
        $(".link select").innerHTML = items.map((i) => `<option value="${i.id}">${esc(i.name)}${i.product ? " (replace)" : ""}</option>`).join("");
      },
    };
    return panelApi;
  })();

  async function refreshLinkChoices() {
    if (!onProductPage() || loadState()) return panel.linkChoices([]);
    try {
      const basket = await api("GET", "/basket/" + store.id);
      const here = productPath(location.href);
      // Items without a product first; the ones saved to some other product can be replaced.
      const choices = basket.items
        .filter((i) => !i.product || productPath(i.product.url) !== here)
        .sort((a, b) => Number(!!a.product) - Number(!!b.product));
      panel.linkChoices(choices);
    } catch (e) {
      panel.linkChoices([]);
    }
  }

  function refreshPageTools() {
    panel.order(!loadState() && onOrderPage());
    refreshLinkChoices();
  }

  panel.mount();
  if (loadState()) {
    step();
  } else {
    panel.message("Ready. Book your slot first, then fill your basket.");
    refreshPageTools();
    // Order pages often load their contents after the page itself.
    setTimeout(refreshPageTools, 2500);
  }
  // The stores change pages without reloading, so notice when you've moved to another product.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      refreshPageTools();
    }
  }, 1000);
})();
