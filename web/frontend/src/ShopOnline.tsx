import { useEffect, useState, type FormEvent } from "react";
import { api, fillLink, type CatalogItem, type Links, type NextShop, type ShopItem } from "./api";

type Props = {
  listSize: number;
  catalog: CatalogItem[];
  links: Links | null;
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

type Store = Links["stores"][number];
const STORE_KEY = "shopping-list.store";
const CHEAPER_KEY = "shopping-list.cheaper";

/** Whether to look for cheaper options, and what to do with them. Remembered on this device. */
type Cheaper = { on: boolean; swap: boolean; percent: number; cents: number };
const CHEAPER_DEFAULT: Cheaper = { on: false, swap: false, percent: 10, cents: 20 };

function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return typeof fallback === "string" ? (raw as T) : { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Not remembered on this device; it still works now.
  }
}

/** One line of the shop as the store will see it: what to get, and the exact product if one is saved. */
type Line = {
  key: string;
  catalogId: number | null;
  name: string;
  qty: number;
  category: string;
  url: string | null;
  choices: string[] | null;
  exact: boolean;
};

function lines(plan: NextShop, catalog: CatalogItem[], store: Store): Line[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const byName = new Map(catalog.map((c) => [c.name.toLowerCase(), c]));
  return plan.items.map((i: ShopItem) => {
    // A pick-one set: the one picked, or a choice between its options.
    const pickedId = i.kind === "or" ? i.chosen : i.catalog_id;
    const c = (pickedId !== null ? byId.get(pickedId) : undefined) ?? byName.get(i.name.toLowerCase());
    const name = i.kind === "or" && i.chosen !== null ? (byId.get(i.chosen)?.name ?? i.name) : i.name;
    const choices = i.kind === "or" && i.chosen === null ? (i.options ?? []).map((o) => o.name) : null;
    return {
      key: `${i.catalog_id ?? "l" + i.list_item_id}`,
      catalogId: c && !choices ? c.id : null,
      name,
      qty: i.qty,
      category: i.category,
      url: (c && !choices && c.products[store.id]?.url) || null,
      choices,
      exact: Boolean(c && !choices && c.exact),
    };
  });
}

/** What to ask Claude in Chrome to do. It fills the basket and stops: you check out yourself. */
function prompt(store: Store, items: Line[], cheaper: Cheaper): string {
  const list = items
    .map((l) => {
      const what = l.choices ? `one of: ${l.choices.join(" or ")}` : l.name;
      return `- ${l.qty} × ${what}${l.exact ? " [exact: never swap]" : ""}${l.url ? ` (${l.url})` : ""}`;
    })
    .join("\n");
  const exact = items.some((l) => l.exact);
  const saving = `at least ${cheaper.percent}% or ${cheaper.cents}c a pack, whichever is more`;

  const cheaperPart = !cheaper.on
    ? ""
    : `
Cheaper alternatives:
- For each item${exact ? " not marked [exact]" : ""}, check whether there's a cheaper like-for-like option: the same kind of product, a similar size (within about 25%). The store's own brand is fine.
- Compare the unit price (€/kg, €/L or €/each, shown under the price), not the pack price. Clubcard or member prices count, since I'm signed in. A multibuy offer only counts if the quantity on my list already covers it.
- Only count it as cheaper if it saves ${saving}.
${
  cheaper.swap
    ? "- When there is one, add the cheaper option instead of mine."
    : "- Don't swap anything yet: add my usual items, and list the cheaper options for me to decide."
}
`;

  const report = cheaper.on
    ? `At the end, tell me: what you added, any out-of-stock swaps, anything you couldn't find, and the basket total. Then give me a table of cheaper options: my item, the cheaper option, both unit prices, and the saving per pack${cheaper.swap ? " (these are the swaps you made)" : ""}. End with the total ${cheaper.swap ? "I saved" : "I'd save if I took them all"}.${cheaper.swap ? "" : " I'll tell you which to swap."}`
    : "At the end, tell me: what you added, any swaps, anything you couldn't find, and the basket total.";

  return `Please fill my ${store.name} online basket with my shopping list. I'm signed in to ${store.home} in this browser.

My list:
${list}

How to do it:
1. Go to ${store.home} and check I'm signed in. If I'm not, stop and tell me.
2. For each item, open its link if it has one. If not, search for it by name and pick the closest match: same brand and size first, then the store's own brand in the same size.
3. Add it to the basket with the quantity shown. If it's already in the basket, set the quantity rather than adding more.
4. If something is out of stock, pick a close swap (same type and size) and note it. If there's no sensible swap, skip it.${exact ? " Never swap an item marked [exact]: if it's out of stock, skip it and tell me." : ""}
5. When you're done, open the basket and check the quantities.
${cheaperPart}
Rules:
- Only add things to the basket. Never check out, pay, book or change a delivery slot, use vouchers, or change my account.
- Don't accept any pop-ups that sign me up to anything.
- If anything asks for payment or a password, stop and tell me.

${report}`;
}

