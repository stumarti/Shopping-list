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
const FRAME = "store-frame";

function savedStore() {
  try {
    return localStorage.getItem(STORE_KEY) ?? "tesco";
  } catch {
    return "tesco";
  }
}

/** One line of the shop as the store will see it: what to get, and the exact product if one is saved. */
type Line = { key: string; catalogId: number | null; name: string; qty: number; category: string; url: string | null; choices: string[] | null };

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
    };
  });
}

/** What to ask Claude in Chrome to do. It fills the basket and stops: you check out yourself. */
function prompt(store: Store, items: Line[]): string {
  const list = items
    .map((l) => {
      const what = l.choices ? `one of: ${l.choices.join(" or ")}` : l.name;
      return `- ${l.qty} × ${what}${l.url ? ` (${l.url})` : ""}`;
    })
    .join("\n");
  return `Please fill my ${store.name} online basket with my shopping list. I'm signed in to ${store.home} in this browser.

My list:
${list}

How to do it:
1. Go to ${store.home} and check I'm signed in. If I'm not, stop and tell me.
2. For each item, open its link if it has one. If not, search for it by name and pick the closest match: same brand and size first, then the store's own brand in the same size.
3. Add it to the basket with the quantity shown. If it's already in the basket, set the quantity rather than adding more.
4. If something is out of stock, pick a close swap (same type and size) and note it. If there's no sensible swap, skip it.
5. When you're done, open the basket and check the quantities.

Rules:
- Only add things to the basket. Never check out, pay, book or change a delivery slot, use vouchers, or change my account.
- Don't accept any pop-ups that sign me up to anything.
- If anything asks for payment or a password, stop and tell me.

At the end, tell me: what you added, any swaps, anything you couldn't find, and the basket total.`;
}

/**
 * Shop online: your next shop on the left, with how-to and a prompt for Claude in Chrome to fill the basket, and
 * the store on the right. Most stores won't show inside another site, so there's always a link to open it in a tab.
 */
export default function ShopOnline({ listSize, catalog, links, groupBy, run }: Props) {
  const [plan, setPlan] = useState<NextShop | null>(null);
  const [storeId, setStoreIdState] = useState(savedStore);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    api.nextShop().then(setPlan, () => setPlan(null));
  }, [listSize]);

  const stores = links?.stores ?? [];
  const store = stores.find((s) => s.id === storeId) ?? stores[0];
  if (!plan || !store) return <section><p className="muted">Loading…</p></section>;

  const setStore = (id: string) => {
    setStoreIdState(id);
    setFrameUrl(null);
    try {
      localStorage.setItem(STORE_KEY, id);
    } catch {
      // Not remembered on this device.
    }
  };

  const items = lines(plan, catalog, store);
  const text = prompt(store, items);
  const saved = items.filter((l) => l.url).length;
  const shown = frameUrl ?? store.home;

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
      <div className="online-main">
        <section aria-labelledby="online-list">
          <div className="section-head">
            <h2 id="online-list">Your list</h2>
            <div className="order" role="radiogroup" aria-label="Store">
              {stores.map((s) => (
                <button key={s.id} role="radio" aria-checked={s.id === store.id} aria-pressed={s.id === store.id} onClick={() => setStore(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <p className="muted">
            {items.length} {items.length === 1 ? "item" : "items"} for your next shop · {saved} with a saved {store.name} product
          </p>

          <details className="howto">
            <summary>How this works</summary>
            <ol>
              <li>
                <strong>Book your slot</strong> on {store.name} yourself. Nothing here books or changes one.
              </li>
              <li>
                <strong>Sign in to {store.name}</strong> in a Chrome tab (
                <a href={store.home} target="_blank" rel="noreferrer">
                  open {store.name}
                </a>
                ). Stores don't usually let you sign in inside the panel on the right.
              </li>
              <li>
                <strong>Open Claude in Chrome</strong> on that tab, then copy the prompt below and paste it in. Claude adds each item to
                your basket and tells you what it swapped or couldn't find.
              </li>
              <li>
                <strong>Check the basket</strong> and check out yourself. Claude is told never to check out, pay or touch your slot.
              </li>
            </ol>
            <p className="muted">
              Items with a saved product link go straight to the right product. Tap an item below to look it up in the store panel,
              then use <em>Save link</em> to paste the product's address so it's exact next time.
            </p>
          </details>

          {items.length === 0 && (
            <p className="empty">
              Nothing on your next shop yet. Add things on the Next shop page.
            </p>
          )}
          {groupBy(items).map(([aisle, ls]) => (
            <div key={aisle} className="group">
              <h3>{aisle}</h3>
              <ul className="online-items">
                {ls.map((l) => (
                  <li key={l.key}>
                    <a
                      href={l.url ?? fillLink(store.search, l.choices ? l.choices[0] : l.name)}
                      target={FRAME}
                      onClick={(e) => {
                        e.preventDefault();
                        setFrameUrl(e.currentTarget.href);
                      }}
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
                    {l.catalogId !== null && linking !== l.key && (
                      <button className="link save-link" onClick={() => (setLinking(l.key), setPasted(""))}>
                        {l.url ? "Change link" : "Save link"}
                      </button>
                    )}
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

        <section aria-labelledby="prompt-heading">
          <div className="section-head">
            <h2 id="prompt-heading">Prompt for Claude in Chrome</h2>
            <button className="primary" onClick={copy} disabled={items.length === 0}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea id="claude-prompt" className="prompt" readOnly value={text} rows={12} aria-label="Prompt for Claude in Chrome" onFocus={(e) => e.target.select()} />
          <p className="muted hint">
            Paste this into Claude in Chrome on your {store.name} tab. It stops at a filled basket: you check out yourself.
          </p>
        </section>
      </div>

      <section className="online-store" aria-label={`${store.name} website`}>
        <div className="store-bar">
          <span className="muted store-url" title={shown}>
            {shown.replace(/^https:\/\//, "")}
          </span>
          {frameUrl && (
            <button className="link" onClick={() => setFrameUrl(null)}>
              Home
            </button>
          )}
          <a className="link" href={shown} target="_blank" rel="noreferrer">
            Open in a new tab ↗
          </a>
        </div>
        <iframe key={store.id} name={FRAME} src={shown} title={`${store.name} website`} referrerPolicy="no-referrer" />
        <p className="muted hint">If the store stays blank here, it doesn't allow being shown inside other sites. Use Open in a new tab.</p>
      </section>
    </div>
  );
}
