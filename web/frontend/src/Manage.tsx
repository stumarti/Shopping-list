import { useEffect, useState } from "react";
import { api, itemLinks, type CatalogItem, type ItemHistory, type Links } from "./api";
import WeeklyChart from "./WeeklyChart";

type Props = {
  catalog: CatalogItem[];
  categories: string[];
  links: Links | null;
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

const euro = (n: number) => `€${n.toFixed(2)}`;
const day = (iso: string) => new Date(iso.slice(0, 10) + "T12:00:00");
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) =>
  day(iso).toLocaleDateString("en-IE", opts);
const daysFromToday = (iso: string) => Math.round((day(iso).getTime() - day(new Date().toISOString()).getTime()) / 86_400_000);

/** Your common items, aisle by aisle. Tap one for its weekly history and when you'll want it next. */
export default function Manage({ catalog, categories, links, groupBy, run }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const f = filter.trim().toLowerCase();
  const shown = f ? catalog.filter((c) => c.name.toLowerCase().includes(f) || c.barcode.includes(f)) : catalog;

  return (
    <section aria-labelledby="common-heading">
      <div className="section-head">
        <h2 id="common-heading">Common items</h2>
        <span className="muted">{catalog.length} items</span>
      </div>
      {catalog.length === 0 ? (
        <p className="empty">
          No common items yet. Upload your Tesco data, or add some, in <a href="#settings">Settings</a>.
        </p>
      ) : (
        <input
          type="search"
          className="filter"
          placeholder="Find an item or barcode…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Find a common item"
        />
      )}
      {groupBy(shown).map(([cat, items]) => (
        <div key={cat} className="group">
          <h3>
            {cat} <span className="count">{items.length}</span>
          </h3>
          <ul className="common-list">
            {items.map((item) => (
              <li key={item.id} className={open === item.id ? "open" : ""}>
                <button className="common-name" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>
                  <span>{item.name}</span>
                  <span className="chev" aria-hidden="true">
                    {open === item.id ? "▾" : "▸"}
                  </span>
                </button>
                {open === item.id && <ItemDetail item={item} categories={categories} links={links} run={run} onGone={() => setOpen(null)} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function ItemDetail({
  item,
  categories,
  links,
  run,
  onGone,
}: {
  item: CatalogItem;
  categories: string[];
  links: Links | null;
  run: Props["run"];
  onGone: () => void;
}) {
  const [history, setHistory] = useState<ItemHistory | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [name, setName] = useState(item.name);
  const [barcode, setBarcode] = useState(item.barcode);

  useEffect(() => {
    api.itemHistory(item.id).then(setHistory, () => setHistory(null));
  }, [item.id]);
  useEffect(() => {
    setName(item.name);
    setBarcode(item.barcode);
  }, [item.name, item.barcode]);

  const save = (change: Partial<Pick<CatalogItem, "name" | "category" | "barcode">>) =>
    run(() => api.editCommon(item.id, change)).then((ok) => {
      if (!ok) {
        setName(item.name);
        setBarcode(item.barcode);
      }
    });

  const s = history?.summary;
  const bought = history?.purchases.length ?? 0;

  return (
    <div className="detail">
      {!history ? (
        <p className="muted">Loading…</p>
      ) : bought === 0 ? (
        <p className="muted">No purchases of this yet.</p>
      ) : (
        <>
          <p className="next">
            <NextPurchase expected={s!.next_expected} />
          </p>
          <p className="muted stats">
            Bought {s!.trips} {s!.trips === 1 ? "time" : "times"}
            {s!.every_days !== null && `, about every ${s!.every_days === 7 ? "week" : `${s!.every_days} days`}`}, last {fmt(s!.last_bought)}
            {s!.usual_qty > 1 && `. Usually ${Math.round(s!.usual_qty)} at a time`}
            {s!.price && (
              <>
                . {euro(s!.price.now)} each
                {s!.price.low !== s!.price.high && ` (between ${euro(s!.price.low)} and ${euro(s!.price.high)})`}
              </>
            )}
            .
          </p>
          <h4>Weeks you bought it</h4>
          <WeeklyChart weeks={history.weekly} expected={s!.next_expected} />
          <button className="link" onClick={() => setShowTable(!showTable)} aria-expanded={showTable}>
            {showTable ? "Hide" : "Show"} every purchase
          </button>
          {showTable && (
            <table className="purchases">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Each</th>
                  <th scope="col">Where</th>
                </tr>
              </thead>
              <tbody>
                {[...history.purchases].reverse().map((p, i) => (
                  <tr key={i}>
                    <td>
                      {fmt(p.bought_at || p.bought_on)}
                      {p.bought_at.length > 10 && <span className="muted"> {p.bought_at.slice(11, 16)}</span>}
                    </td>
                    <td>{p.qty}</td>
                    <td>{p.unit_price === null ? "–" : euro(p.unit_price)}</td>
                    <td className="muted">{p.source === "order" ? "online order" : p.source.replace("clubcard ", "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div className="edit-fields">
        <label>
          <span>Name</span>
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => (name.trim() && name.trim() !== item.name ? save({ name }) : setName(item.name))}
          />
        </label>
        <label>
          <span>Aisle</span>
          <select value={item.category} onChange={(e) => save({ category: e.target.value })}>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          <span>
            Barcode
            {item.barcode && item.barcode_source && item.barcode_source !== "you" && <em className="muted"> (found in Open Food Facts)</em>}
          </span>
          <input
            value={barcode}
            inputMode="numeric"
            maxLength={14}
            placeholder="None"
            onChange={(e) => setBarcode(e.target.value.replace(/\D/g, ""))}
            onBlur={() => barcode !== item.barcode && save({ barcode })}
          />
        </label>
      </div>
      <div className="detail-foot">
        <span className="links">
          {itemLinks(links, item).map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer" title={l.title}>
              {l.label}
            </a>
          ))}
        </span>
        <button
          className="link danger"
          onClick={async () => {
            if (await run(() => api.forget(item.id))) onGone();
          }}
        >
          Delete item
        </button>
      </div>
    </div>
  );
}

function NextPurchase({ expected }: { expected: string | null }) {
  if (!expected) return <span className="muted">Not enough history yet to say when you'll want it next.</span>;
  const d = daysFromToday(expected);
  if (d < -3) return <strong>Overdue: expected {fmt(expected, { weekday: "short", day: "numeric", month: "short" })}</strong>;
  if (d <= 0) return <strong>Due now</strong>;
  return (
    <strong>
      Next expected around {fmt(expected, { weekday: "short", day: "numeric", month: "short" })}
      {d === 1 ? " (tomorrow)" : d <= 14 ? ` (in ${d} days)` : ""}
    </strong>
  );
}
