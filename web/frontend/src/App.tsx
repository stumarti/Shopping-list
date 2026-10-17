import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, isBarcode, itemLinks, type CatalogItem, type Links, type ListItem, type Product } from "./api";
import Manage from "./Manage";
import NextShop from "./NextShop";
import Settings from "./Settings";
import ShopOnline from "./ShopOnline";
import Icon, { type IconName } from "./Icon";
import ThemeSwitch from "./Theme";
import Suggestions from "./Suggestions";

// The old tick-off list is switched off for now; flip this to bring it back.
const SHOW_LIST = false;

const POLL_MS = 10_000;

type Tab = "list" | "common" | "shop" | "settings";
const TABS: [Tab, string, IconName][] = [
  ["list", "Next shop", "cart"],
  ["shop", "Shop online", "store"],
  ["common", "Common items", "list"],
];
const tabFromHash = (): Tab =>
  location.hash === "#settings" ? "settings" : (TABS.find(([t]) => location.hash === `#${t}` && t !== "list")?.[0] ?? "list");

const rank = (order: string[], c: string) => (order.includes(c) ? order.indexOf(c) : order.length);

const SOURCE_NAMES: Record<string, string> = {
  openfoodfacts: "Open Food Facts",
  openbeautyfacts: "Open Beauty Facts",
  openproductsfacts: "Open Products Facts",
  openpetfoodfacts: "Open Pet Food Facts",
  yours: "your common items",
};

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [categories, setCategories] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [list, setList] = useState<ListItem[]>([]);
  const [links, setLinks] = useState<Links | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Other");
  const [scanned, setScanned] = useState<Product | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cats, cat, items] = await Promise.all([api.categories(), api.catalog(), api.list()]);
      setCategories(cats);
      setCatalog(cat);
      setList(items);
    } catch {
      setError("Can't reach the server. Check it's running.");
    } finally {
      setLoaded(true);
    }
  }, []);

  // Pick up changes made on other devices.
  useEffect(() => {
    void refresh();
    api.links().then(setLinks, () => setLinks(null));
    const timer = setInterval(() => document.visibilityState === "visible" && void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("focus", onFocus);
    window.addEventListener("hashchange", onHash);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("hashchange", onHash);
    };
  }, [refresh]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      return false;
    } finally {
      await refresh();
    }
  };

  const groupBy = useCallback(
    <T extends { category: string }>(items: T[]): [string, T[]][] => {
      const groups = new Map<string, T[]>();
      for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
      return [...groups.entries()].sort(([a], [b]) => rank(categories, a) - rank(categories, b));
    },
    [categories],
  );

  // Ticks and quantities change on screen straight away; the server catches up behind.
  const change = (item: ListItem, patch: Partial<Pick<ListItem, "qty" | "done">>) => {
    setList((items) => items.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    void run(() => api.change(item.id, patch));
  };

  const onList = useMemo(() => {
    const m = new Map<string, ListItem>();
    for (const i of list) if (!i.done) m.set(i.name.toLowerCase(), i);
    return m;
  }, [list]);

  const q = query.trim().toLowerCase();
  const typedBarcode = isBarcode(query);
  const buyable = catalog.filter((c) => c.kind !== "or");
  const matches = q && !typedBarcode ? buyable.filter((c) => c.name.toLowerCase().includes(q)) : buyable;
  // An exact name, or the only item matching what's typed, is what Add picks.
  const exact = typedBarcode
    ? undefined
    : (buyable.find((c) => c.name.toLowerCase() === q) ?? (q && matches.length === 1 ? matches[0] : undefined));
  const remaining = list.filter((i) => !i.done).length;
  const ticked = list.length - remaining;

  const lookUp = async () => {
    setLooking(true);
    try {
      const product = await api.barcode(query.trim());
      setScanned(product);
      setCategory(product.category);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't look that barcode up.");
    } finally {
      setLooking(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q) return;
    if (typedBarcode) return void lookUp();
    const name = exact?.name ?? query.trim();
    void run(() => api.add(name, exact?.category ?? category));
    setQuery("");
  };

  const addScanned = (name: string) => {
    if (!scanned) return;
    const code = scanned.barcode;
    void run(() => api.add(name, category, 1, code));
    setScanned(null);
    setQuery("");
  };

  const go = (t: Tab) => {
    history.replaceState(null, "", t === "list" ? location.pathname : `#${t}`);
    setTab(t);
  };

  return (
    <main className={tab === "list" || tab === "shop" ? "wide" : undefined}>
      <header>
        <div className="title-row">
          <h1>Shopping list</h1>
          <span className="header-links">
            <ThemeSwitch />
            <a
              href="#settings"
              className={`settings-link${tab === "settings" ? " on" : ""}`}
              aria-current={tab === "settings" ? "page" : undefined}
              onClick={(e) => (e.preventDefault(), go("settings"))}
              title="Settings"
            >
              <Icon name="settings" /> <span className="label">Settings</span>
            </a>
          </span>
        </div>
        {SHOW_LIST && (
          <p className="muted">
            {remaining === 0 ? "Nothing to buy yet" : `${remaining} to buy`}
            {ticked > 0 && ` · ${ticked} in the trolley`}
          </p>
        )}
        <nav className="tabs" aria-label="Pages">
          {TABS.map(([t, label, icon]) => (
            <button key={t} className={tab === t ? "on" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => go(t)}>
              <Icon name={icon} size={22} /> <span>{label}</span>
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {tab === "settings" ? (
        <Settings categories={categories} run={run} />
      ) : tab === "common" ? (
        <Manage catalog={catalog} categories={categories} links={links} groupBy={groupBy} run={run} />
      ) : tab === "shop" ? (
        <ShopOnline listSize={list.length} catalog={catalog} links={links} groupBy={groupBy} run={run} />
      ) : !SHOW_LIST ? (
        <NextShop listSize={list.length} catalog={catalog} groupBy={groupBy} run={run} />
      ) : (
        <>
          <section aria-labelledby="list-heading">
            <div className="section-head">
              <h2 id="list-heading">My list</h2>
              {ticked > 0 && (
                <button className="link" onClick={() => run(api.clearDone)}>
                  Clear ticked
                </button>
              )}
            </div>
            {loaded && list.length === 0 && <p className="empty">Tap a common item below, or type what you need.</p>}
            {groupBy(list).map(([cat, items]) => (
              <div key={cat} className="group">
                <h3>{cat}</h3>
                <ul className="items">
                  {items.map((item) => (
                    <li key={item.id} className={item.done ? "done" : ""}>
                      <div className="item-main">
                        <label className="tick">
                          <input type="checkbox" checked={item.done} onChange={() => change(item, { done: !item.done })} />
                          <span>{item.name}</span>
                        </label>
                        <ItemLinks links={links} item={item} />
                      </div>
                      <div className="qty" aria-label={`Quantity of ${item.name}`}>
                        <button aria-label="One fewer" disabled={item.qty <= 1} onClick={() => change(item, { qty: item.qty - 1 })}>
                          −
                        </button>
                        <span>{item.qty}</span>
                        <button aria-label="One more" disabled={item.qty >= 99} onClick={() => change(item, { qty: item.qty + 1 })}>
                          +
                        </button>
                      </div>
                      <button className="remove" aria-label={`Remove ${item.name}`} onClick={() => run(() => api.remove(item.id))}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <Suggestions onList={onList} listSize={list.length} run={run} />

          <section aria-labelledby="add-heading" className="add">
            <h2 id="add-heading">Add items</h2>
            <form onSubmit={submit} className="add-form">
              <input
                type="search"
                placeholder="Item or barcode…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setScanned(null);
                }}
                aria-label="Item name or barcode"
                maxLength={80}
              />
              {q && !exact && !typedBarcode && (
                <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Aisle">
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              )}
              <button type="submit" className="primary" disabled={!q || looking}>
                {typedBarcode ? (looking ? "Looking…" : "Look up") : exact && exact.name.toLowerCase() !== q ? `Add ${exact.name}` : "Add"}
              </button>
            </form>
            {scanned && (
              <ScannedProduct
                key={scanned.barcode}
                product={scanned}
                categories={categories}
                category={category}
                setCategory={setCategory}
                onAdd={addScanned}
              />
            )}
            {q && !exact && !typedBarcode && (
              <p className="muted hint">“{query.trim()}” isn't a common item yet. Pick an aisle and tap Add: it'll be here next time.</p>
            )}
            {typedBarcode && !scanned && (
              <p className="muted hint">That looks like a barcode. Tap Look up to find it in {links?.barcodes.name ?? "the barcode directory"}.</p>
            )}

            {groupBy(matches).map(([cat, items]) => (
              <div key={cat} className="group">
                <h3>{cat}</h3>
                <div className="chips">
                  {items.map((c) => {
                    const on = onList.get(c.name.toLowerCase());
                    return (
                      <span key={c.id} className={`chip${on ? " on" : ""}`}>
                        <button onClick={() => run(() => api.add(c.name, c.category))} title={`Add ${c.name}`}>
                          {on ? `✓ ${c.name}${on.qty > 1 ? ` ×${on.qty}` : ""}` : `+ ${c.name}`}
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="muted hint">
              Missing something you buy often?{" "}
              <a href="#common" onClick={(e) => (e.preventDefault(), go("common"))}>
                Build your common items
              </a>
              .
            </p>
          </section>
        </>
      )}
    </main>
  );
}

function ItemLinks({ links, item }: { links: Links | null; item: { name: string; barcode: string } }) {
  return (
    <span className="links">
      {itemLinks(links, item).map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noreferrer" title={l.title}>
          {l.label}
        </a>
      ))}
    </span>
  );
}

function ScannedProduct({
  product,
  categories,
  category,
  setCategory,
  onAdd,
}: {
  product: Product;
  categories: string[];
  category: string;
  setCategory: (c: string) => void;
  onAdd: (name: string) => void;
}) {
  const brand = product.brand && !product.name.toLowerCase().includes(product.brand.toLowerCase()) ? product.brand : "";
  const [name, setName] = useState([brand, product.name, product.quantity].filter(Boolean).join(" "));
  return (
    <div className="scanned" role="status">
      <p className="muted">
        Found {product.barcode} in {SOURCE_NAMES[product.source] ?? product.source}. Check the name, then add it:
      </p>
      <form
        className="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onAdd(name.trim());
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name for this product" maxLength={80} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Aisle for this product">
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button type="submit" className="primary" disabled={!name.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
