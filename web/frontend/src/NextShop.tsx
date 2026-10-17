import { Fragment, useEffect, useState, type FormEvent } from "react";
import { api, type NextShop as Plan, type ShopItem, type TypicalShop } from "./api";
import { byTrips, OrderToggle, useOrder } from "./Order";

type Props = {
  listSize: number;
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

// A rough adult average, for "about 60% of a week". Calories are only ever an estimate here.
const KCAL_A_DAY = 2250;
const PEOPLE_KEY = "shopping-list.people";

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

function savedPeople() {
  try {
    const n = Number(localStorage.getItem(PEOPLE_KEY));
    return n >= 1 && n <= 12 ? n : 2;
  } catch {
    return 2;
  }
}

/** The next shop: when it's likely to be, everything it needs (most bought first, or aisle by aisle), what it
 * comes to in calories, and what a typical shop looks like. */
export default function NextShop({ listSize, groupBy, run }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [typical, setTypical] = useState<TypicalShop>(null);
  const [undo, setUndo] = useState<ShopItem | null>(null);
  const [text, setText] = useState("");
  const [order, setOrder] = useOrder();
  const [people, setPeopleState] = useState(savedPeople);

  const load = () => api.nextShop().then(setPlan, () => setPlan(null));
  useEffect(() => {
    void load();
    api.typicalShop().then(setTypical, () => setTypical(null));
  }, [listSize]);

  const setPeople = (n: number) => {
    if (!(n >= 1 && n <= 12)) return;
    setPeopleState(n);
    try {
      localStorage.setItem(PEOPLE_KEY, String(n));
    } catch {
      // Not remembered on this device.
    }
  };

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

  const choose = (item: ShopItem, optionId: number) =>
    run(async () => setPlan(await api.chooseForShop(item.catalog_id!, item.chosen === optionId ? null : optionId)));

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = text.trim();
    if (!name) return;
    setText("");
    void run(async () => {
      await api.add(name, "");
      await load();
    });
  };

  if (!plan) return <section><p className="muted">Loading…</p></section>;
  const unsure = plan.items.filter((i) => i.badge === "unsure").length;
  const groups: [string, ShopItem[]][] =
    order === "aisle" ? groupBy(plan.items).map(([aisle, items]) => [aisle, byTrips(items)]) : [["", byTrips(plan.items)]];

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
            <h2 id="shop-items">What you'll need</h2>
            <OrderToggle order={order} setOrder={setOrder} />
          </div>
          <p className="muted">
            {plan.items.length} {plan.items.length === 1 ? "item" : "items"}
            {unsure > 0 && ` · ${unsure} not sure`}
          </p>
          {undo && (
            <p className="undo" role="status">
              Removed {undo.name}.{" "}
              <button className="link" onClick={() => putBack(undo)}>
                Undo
              </button>
            </p>
          )}
          {plan.items.length === 0 && <p className="empty">Nothing yet. Add anything you need below.</p>}
          {groups.map(([aisle, items]) => (
            <div key={aisle || "all"} className="group">
              {aisle && <h3>{aisle}</h3>}
              <ul className="shop-items">
                {items.map((i) => (
                  <li key={`${i.catalog_id ?? "l" + i.list_item_id}`} className={i.badge}>
                    <div className="shop-item-main">
                      <span className="shop-item-name">
                        {i.name}
                        {i.qty > 1 && <span className="muted"> ×{i.qty}</span>}
                      </span>
                      <span className="shop-item-meta">
                        {i.kind === "or" && i.chosen === null && <span className="badge pick">Pick one</span>}
                        <span className={`badge ${i.badge}`}>{i.label}</span>
                        <span className="muted">{i.detail}</span>
                        {i.kcal_low !== null && i.kcal_high !== null && (
                          <span className="muted">≈ {range(i.kcal_low * i.qty, i.kcal_high * i.qty)} kcal</span>
                        )}
                        {order === "often" && <span className="muted">· {i.category}</span>}
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
                                onClick={() => choose(i, o.catalog_id)}
                              >
                                {o.name}
                                {o.due && <span className="due-dot" aria-label="(due)" />}
                              </button>
                            </Fragment>
                          ))}
                        </span>
                      )}
                    </div>
                    <button className="remove" aria-label={`Remove ${i.name} from this shop`} title="Remove from this shop" onClick={() => remove(i)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <form className="add-form shop-add" onSubmit={add}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something else…" aria-label="Add an item" maxLength={80} />
            <button type="submit" className="primary" disabled={!text.trim()}>
              Add
            </button>
          </form>
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
            clockwork. <span className="badge unsure">Not sure</span> means you buy it unevenly or now and then, so check.{" "}
            <span className="badge pick">Pick one</span> is a set where one will do this week: tap the one you'll get. Removing something only
            takes it off this shop.
          </p>
        </section>
      </div>

      {/* The progress bars: calories against a week, and the typical shop by aisle. */}
      <aside className="shop-side" aria-label="How this shop compares">
        {plan.items.length > 0 && (
          <section aria-labelledby="kcal-heading">
            <h2 id="kcal-heading">Calories</h2>
            <Calories items={plan.items} people={people} setPeople={setPeople} />
          </section>
        )}
        {typical && <Typical t={typical} />}
      </aside>
    </div>
  );
}

/** What the list comes to in calories, against a week for the household. */
function Calories({ items, people, setPeople }: { items: ShopItem[]; people: number; setPeople: (n: number) => void }) {
  const known = items.filter((i) => i.kcal_low !== null && i.kcal_high !== null);
  const low = known.reduce((s, i) => s + i.kcal_low! * i.qty, 0);
  const high = known.reduce((s, i) => s + i.kcal_high! * i.qty, 0);
  const missing = items.length - known.length;
  const week = people * KCAL_A_DAY * 7;
  const pct = (n: number) => Math.round((n / week) * 100);
  return (
    <div className="kcal" aria-live="polite">
      {known.length === 0 ? (
        <p className="muted">Add calories per pack to your common items to see what this shop comes to.</p>
      ) : (
        <>
          <p className="kcal-line">
            <strong>≈ {range(low, high)} kcal</strong>{" "}
            <span className="muted">
              about {pct(low) === pct(high) ? pct(low) : `${pct(low)}–${pct(high)}`}% of a week for {people} {people === 1 ? "person" : "people"}
              {low !== high && ", depending on what you pick"}
            </span>
          </p>
          <div className="meter" aria-hidden="true">
            <span className="high" style={{ width: `${Math.min(100, (high / week) * 100)}%` }} />
            <span style={{ width: `${Math.min(100, (low / week) * 100)}%` }} />
          </div>
        </>
      )}
      <p className="muted kcal-foot">
        <span>
          {missing > 0 && known.length > 0 && `${missing} ${missing === 1 ? "item has" : "items have"} no calories yet. `}A week is about{" "}
          {KCAL_A_DAY.toLocaleString("en-IE")} kcal a person a day.
        </span>
        <label>
          People{" "}
          <input type="number" min={1} max={12} value={people} onChange={(e) => setPeople(Number(e.target.value))} />
        </label>
      </p>
    </div>
  );
}

/** A typical shop from your history, aisle by aisle. */
function Typical({ t }: { t: NonNullable<TypicalShop> }) {
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
            <div className="typical-name">
              <span>{a.aisle}</span>
              <span className="muted">{a.top.join(", ")}</span>
            </div>
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${(a.products / most) * 100}%` }} />
            </div>
            <div className="typical-value">
              <span>{a.products}</span>
              <span className="muted">{a.spend !== null ? `€${a.spend.toFixed(2)}` : ""}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted hint">Products per shop in each aisle, and what they cost, averaged over your trips in the last year.</p>
    </section>
  );
}