/**
 * Shop online: your next shop on the left, and on the right a prompt for Claude in Chrome to fill the basket in
 * your own signed-in store tab, optionally looking for cheaper options. It stops at a filled basket.
 */
export default function ShopOnline({ listSize, catalog, links, groupBy, run }: Props) {
  const [plan, setPlan] = useState<NextShop | null>(null);
  const [storeId, setStoreIdState] = useState(() => remembered(STORE_KEY, "tesco"));
  const [cheaper, setCheaperState] = useState<Cheaper>(() => remembered(CHEAPER_KEY, CHEAPER_DEFAULT));
  const [copied, setCopied] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  // Never swap as just ticked, shown straight away while it saves.
  const [exactNow, setExactNow] = useState<Record<number, boolean>>({});

  useEffect(() => {
    api.nextShop().then(setPlan, () => setPlan(null));
  }, [listSize]);

  const stores = links?.stores ?? [];
  const store = stores.find((s) => s.id === storeId) ?? stores[0];
  if (!plan || !store) return <section><p className="muted">Loading…</p></section>;

  const setStore = (id: string) => {
    setStoreIdState(id);
    remember(STORE_KEY, id);
  };
  const setCheaper = (change: Partial<Cheaper>) => {
    const next = { ...cheaper, ...change };
    setCheaperState(next);
    remember(CHEAPER_KEY, next);
  };

  const items = lines(plan, catalog, store).map((l) => (l.catalogId !== null && l.catalogId in exactNow ? { ...l, exact: exactNow[l.catalogId] } : l));
  const setExact = (id: number, exact: boolean) => {
    setExactNow({ ...exactNow, [id]: exact });
    void run(() => api.editCommon(id, { exact })).then((ok) => {
      if (!ok) setExactNow(({ [id]: _, ...rest }) => rest);
    });
  };
  const text = prompt(store, items, cheaper);
  const saved = items.filter((l) => l.url).length;
  const exactCount = items.filter((l) => l.exact).length;

  const saveLink = async (e: FormEvent, l: Line) => {
    e.preventDefault();
    if (l.catalogId !== null && (await run(() => api.setProduct(l.catalogId!, store.id, pasted)))) {
      setLinking(null);
      setPasted("");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard (not https, or not allowed): select the text so it can be copied by hand.
      const box = document.getElementById("claude-prompt") as HTMLTextAreaElement | null;
      box?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="online-layout">
      <section aria-labelledby="online-list" className="online-main">
        <div className="section-head">
          <h2 id="online-list">Your list</h2>
          <span className="muted">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        </div>
        <p className="muted">
          {saved} with a saved {store.name} product
          {exactCount > 0 && ` · ${exactCount} never swapped`}. Tap an item to look it up on {store.name}.
        </p>

        {items.length === 0 && <p className="empty">Nothing on your next shop yet. Add things on the Next shop page.</p>}
        {groupBy(items).map(([aisle, ls]) => (
          <div key={aisle} className="group">
            <h3>{aisle}</h3>
            <ul className="online-items">
              {ls.map((l) => (
                <li key={l.key}>
                  <div className="online-row">
                    <span className="online-name">
                      <a
                        href={l.url ?? fillLink(store.search, l.choices ? l.choices[0] : l.name)}
                        target="_blank"
                        rel="noreferrer"
                        title={l.url ? `Open the saved ${store.name} product` : `Search ${store.name}`}
                      >
                        {l.choices ? `${l.name}: ${l.choices.join(" or ")}` : l.name}
                      </a>
                      {l.qty > 1 && <span className="muted"> ×{l.qty}</span>}
                      {l.url && (
                        <span className="saved-dot" title="Saved product">
                          ✓
                        </span>
                      )}
                    </span>
                    {l.catalogId !== null && (
                      <span className="online-actions">
                        {linking !== l.key && (
                          <button className="link save-link" onClick={() => (setLinking(l.key), setPasted(""))}>
                            {l.url ? "Change link" : "Save link"}
                          </button>
                        )}
                        <label className="exact" title="Always get exactly this: never swapped for something cheaper or because it's out of stock">
                          <input
                            type="checkbox"
                            checked={l.exact}
                            onChange={(e) => setExact(l.catalogId!, e.target.checked)}
                          />
                          Never swap
                        </label>
                      </span>
                    )}
                  </div>
                  {linking === l.key && (
                    <form className="paste" onSubmit={(e) => saveLink(e, l)}>
                      <input
                        type="text"
                        inputMode="url"
                        autoComplete="off"
                        autoFocus
                        value={pasted}
                        onChange={(e) => setPasted(e.target.value)}
                        placeholder={`Paste the ${store.name} product link`}
                        aria-label={`${store.name} product link for ${l.name}`}
                      />
                      <button type="submit" className="primary" disabled={!pasted.trim()}>
                        Save
                      </button>
                      <button type="button" className="link" onClick={() => setLinking(null)}>
                        Cancel
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-labelledby="prompt-heading" className="online-side">
        <div className="section-head">
          <h2 id="prompt-heading">Fill your basket with Claude</h2>
        </div>
        <div className="store-pick">
          <div className="order" role="radiogroup" aria-label="Store">
            {stores.map((s) => (
              <button key={s.id} role="radio" aria-checked={s.id === store.id} aria-pressed={s.id === store.id} onClick={() => setStore(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
          <a className="button-link" href={store.home} target="_blank" rel="noreferrer">
            Open {store.name} ↗
          </a>
        </div>

        <details className="howto">
          <summary>How this works</summary>
          <ol>
            <li>
              <strong>Book your slot</strong> on {store.name} yourself. Nothing here books or changes one.
            </li>
            <li>
              <strong>Open {store.name}</strong> in Chrome and sign in.
            </li>
            <li>
              <strong>Open Claude in Chrome</strong> on that tab, copy the prompt below and paste it in. Claude adds each item to your
              basket and tells you what it swapped or couldn't find.
            </li>
            <li>
              <strong>Check the basket</strong> and check out yourself. Claude is told never to check out, pay or touch your slot.
            </li>
          </ol>
          <p className="muted">
            Items with a saved product link go straight to the right product. Use <em>Save link</em> to paste a product's address so
            it's exact next time, and <em>Never swap</em> for things you're particular about.
          </p>
        </details>

        <fieldset className="cheaper">
          <legend>
            <label>
              <input type="checkbox" checked={cheaper.on} onChange={(e) => setCheaper({ on: e.target.checked })} /> Look for cheaper options
            </label>
          </legend>
          {cheaper.on && (
            <>
              <div className="choice" role="radiogroup" aria-label="What to do with cheaper options">
                <label>
                  <input type="radio" name="cheaper-mode" checked={!cheaper.swap} onChange={() => setCheaper({ swap: false })} />
                  <span>
                    <strong>Suggest only</strong> <span className="muted">· adds your usual items and lists what's cheaper</span>
                  </span>
                </label>
                <label>
                  <input type="radio" name="cheaper-mode" checked={cheaper.swap} onChange={() => setCheaper({ swap: true })} />
                  <span>
                    <strong>Swap automatically</strong> <span className="muted">· adds the cheaper one and tells you what it swapped</span>
                  </span>
                </label>
              </div>
              <p className="saving">
                Only if it saves at least{" "}
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={cheaper.percent}
                  aria-label="Smallest saving, percent"
                  onChange={(e) => Number(e.target.value) >= 1 && setCheaper({ percent: Math.min(90, Math.round(Number(e.target.value))) })}
                />
                % or{" "}
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={cheaper.cents}
                  aria-label="Smallest saving, cents a pack"
                  onChange={(e) => Number(e.target.value) >= 0 && setCheaper({ cents: Math.min(500, Math.round(Number(e.target.value))) })}
                />
                c a pack.
              </p>
              <p className="muted hint">
                Compared by unit price (€/kg, €/L), like for like, own brand welcome.{" "}
                {exactCount > 0 ? `${exactCount} ${exactCount === 1 ? "item is" : "items are"} marked Never swap and left alone.` : "Tick Never swap on anything you want exactly as it is."}
              </p>
            </>
          )}
        </fieldset>

        <div className="section-head prompt-head">
          <h3>Prompt for Claude in Chrome</h3>
          <button className="primary" onClick={copy} disabled={items.length === 0}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <textarea id="claude-prompt" className="prompt" readOnly value={text} rows={14} aria-label="Prompt for Claude in Chrome" onFocus={(e) => e.target.select()} />
        <p className="muted hint">Paste this into Claude in Chrome on your {store.name} tab. It stops at a filled basket: you check out yourself.</p>
      </section>
    </div>
  );
}
