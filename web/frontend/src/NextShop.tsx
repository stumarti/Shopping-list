import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type CatalogItem, type NextShop as Plan, type ShopItem, type TypicalShop } from "./api";
import { byTrips, OrderToggle, useOrder } from "./Order";

type Props = {
  listSize: number;
  catalog: CatalogItem[];
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

// Rough daily averages, for "about 60% of a week". Calories are only ever an estimate here.
const KCAL_ADULT = 2250;
const KCAL_CHILD = 1600;
const ADULTS_KEY = "shopping-list.people";
const CHILDREN_KEY = "shopping-list.children";

const day = (iso: string) => new Date(iso + "T12:00:00");
const daysAway = (iso: string) => {
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  return Math.round((day(iso).getTime() - t.getTime()) / 86_400_000);
};
const when = (iso: string) => {
  const d = daysAway(iso);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
};
const num = (n: number) => Math.round(n).toLocaleString("en-IE");
const range = (low: number, high: number) => (Math.round(low) === Math.round(high) ? num(low) : `${num(low)}–${num(high)}`);
const shortDate = (iso: string) => day(iso).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const key = (i: ShopItem) => `${i.catalog_id ?? "l" + i.list_item_id}`;

function saved(storageKey: string, fallback: number, min: number) {
  try {
    const raw = localStorage.getItem(storageKey);
    const n = Number(raw);
    return raw !== null && Number.isInteger(n) && n >= min && n <= 12 ? n : fallback;
  } catch {
    return fallback;
  }
}

function useCount(storageKey: string, fallback: number, min: number): [number, (n: number) => void] {
  const [n, setN] = useState(() => saved(storageKey, fallback, min));
  const set = (v: number) => {
    if (!(Number.isInteger(v) && v >= min && v <= 12)) return;
    setN(v);
    try {
      localStorage.setItem(storageKey, String(v));
    } catch {
      // Not remembered on this device.
    }
  };
  return [n, set];
}

/** The next shop: when it's likely to be, everything it needs (most bought first, or aisle by aisle), what it
 * comes to in calories, and what a typical shop looks like. Tap an aisle to see just that aisle: what you'll
 * need, what you've added, the maybes and everything else you buy there. */
export default function NextShop({ listSize, catalog, groupBy, run }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typical, setTypical] = useState<TypicalShop>(null);
  const [undo, setUndo] = useState<ShopItem | null>(null);
  const [text, setText] = useState("");
  const [aisle, setAisle] = useState<string | null>(null);
  const [order, setOrder] = useOrder();
  const [adults, setAdults] = useCount(ADULTS_KEY, 2, 1);
  const [children, setChildren] = useCount(CHILDREN_KEY, 0, 0);

  const load = () => api.nextShop().then(setPlan, () => setPlan(null));
  useEffect(() => {
    void load();
    api.typicalShop().then(setTypical, () => setTypical(null));
  }, [listSize]);

  const remove = (item: ShopItem) =>
    run(async () => {
      if (item.catalog_id !== null) setPlan(await api.skipForShop(item.catalog_id));
      else if (item.list_item_id !== null) {
        await api.remove(item.list_item_id);
        await load();
      }
      setUndo(item);
    });

  const putBack = (item: ShopItem) =>
    run(async () => {
      if (item.catalog_id !== null) setPlan(await api.unskipForShop(item.catalog_id));
      else await api.add(item.name, item.category, item.qty);
      await load();
      setUndo(null);
    });

  const addItem = (name: string, category: string, qty = 1) =>
    run(async () => {
      await api.add(name, category, qty);
      await load();
    });

  const choose = (item: ShopItem, optionId: number) =>
    run(async () => setPlan(await api.chooseForShop(item.catalog_id!, item.chosen === optionId ? null : optionId)));

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = text.trim();
    if (!name) return;
    setText("");
    void addItem(name, aisle ?? "");
  };

  const pickAisle = (name: string) => {
    setAisle(aisle === name ? null : name);
    document.getElementById("shop-items")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!plan) return <section><p className="muted">Loading…</p></section>;

  const here = <T extends { category: string }>(xs: T[]) => (aisle ? xs.filter((x) => x.category === aisle) : xs);
  const must = byTrips(here(plan.items).filter((i) => i.badge !== "added"));
  const added = byTrips(here(plan.items).filter((i) => i.badge === "added"));
  const maybes = byTrips(here(plan.maybe));
  // Everything else you buy in this aisle: common items not already on the shop in some way.
  const taken = new Set<string>();
  for (const i of [...plan.items, ...plan.maybe, ...plan.skipped]) {
    taken.add(i.name.toLowerCase());
    if (i.catalog_id !== null) taken.add(`#${i.catalog_id}`);
    for (const o of i.options ?? []) taken.add(`#${o.catalog_id}`);
  }
  const others = aisle
    ? byTrips(catalog.filter((c) => c.category === aisle && c.kind !== "or" && c.group_id === null && !taken.has(`#${c.id}`) && !taken.has(c.name.toLowerCase())))
    : [];

  const row = (i: ShopItem, maybe = false) => (
    <ShopRow
      key={key(i)}
      i={i}
      showAisle={order === "often" && !aisle}
      onChoose={(o) => choose(i, o)}
      action={
        maybe ? (
          <button className="add-one" aria-label={`Add ${i.name} to this shop`} title="Add to this shop" onClick={() => addItem(i.name, i.category, i.qty)}>
            + Add
          </button>
        ) : (
          <button className="remove" aria-label={`Remove ${i.name} from this shop`} title="Remove from this shop" onClick={() => remove(i)}>
            ×
          </button>
        )
      }
    />
  );

  // Aisle by aisle: in each, what you'll need first, then what you added.
  const groups: [string, ShopItem[]][] =
    order === "aisle" ? groupBy(plan.items).map(([a, items]) => [a, ranked(items)]) : [["", ranked(plan.items)]];
  const maybeGroups: [string, ShopItem[]][] = order === "aisle" ? groupBy(plan.maybe).map(([a, items]) => [a, byTrips(items)]) : [["", byTrips(plan.maybe)]];
  const aisleHeading = (a: string) => (
    <h3>
      <button className="aisle-link" onClick={() => pickAisle(a)} title={`Show just ${a}`}>
        {a}
      </button>
    </h3>
  );

  return (
    <div className="shop-layout">
      <div className="shop-main">
        <section aria-labelledby="shop-when" className="shop-when">
          {plan.shop ? (
            <>
              <p className="muted eyebrow">Next shop</p>
              <h2 id="shop-when">
                {day(plan.shop.date).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" })}{" "}
                <span className="muted">({when(plan.shop.date)})</span>
              </h2>
              <p className="muted">
                {plan.shop.reason}. Last shop {day(plan.shop.last_shop).toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" })}.
              </p>
            </>
          ) : (
            <>
              <h2 id="shop-when">Next shop</h2>
              <p className="muted">
                Upload your Tesco data in <a href="#settings">Settings</a> and this works out when you'll shop next and what you'll need.
              </p>
            </>
          )}
        </section>

        <section aria-labelledby="shop-items">
          <div className="section-head">
            <h2 id="shop-items">{aisle ?? "What you'll need"}</h2>
            {aisle ? (
              <button className="link" onClick={() => setAisle(null)}>
                Show all aisles
              </button>
            ) : (
              <OrderToggle order={order} setOrder={setOrder} />
            )}
          </div>
          <p className="muted">
            {aisle
              ? `${plural(must.length + added.length, "item", "items")} on this shop · ${plural(maybes.length, "maybe", "maybes")} · ${others.length} more you've bought here`
              : `${plural(plan.items.length, "item", "items")}${plan.maybe.length ? ` · ${plural(plan.maybe.length, "maybe", "maybes")} below` : ""}`}
          </p>
          {undo && (
            <p className="undo" role="status">
              Removed {undo.name}.{" "}
              <button className="link" onClick={() => putBack(undo)}>
                Undo
              </button>
            </p>
          )}

          {aisle ? (
            <>
              <Part title="You'll need" empty="Nothing due from this aisle.">
                {must.map((i) => row(i))}
              </Part>
              {added.length > 0 && <Part title="Added">{added.map((i) => row(i))}</Part>}
              {maybes.length > 0 && (
                <Part title="Maybe" note="Not sure you'll need these. Add any you do.">
                  {maybes.map((i) => row(i, true))}
                </Part>
              )}
              {others.length > 0 && (
                <Part title={`Everything else in ${aisle}`}>
                  {others.map((c) => (
                    <li key={c.id}>
                      <div className="shop-item-main">
                        <span className="shop-item-name">{c.name}</span>
                        <span className="shop-item-meta muted">{c.trips ? `Bought on ${plural(c.trips, "trip", "trips")}` : "Not bought yet"}</span>
                      </div>
                      <button className="add-one" aria-label={`Add ${c.name} to this shop`} title="Add to this shop" onClick={() => addItem(c.name, c.category)}>
                        + Add
                      </button>
                    </li>
                  ))}
                </Part>
              )}
            </>
          ) : (
            <>
              {plan.items.length === 0 && <p className="empty">Nothing yet. Add anything you need below.</p>}
              {groups.map(([a, items]) => (
                <div key={a || "all"} className="group">
                  {a && aisleHeading(a)}
                  <ul className="shop-items">{items.map((i) => row(i))}</ul>
                </div>
              ))}
            </>
          )}

          <form className="add-form shop-add" onSubmit={add}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={aisle ? `Add something else to ${aisle}…` : "Add something else…"}
              aria-label="Add an item"
              maxLength={80}
            />
            <button type="submit" className="primary" disabled={!text.trim()}>
              Add
            </button>
          </form>

          {!aisle && plan.maybe.length > 0 && (
            <div className="maybes">
              <h3 className="part-title">Maybe</h3>
              <p className="muted part-note">Not sure you'll need these, so they're not on the shop. Add any you do.</p>
              {maybeGroups.map(([a, items]) => (
                <div key={a || "all"} className="group">
                  {a && aisleHeading(a)}
                  <ul className="shop-items">{items.map((i) => row(i, true))}</ul>
                </div>
              ))}
            </div>
          )}

          {plan.skipped.length > 0 && (
            <details className="skipped">
              <summary>Removed from this shop ({plan.skipped.length})</summary>
              <ul>
                {plan.skipped.map((i) => (
                  <li key={i.catalog_id}>
                    <span>{i.name}</span>
                    <button className="link" onClick={() => putBack(i)}>
                      Put back
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="muted hint">
            <span className="badge weekly">Weekly</span> and <span className="badge scheduled">Every 2 weeks</span> are things you buy like
            clockwork. <span className="badge unsure">Not sure</span> means you buy it unevenly or now and then, so it waits under Maybe
            until you add it. <span className="badge pick">Pick one</span> is a set where one will do this week: tap the one you'll get.
            Removing something only takes it off this shop. Tap an aisle to see just that aisle.
          </p>
        </section>
      </div>

      {/* The progress bars: calories against a week, and the typical shop by aisle. */}
      <aside className="shop-side" aria-label="How this shop compares">
        {(plan.items.length > 0 || typical?.kcal_week) && (
          <section aria-labelledby="kcal-heading">
            <h2 id="kcal-heading">Calories</h2>
            <Calories items={plan.items} typical={typical} adults={adults} setAdults={setAdults} children={children} setChildren={setChildren} />
          </section>
        )}
        {typical && <Typical t={typical} aisle={aisle} pick={pickAisle} />}
      </aside>
    </div>
  );
}

/** What you'll need first, then what you added; most bought first within each. */
const ranked = (items: ShopItem[]) => [...byTrips(items.filter((i) => i.badge !== "added")), ...byTrips(items.filter((i) => i.badge === "added"))];

function Part({ title, note, empty, children }: { title: string; note?: string; empty?: string; children: ReactNode[] }) {
  return (
    <div className="part">
      <h3 className="part-title">{title}</h3>
      {note && <p className="muted part-note">{note}</p>}
      {children.length ? <ul className="shop-items">{children}</ul> : empty && <p className="muted part-note">{empty}</p>}
    </div>
  );
}

function ShopRow({ i, showAisle, onChoose, action }: { i: ShopItem; showAisle: boolean; onChoose: (optionId: number) => void; action: ReactNode }) {
  return (
    <li className={i.badge}>
      <div className="shop-item-main">
        <span className="shop-item-name">
          {i.name}
          {i.qty > 1 && <span className="muted"> ×{i.qty}</span>}
        </span>
        <span className="shop-item-meta">
          {i.kind === "or" && i.chosen === null && <span className="badge pick">Pick one</span>}
          <span className={`badge ${i.badge}`}>{i.label}</span>
          <span className="muted">{i.detail}</span>
          {i.kcal_low !== null && i.kcal_high !== null && <span className="muted">≈ {range(i.kcal_low * i.qty, i.kcal_high * i.qty)} kcal</span>}
          {showAisle && <span className="muted">· {i.category}</span>}
        </span>
        {i.options && (
          <span className="options" role="group" aria-label={`Pick one for ${i.name}`}>
            {i.options.map((o, n) => (
              <Fragment key={o.catalog_id}>
                {n > 0 && <span className="or">or</span>}
                <button
                  className={`option${i.chosen === o.catalog_id ? " on" : ""}`}
                  aria-pressed={i.chosen === o.catalog_id}
                  title={o.due ? "Due for this shop" : "Not due yet"}
                  onClick={() => onChoose(o.catalog_id)}
                >
                  {o.name}
                  {o.due && <span className="due-dot" aria-label="(due)" />}
                </button>
              </Fragment>
            ))}
          </span>
        )}
      </div>
      {action}
    </li>
  );
}

/** What the shop comes to in calories, and what you usually buy in a week, against what the household needs. */
function Calories({
  items,
  typical,
  adults,
  setAdults,
  children,
  setChildren,
}: {
  items: ShopItem[];
  typical: TypicalShop;
  adults: number;
  setAdults: (n: number) => void;
  children: number;
  setChildren: (n: number) => void;
}) {
  const known = items.filter((i) => i.kcal_low !== null && i.kcal_high !== null);
  const low = known.reduce((s, i) => s + i.kcal_low! * i.qty, 0);
  const high = known.reduce((s, i) => s + i.kcal_high! * i.qty, 0);
  const missing = items.length - known.length;
  const need = (adults * KCAL_ADULT + children * KCAL_CHILD) * 7;
  const pct = (n: number) => Math.round((n / need) * 100);
  const width = (n: number) => `${Math.min(100, (n / need) * 100)}%`;
  const who = [plural(adults, "adult", "adults"), children > 0 && plural(children, "child", "children")].filter(Boolean).join(" and ");
  const usual = typical?.kcal_week ?? null;

  return (
    <div className="kcal" aria-live="polite">
      <p className="kcal-need">
        A week for {who} is about <strong>{num(need)} kcal</strong>.
      </p>

      <div className="kcal-row">
        <p className="kcal-label">This shop</p>
        {known.length === 0 ? (
          <p className="muted">Add calories per pack to your common items to see what this shop comes to.</p>
        ) : (
          <>
            <p className="kcal-line">
              <strong>≈ {range(low, high)} kcal</strong>{" "}
              <span className="muted">
                {pct(low) === pct(high) ? pct(low) : `${pct(low)}–${pct(high)}`}% of the week{low !== high && ", depending on what you pick"}
              </span>
            </p>
            <div className="meter" aria-hidden="true">
              <span className="high" style={{ width: width(high) }} />
              <span style={{ width: width(low) }} />
            </div>
            {missing > 0 && <p className="muted kcal-note">{plural(missing, "item has", "items have")} no calories yet.</p>}
          </>
        )}
      </div>

      {usual !== null && typical && (
        <div className="kcal-row">
          <p className="kcal-label">A usual week</p>
          <p className="kcal-line">
            <strong>≈ {num(usual)} kcal</strong> <span className="muted">{pct(usual)}% of the week</span>
          </p>
          <div className="meter" aria-hidden="true">
            <span style={{ width: width(usual) }} />
          </div>
          <p className="muted kcal-note">
            What you bought a week over the {plural(typical.weeks, "week", "weeks")} you shopped; weeks with no shopping are left out.
            {typical.kcal_known < 0.95 && ` Only counts the ${Math.round(typical.kcal_known * 100)}% of things with calories set.`}
          </p>
        </div>
      )}

      <div className="kcal-foot">
        <label>
          Adults <input type="number" min={1} max={12} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
        </label>
        <label>
          Children <input type="number" min={0} max={12} value={children} onChange={(e) => setChildren(Number(e.target.value))} />
        </label>
        <span className="muted">
          About {num(KCAL_ADULT)} kcal a day for an adult, {num(KCAL_CHILD)} for a child.
        </span>
      </div>
    </div>
  );
}

/** A typical shop from your history, aisle by aisle. Tap an aisle to see just that aisle in the list. */
function Typical({ t, aisle, pick }: { t: NonNullable<TypicalShop>; aisle: string | null; pick: (aisle: string) => void }) {
  const most = Math.max(...t.aisles.map((a) => a.products), 1);
  return (
    <section aria-labelledby="typical-heading">
      <div className="section-head">
        <h2 id="typical-heading">Your typical shop</h2>
        <span className="muted">
          {t.trips} {t.trips === 1 ? "trip" : "trips"}, {shortDate(t.from)} to {shortDate(t.to)}
        </span>
      </div>
      <p className="muted">
        About {t.products} products{t.spend !== null && ` and €${t.spend.toFixed(2)}`} a shop.
        {t.kcal !== null &&
          (t.kcal_known >= 0.95
            ? ` About ${num(t.kcal)} kcal.`
            : ` About ${num(t.kcal)} kcal from the ${Math.round(t.kcal_known * 100)}% of things with calories set.`)}
      </p>
      <ul className="typical">
        {t.aisles.map((a) => (
          <li key={a.aisle}>
            <button className={`typical-row${aisle === a.aisle ? " on" : ""}`} aria-pressed={aisle === a.aisle} onClick={() => pick(a.aisle)}>
              <span className="typical-name">
                <span>{a.aisle}</span>
                <span className="muted">{a.top.join(", ")}</span>
              </span>
              <span className="bar" aria-hidden="true">
                <span style={{ width: `${(a.products / most) * 100}%` }} />
              </span>
              <span className="typical-value">
                <span>{a.products}</span>
                <span className="muted">{a.spend !== null ? `€${a.spend.toFixed(2)}` : ""}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted hint">Products per shop in each aisle, and what they cost, averaged over your trips in the last year. Tap an aisle to see just that aisle.</p>
    </section>
  );
}
