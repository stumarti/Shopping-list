import { useEffect, useState, type FormEvent } from "react";
import { api, type ShopItem } from "./api";
import Icon from "./Icon";

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type Row = { key: string; name: string; qty: number; price: string; on: boolean; options?: string[] };
export type Recorded = { order_ref: string; store: string; bought_on: string; products: number };

const STORES = ["Tesco", "Dunnes", "Lidl", "Aldi", "SuperValu"];
const STORE_KEY = "shopping-list.recorded-store";
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Record a shop you did yourself (any shop), so the history and the next shop move on. Starts from the next
 * shop's items, with what's in the trolley already ticked; add anything else you bought.
 */
export default function RecordShop({
  items,
  inTrolley,
  run,
  onClose,
  onRecorded,
}: {
  items: ShopItem[];
  inTrolley: (i: ShopItem) => boolean;
  run: Run;
  onClose: () => void;
  onRecorded: (r: Recorded) => void;
}) {
  const [store, setStore] = useState(() => {
    try {
      return localStorage.getItem(STORE_KEY) ?? "Tesco";
    } catch {
      return "Tesco";
    }
  });
  const [date, setDate] = useState(todayIso);
  const [rows, setRows] = useState<Row[]>(() =>
    items.map((i) => {
      const picked = i.options?.find((o) => o.catalog_id === i.chosen);
      const options = i.kind === "or" && !picked ? (i.options ?? []).map((o) => o.name) : undefined;
      return { key: `${i.catalog_id ?? "l" + i.list_item_id}`, name: picked?.name ?? options?.[0] ?? i.name, qty: i.qty, price: "", on: inTrolley(i), options };
    }),
  );
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const change = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addExtra = (e: FormEvent) => {
    e.preventDefault();
    const name = extra.trim();
    if (!name) return;
    setRows((rs) => [...rs, { key: `x${Date.now()}`, name, qty: 1, price: "", on: true }]);
    setExtra("");
  };

  const chosen = rows.filter((r) => r.on && r.name.trim());
  const save = () => {
    const priced = chosen.map((r) => ({ name: r.name.trim(), qty: r.qty, price: r.price.trim() === "" ? null : Number(r.price.replace(",", ".")) }));
    if (priced.some((p) => p.price !== null && !(p.price >= 0))) return setError("A price should be a number, like 2.19.");
    setError(null);
    void run(async () => {
      const r = await api.recordShop(store.trim() || "Shop", date, priced);
      try {
        localStorage.setItem(STORE_KEY, store.trim());
      } catch {
        // Not remembered on this device.
      }
      onRecorded(r);
    });
  };

  return (
    <div className="scanner-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="scanner record-shop" role="dialog" aria-modal="true" aria-labelledby="record-heading">
        <div className="section-head">
          <h2 id="record-heading">Record a shop</h2>
          <button className="remove" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <p className="muted part-note">What you bought, where and when, so the next shop moves on. Anything bought comes off the list.</p>

        <fieldset className="record-where">
          <legend>Where</legend>
          <div className="aisle-chips">
            {STORES.map((s) => (
              <button key={s} type="button" className={store === s ? "on" : ""} aria-pressed={store === s} onClick={() => setStore(s)}>
                {s}
              </button>
            ))}
          </div>
          <input value={STORES.includes(store) ? "" : store} onChange={(e) => setStore(e.target.value)} placeholder="Or another shop" aria-label="Another shop" maxLength={40} />
        </fieldset>

        <label className="record-when">
          <span>When</span>
          <input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </label>

        <div className="record-items">
          <div className="record-head muted">
            <span>Bought</span>
            <span>Qty</span>
            <span>€ each</span>
          </div>
          <ul>
            {rows.map((r) => (
              <li key={r.key} className={r.on ? "" : "off"}>
                <label className="record-name">
                  <input type="checkbox" checked={r.on} onChange={(e) => change(r.key, { on: e.target.checked })} />
                  {r.options ? (
                    <select value={r.name} onChange={(e) => change(r.key, { name: e.target.value, on: true })} aria-label="Which one">
                      {r.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <span>{r.name}</span>
                  )}
                </label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={r.qty}
                  aria-label={`How many ${r.name}`}
                  onChange={(e) => Number(e.target.value) >= 1 && change(r.key, { qty: Math.min(99, Math.round(Number(e.target.value))), on: true })}
                />
                <input
                  inputMode="decimal"
                  value={r.price}
                  placeholder="–"
                  aria-label={`Price each for ${r.name}`}
                  onChange={(e) => change(r.key, { price: e.target.value.replace(/[^\d.,]/g, ""), on: true })}
                />
              </li>
            ))}
          </ul>
          <form className="add-form" onSubmit={addExtra}>
            <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Something else you bought…" aria-label="Something else you bought" maxLength={120} />
            <button type="submit" className="link" disabled={!extra.trim()}>
              <Icon name="add" size={18} /> Add
            </button>
          </form>
        </div>

        {error && <p className="error-text">{error}</p>}
        <button className="primary record-save" disabled={chosen.length === 0 || !date} onClick={save}>
          <Icon name="checked" size={18} /> Record {chosen.length} {chosen.length === 1 ? "thing" : "things"}
          {store.trim() && ` from ${store.trim()}`}
        </button>
      </div>
    </div>
  );
}
