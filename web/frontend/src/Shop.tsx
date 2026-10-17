import { useState, type FormEvent } from "react";
import { api, fillLink, type Links, type ListItem } from "./api";
import History from "./History";

type Props = {
  list: ListItem[];
  links: Links | null;
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

const SCRIPT_PATH = "/userscript/shopping-list.user.js";

/** Get the list into a Tesco or Dunnes basket: save the exact product once, then the browser helper adds them. */
export default function Shop({ list, links, groupBy, run }: Props) {
  const stores = links?.stores ?? [];
  const [storeId, setStoreId] = useState("tesco");
  const store = stores.find((s) => s.id === storeId) ?? stores[0];
  const toBuy = list.filter((i) => !i.done);
  const linked = toBuy.filter((i) => store && i.products[store.id]).length;
  const onList = new Set(toBuy.map((i) => i.name.toLowerCase()));

  if (!store) return <section><p className="muted">Loading…</p></section>;

  return (
    <>
      <section aria-labelledby="shop-heading">
        <h2 id="shop-heading">Fill an online basket</h2>
        <div className="tabs stores" role="radiogroup" aria-label="Store">
          {stores.map((s) => (
            <button key={s.id} role="radio" aria-checked={s.id === store.id} className={s.id === store.id ? "on" : ""} onClick={() => setStoreId(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
        <ol className="steps">
          <li>
            <strong>Book your slot</strong> in the {store.name} app or website. This never books or changes one.
          </li>
          <li>
            <strong>Save the product</strong> you buy for each item below. You only do this once per item.
          </li>
          <li>
            <strong>Open {store.name}</strong> in Chrome with the helper installed and press <em>Fill basket from my list</em>.
            It adds everything with a saved product, ticks it off here, and stops at a full basket. You check out yourself.
          </li>
        </ol>
        <details className="install">
          <summary>Install the browser helper (once per computer)</summary>
          <ol>
            <li>
              In Chrome or Edge, install <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">Tampermonkey</a>. On iPhone or iPad, install
              the free <em>Userscripts</em> app and turn it on in Safari's extensions.
            </li>
            <li>
              Open <a className="script" href={SCRIPT_PATH}>
                {location.origin + SCRIPT_PATH}
              </a> and press <em>Install</em>.
            </li>
            <li>The first time it talks to this server, Tampermonkey asks permission. Choose <em>Always allow</em>.</li>
          </ol>
          <p className="muted">It updates itself from this server. It only runs on tesco.ie and dunnesstoresgrocery.com.</p>
        </details>
      </section>

      <section aria-labelledby="products-heading">
        <div className="section-head">
          <h2 id="products-heading">Your {store.name} products</h2>
          <span className="muted">
            {linked} of {toBuy.length} saved
          </span>
        </div>
        {toBuy.length === 0 && <p className="empty">Nothing on your list to buy.</p>}
        {groupBy(toBuy).map(([cat, items]) => (
          <div key={cat} className="group">
            <h3>{cat}</h3>
            <ul className="shop-list">
              {items.map((item) => (
                <ProductRow key={`${item.id}:${store.id}`} item={item} store={store} run={run} />
              ))}
            </ul>
          </div>
        ))}
        <p className="muted hint">
          You can also save products while browsing {store.name}: open a product, and use <em>Save this product for</em> in the helper's panel.
        </p>
      </section>

      <History storeName={store.name} onList={onList} listSize={list.length} run={run} />
    </>
  );
}

function ProductRow({ item, store, run }: { item: ListItem; store: { id: string; name: string; search: string }; run: Props["run"] }) {
  const saved = item.products[store.id];
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.linkItem(item.id, store.id, url))) {
      setUrl("");
      setEditing(false);
    }
  };

  return (
    <li>
      <div className="shop-name">
        <span>
          {item.name}
          {item.qty > 1 && <span className="muted"> ×{item.qty}</span>}
        </span>
        {saved && !editing ? (
          <span className="saved">
            <a href={saved.url} target="_blank" rel="noreferrer" title={saved.url}>
              ✓ {saved.title || `Product ${saved.url.match(/(\d{5,})$/)?.[1] ?? "saved"}`}
            </a>
            <button className="link" onClick={() => setEditing(true)}>
              Change
            </button>
          </span>
        ) : (
          <a className="find" href={fillLink(store.search, item.name)} target="_blank" rel="noreferrer">
            Find on {store.name}
          </a>
        )}
      </div>
      {(!saved || editing) && (
        <form className="paste" onSubmit={save}>
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={`Paste the ${store.name} product link`}
            aria-label={`${store.name} product link for ${item.name}`}
          />
          <button type="submit" className="primary" disabled={!url.trim()}>
            Save
          </button>
          {editing && (
            <button type="button" className="link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      )}
    </li>
  );
}
