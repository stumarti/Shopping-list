import { Fragment, useEffect, useState } from "react";
import { api, itemLinks, type CatalogItem, type CommonChange, type FoodGroup, type ItemHistory, type Links } from "./api";
import { byTrips, OrderToggle, useOrder } from "./Order";
import PriceChart from "./PriceChart";
import Spending from "./Spending";
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

/** Your common items, most bought first or aisle by aisle. Kinds of one thing sit under their generic item
 * (Broccoli: tenderstem, florets). Tap one for its weekly history and when you'll want it next. */
export default function Manage({ catalog, categories, links, groupBy, run }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [order, setOrder] = useOrder();
  const [foodGroups, setFoodGroups] = useState<FoodGroup[]>([]);
  useEffect(() => {
    api.foodGroups().then(setFoodGroups, () => setFoodGroups([]));
  }, []);

  const sets = new Map(catalog.filter((c) => c.kind === "or").map((c) => [c.id, c.name]));
  const kindsOf = (id: number) => byTrips(catalog.filter((c) => c.group_id === id));
  const top = catalog.filter((c) => c.kind !== "or" && c.group_id === null);
  const f = filter.trim().toLowerCase();
  const matches = (c: CatalogItem) => c.name.toLowerCase().includes(f) || c.barcode.includes(f);
  const shown = f ? top.filter((c) => matches(c) || kindsOf(c.id).some(matches)) : top;
  const groups: [string, CatalogItem[]][] =
    order === "aisle" ? groupBy(shown).map(([aisle, items]) => [aisle, byTrips(items)]) : [["", byTrips(shown)]];
  const count = catalog.filter((c) => c.kind !== "or").length;

  const row = (item: CatalogItem, kind = false) => (
    <li key={item.id} className={`${open === item.id ? "open" : ""}${kind ? " kind" : ""}`}>
      <button className="common-name" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>
        <span>
          {item.name}
          {item.or_id !== null && sets.has(item.or_id) && <span className="tag-or"> or {sets.get(item.or_id)}</span>}
          {order === "often" && !kind && <span className="muted aisle-note"> · {item.category}</span>}
        </span>
        <span className="common-right">
          <span className="muted trips">{item.trips > 0 ? `${item.trips}×` : ""}</span>
          <span className="chev" aria-hidden="true">
            {open === item.id ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {open === item.id && (
        <ItemDetail
          item={item}
          catalog={catalog}
          categories={categories}
          foodGroups={foodGroups}
          links={links}
          run={run}
          onGone={() => setOpen(null)}
        />
      )}
    </li>
  );

  return (
    <>
    <Spending refresh={catalog.length} />
    <section aria-labelledby="common-heading">
      <div className="section-head">
        <h2 id="common-heading">Common items</h2>
        {count > 0 && <OrderToggle order={order} setOrder={setOrder} />}
      </div>
      <p className="muted">
        {count} items
        {count > 0 && (
          <>
            {" · "}
            <button
              className="link danger"
              onClick={() => {
                if (confirm(`Remove all ${count} common items? Your list and purchase history stay, and Settings → Rebuild from history can bring them back.`))
                  void run(api.clearCommon);
              }}
            >
              Clear all
            </button>
          </>
        )}
      </p>
      {count === 0 ? (
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
      {groups.map(([cat, items]) => (
        <div key={cat || "all"} className="group">
          {cat && (
            <h3>
              {cat} <span className="count">{items.length}</span>
            </h3>
          )}
          <ul className="common-list">
            {items.map((item) => (
              <Fragment key={item.id}>
                {row(item)}
                {kindsOf(item.id).map((k) => row(k, true))}
              </Fragment>
            ))}
          </ul>
        </div>
      ))}
      {count > 0 && (
        <p className="muted hint">
          The number is how many shopping trips each item was on. Open an item to group kinds of one thing under a generic item (Kind of:
          Broccoli), or to put things where one will do into a pick-one set (Pick one of: Protein).
        </p>
      )}
    </section>
    </>
  );
}

function ItemDetail({
  item,
  catalog,
  categories,
  foodGroups,
  links,
  run,
  onGone,
}: {
  item: CatalogItem;
  catalog: CatalogItem[];
  categories: string[];
  foodGroups: FoodGroup[];
  links: Links | null;
  run: Props["run"];
  onGone: () => void;
}) {
  const [history, setHistory] = useState<ItemHistory | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [name, setName] = useState(item.name);
  const [barcode, setBarcode] = useState(item.barcode);
  const groupName = (id: number | null) => catalog.find((c) => c.id === id)?.name ?? "";
  const [group, setGroup] = useState(groupName(item.group_id));
  const [orSet, setOrSet] = useState(groupName(item.or_id));
  const kinds = catalog.filter((c) => c.group_id === item.id);
  const generics = catalog.filter((c) => c.kind !== "or" && c.group_id === null && c.id !== item.id);
  const setNames = catalog.filter((c) => c.kind === "or");

  useEffect(() => {
    api.itemHistory(item.id).then(setHistory, () => setHistory(null));
  }, [item.id]);
  useEffect(() => {
    setName(item.name);
    setBarcode(item.barcode);
    setGroup(groupName(item.group_id));
    setOrSet(groupName(item.or_id));
  }, [item.name, item.barcode, item.group_id, item.or_id]);

  const save = (change: CommonChange) =>
    run(() => api.editCommon(item.id, change)).then((ok) => {
      if (!ok) {
        setName(item.name);
        setBarcode(item.barcode);
        setGroup(groupName(item.group_id));
        setOrSet(groupName(item.or_id));
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
          {history.kind && (
            <p className="kind-note">
              {history.kind.id === item.id
                ? `Counting all ${history.kind.kinds} kinds of ${item.name} together.`
                : `Counting all kinds of ${history.kind.name} together, since any of them will do.`}
            </p>
          )}
          <p className="muted stats">
            {history.kind && history.kind.id !== item.id ? `${history.kind.name} bought` : "Bought"} {s!.trips}{" "}
            {s!.trips === 1 ? "time" : "times"}
            {s!.every_days !== null && `, about every ${s!.every_days === 7 ? "week" : `${s!.every_days} days`}`}, last {fmt(s!.last_bought)}
            {s!.usual_qty > 1 && `. Usually ${Math.round(s!.usual_qty)} at a time`}.
            {history.product && (
              <>
                {" "}
                This one: {history.product.trips} {history.product.trips === 1 ? "time" : "times"}
                {history.product.last_bought && `, last ${fmt(history.product.last_bought)}`}.
              </>
            )}
            {s!.price && !(history.by_kind.length === 0 && history.purchases.filter((p) => p.unit_price !== null).length > 1) && (
              <> {euro(s!.price.now)} each.</>
            )}
            {history.spend > 0 && <> You've spent {euro(history.spend)} on {history.kind?.id === item.id ? "them" : "it"}.</>}
          </p>
          {history.by_kind.length > 0 && (
            <ul className="by-kind">
              {history.by_kind.map((k) => (
                <li key={k.id}>
                  <span>{k.name}</span>
                  <span className="muted">
                    {k.trips}× · last {fmt(k.last_bought)}
                    {k.price && ` · ${euro(k.price.now)}`}
                    {k.price && k.price.low !== k.price.high && ` (${euro(k.price.low)}–${euro(k.price.high)})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {history.by_kind.length === 0 && history.purchases.filter((p) => p.unit_price !== null).length > 1 && (
            <>
              <h4>Price</h4>
              <PriceChart purchases={history.purchases} />
            </>
          )}
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
        <fieldset className="nutrition">
          <legend>Per pack</legend>
          <Amount label="Calories" unit="kcal" value={item.kcal} whole onSave={(v) => save({ kcal: v })} />
          <Amount label="Protein" unit="g" value={item.protein} onSave={(v) => save({ protein: v })} />
          <Amount label="Carbs" unit="g" value={item.carbs} onSave={(v) => save({ carbs: v })} />
          <Amount label="Fat" unit="g" value={item.fat} onSave={(v) => save({ fat: v })} />
          <label className="food-group">
            <span>Food group</span>
            <select value={item.food_group} onChange={(e) => save({ food_group: e.target.value })}>
              <option value="">
                {item.food_group_guess
                  ? `Guess: ${foodGroups.find((g) => g.id === item.food_group_guess)?.name ?? item.food_group_guess}`
                  : "Not food (guess)"}
              </option>
              {foodGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        {kinds.length > 0 ? (
          <div className="kinds">
            <span>Kinds of {item.name}</span>
            <ul>
              {kinds.map((k) => (
                <li key={k.id}>
                  <span>
                    {k.name}
                    {k.kcal !== null && <span className="muted"> · {k.kcal} kcal</span>}
                  </span>
                  <button className="link" onClick={() => run(() => api.editCommon(k.id, { group: "" }))}>
                    Take out
                  </button>
                </li>
              ))}
            </ul>
            <select
              value=""
              aria-label={`Add a kind of ${item.name}`}
              onChange={(e) => e.target.value && run(() => api.editCommon(Number(e.target.value), { group: item.name }))}
            >
              <option value="">Add a kind of {item.name}…</option>
              {generics
                .filter((c) => !catalog.some((k) => k.group_id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <label>
            <span>Kind of</span>
            <input
              value={group}
              maxLength={80}
              list={`generics-${item.id}`}
              placeholder="e.g. Broccoli, to group kinds of one thing"
              onChange={(e) => setGroup(e.target.value)}
              onBlur={() => group.trim() !== groupName(item.group_id) && save({ group: group.trim() })}
            />
            <datalist id={`generics-${item.id}`}>
              {generics.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </label>
        )}
        {item.group_id === null ? (
          <label>
            <span>Pick one of</span>
            <input
              value={orSet}
              maxLength={80}
              list={`sets-${item.id}`}
              placeholder="e.g. Protein: shows as one line, you pick one"
              onChange={(e) => setOrSet(e.target.value)}
              onBlur={() => orSet.trim() !== groupName(item.or_id) && save({ or_set: orSet.trim() })}
            />
            <datalist id={`sets-${item.id}`}>
              {setNames.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </label>
        ) : (
          <p className="muted small">Pick-one sets go on {groupName(item.group_id)}, not on its kinds.</p>
        )}
        <label className="check">
          <input type="checkbox" checked={item.exact} onChange={(e) => save({ exact: e.target.checked })} />
          <span>Never swap: always get exactly this, even if something's cheaper or it's out of stock</span>
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

/** A number per pack, saved when you leave the box; empty clears it. */
function Amount({ label, unit, value, whole, onSave }: { label: string; unit: string; value: number | null; whole?: boolean; onSave: (v: number | null) => void }) {
  const shown = value === null ? "" : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const t = text.trim().replace(",", ".");
    const n = t === "" ? null : Number(t);
    if (n !== null && !(n >= 0)) return setText(shown);
    const v = n === null ? null : whole ? Math.round(n) : Math.round(n * 10) / 10;
    if (v !== value) onSave(v);
  };
  return (
    <label className="amount">
      <span>{label}</span>
      <span className="with-unit">
        <input
          value={text}
          inputMode={whole ? "numeric" : "decimal"}
          maxLength={7}
          placeholder="–"
          onChange={(e) => setText(e.target.value.replace(whole ? /[^\d]/g : /[^\d.,]/g, ""))}
          onBlur={commit}
        />
        <span className="unit">{unit}</span>
      </span>
    </label>
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
