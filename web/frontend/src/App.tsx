import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type CatalogItem, type ListItem } from "./api";

const POLL_MS = 10_000;

function groupBy<T extends { category: string }>(items: T[], order: string[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  return [...groups.entries()].sort(([a], [b]) => rank(order, a) - rank(order, b));
}
const rank = (order: string[], c: string) => (order.includes(c) ? order.indexOf(c) : order.length);

export default function App() {
  const [categories, setCategories] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [list, setList] = useState<ListItem[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Other");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cats, cat, items] = await Promise.all([api.categories(), api.catalog(), api.list()]);
      setCategories(cats);
      setCatalog(cat);
      setList(items);
      setError(null);
    } catch {
      setError("Can't reach the server. Check it's running.");
    } finally {
      setLoaded(true);
    }
  }, []);

  // Pick up changes made on other devices.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => document.visibilityState === "visible" && void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    }
  };

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
  const matches = q ? catalog.filter((c) => c.name.toLowerCase().includes(q)) : catalog;
  // An exact name, or the only item matching what's typed, is what Add picks.
  const exact = catalog.find((c) => c.name.toLowerCase() === q) ?? (q && matches.length === 1 ? matches[0] : undefined);
  const remaining = list.filter((i) => !i.done).length;
  const ticked = list.length - remaining;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q) return;
    const name = exact?.name ?? query.trim();
    void run(() => api.add(name, exact?.category ?? category));
    setQuery("");
  };

  return (
    <main>
      <header>
        <h1>Shopping list</h1>
        <p className="muted">
          {remaining === 0 ? "Nothing to buy yet" : `${remaining} to buy`}
          {ticked > 0 && ` · ${ticked} in the trolley`}
        </p>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

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
        {groupBy(list, categories).map(([cat, items]) => (
          <div key={cat} className="group">
            <h3>{cat}</h3>
            <ul className="items">
              {items.map((item) => (
                <li key={item.id} className={item.done ? "done" : ""}>
                  <label className="tick">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => change(item, { done: !item.done })}
                    />
                    <span>{item.name}</span>
                  </label>
                  <div className="qty" aria-label={`Quantity of ${item.name}`}>
                    <button
                      aria-label="One fewer"
                      disabled={item.qty <= 1}
                      onClick={() => change(item, { qty: item.qty - 1 })}
                    >
                      −
                    </button>
                    <span>{item.qty}</span>
                    <button
                      aria-label="One more"
                      disabled={item.qty >= 99}
                      onClick={() => change(item, { qty: item.qty + 1 })}
                    >
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

      <section aria-labelledby="add-heading" className="add">
        <h2 id="add-heading">Add items</h2>
        <form onSubmit={submit} className="add-form">
          <input
            type="search"
            placeholder="Search or type anything…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Item name"
            maxLength={80}
          />
          {q && !exact && (
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Aisle">
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          <button type="submit" className="primary" disabled={!q}>
            {exact && exact.name.toLowerCase() !== q ? `Add ${exact.name}` : "Add"}
          </button>
        </form>
        {q && !exact && (
          <p className="muted hint">
            “{query.trim()}” isn't a common item yet. Pick an aisle and tap Add: it'll be here next time.
          </p>
        )}

        {groupBy(matches, categories).map(([cat, items]) => (
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
                    {c.custom && (
                      <button
                        className="forget"
                        aria-label={`Forget ${c.name}`}
                        title="Remove from common items"
                        onClick={() => run(() => api.forget(c.id))}
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
