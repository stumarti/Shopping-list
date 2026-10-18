import { Fragment, lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type CatalogItem, type FoodGroup, type NextShop as Plan, type ShopItem, type TypicalShop } from "./api";
import Icon, { type IconName } from "./Icon";
import { byTrips, OrderToggle, useOrder } from "./Order";

const Scanner = lazy(() => import("./Scanner"));
const RecordShop = lazy(() => import("./RecordShop"));

/** What a scan found: an item on this shop (ticked), or something to add. */
type Scanned = { code: string; message: string; add?: { name: string; category: string } };

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
const TROLLEY_KEY = "shopping-list.trolley";
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

/** What's in the trolley while you shop: ticked items, kept on this device for this shop's date only. */
function useTrolley(shopDate: string): [Set<string>, (key: string) => void, () => void] {
  const read = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(TROLLEY_KEY) ?? "null");
      return new Set<string>(saved?.date === shopDate ? saved.keys : []);
    } catch {
      return new Set<string>();
    }
  };
  const [got, setGot] = useState(read);
  useEffect(() => setGot(read()), [shopDate]);
  const save = (next: Set<string>) => {
    setGot(next);
    try {
      localStorage.setItem(TROLLEY_KEY, JSON.stringify({ date: shopDate, keys: [...next] }));
    } catch {
      // Not remembered on this device; ticks still show until you leave the page.
    }
  };
  const toggle = (key: string) => {
    const next = new Set(got);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    save(next);
  };
  return [got, toggle, () => save(new Set())];
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
  const [foodGroups, setFoodGroups] = useState<FoodGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [scanName, setScanName] = useState("");
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<{ order_ref: string; store: string; bought_on: string; products: number } | null>(null);
  const [got, toggleGot, emptyTrolley] = useTrolley(plan?.shop?.date ?? "anytime");
  useEffect(() => {
    api.foodGroups().then(setFoodGroups, () => setFoodGroups([]));
  }, []);

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

  // A scanned barcode: tick it off if it's on this shop, otherwise offer to add it.
  const onScanned = async (code: string) => {
    setScanning(false);
    if (!plan) return;
    const known = catalog.find((c) => c.barcode === code);
    if (known) {
      const root = known.group_id ?? known.id;
      const item = plan.items.find(
        (i) =>
          i.catalog_id === root ||
          i.catalog_id === known.id ||
          i.options?.some((o) => o.catalog_id === known.id) ||
          i.name.toLowerCase() === known.name.toLowerCase(),
      );
      if (item) {
        if (!got.has(key(item))) toggleGot(key(item));
        setScanned({ code, message: `${item.name} is in the trolley.` });
        return;
      }
      setScanName(known.name);
      setScanned({ code, message: `${known.name} isn't on this shop.`, add: { name: known.name, category: known.category } });
      return;
    }
    try {
      const p = await api.barcode(code);
      const brand = p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.brand} ` : "";
      const name = `${brand}${p.name}${p.quantity ? ` ${p.quantity}` : ""}`.trim();
      setScanName(name);
      setScanned({ code, message: name ? `Found in ${p.source === "yours" ? "your items" : "Open Food Facts"}.` : "Found it, but it has no name.", add: { name, category: p.category } });
    } catch {
      setScanName("");
      setScanned({ code, message: `${code} isn't in Open Food Facts. Name it to add it.`, add: { name: "", category: aisle ?? "" } });
    }
  };

  const addScanned = (tick: boolean) => {
    if (!scanned?.add || !scanName.trim()) return;
    const { code } = scanned;
    void run(async () => {
      const item = await api.add(scanName.trim(), scanned.add!.category, 1, code);
      await load();
      if (tick) toggleGot(`l${item.id}`);
      setScanned({ code, message: tick ? `${item.name} added, and in the trolley.` : `${item.name} added.` });
    });
  };

  const pickAisle = (name: string | null) => {
    setAisle(aisle === name ? null : name);
    document.getElementById("shop-items")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!plan) return <section><p className="muted">Loading…</p></section>;

  const here = <T extends { category: string }>(xs: T[]) => (aisle ? xs.filter((x) => x.category === aisle) : xs);
  // Ticked off in the shop: out of the list, into the trolley at the bottom.
  const toGet = plan.items.filter((i) => !got.has(key(i)));
  const inTrolley = here(plan.items).filter((i) => got.has(key(i)));
  const gotCount = plan.items.length - toGet.length;
  const must = byTrips(here(toGet).filter((i) => i.badge !== "added"));
  const added = byTrips(here(toGet).filter((i) => i.badge === "added"));
  // Aisle chips: every aisle with something to get or a maybe, and how much is left in it.
  const chips = groupBy([...plan.items, ...plan.maybe]).map(([a]) => [a, toGet.filter((i) => i.category === a).length] as const);
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
      got={maybe ? undefined : got.has(key(i))}
      onGot={maybe ? undefined : () => toggleGot(key(i))}
      action={
        maybe ? (
          <button className="add-one" aria-label={`Add ${i.name} to this shop`} title="Add to this shop" onClick={() => addItem(i.name, i.category, i.qty)}>
            <Icon name="add" size={18} /> Add
          </button>
        ) : (
          <button className="remove" aria-label={`Remove ${i.name} from this shop`} title="Remove from this shop" onClick={() => remove(i)}>
            <Icon name="close" />
          </button>
        )
      }
    />
  );

  // Aisle by aisle: in each, what you'll need first, then what you added.
  const groups: [string, ShopItem[]][] =
    order === "aisle" ? groupBy(toGet).map(([a, items]) => [a, ranked(items)]) : [["", ranked(toGet)]];
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
              <p className="muted eyebrow">
                <Icon name="event" size={16} /> Next shop
              </p>
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
              ? `${plural(must.length + added.length, "item", "items")} to get · ${plural(maybes.length, "maybe", "maybes")} · ${others.length} more you've bought here`
              : `${plural(plan.items.length, "item", "items")}${plan.maybe.length ? ` · ${plural(plan.maybe.length, "maybe", "maybes")} below` : ""}`}
            {gotCount > 0 && ` · ${gotCount} in the trolley`}
          </p>
          {plan.items.length > 0 && (
            <div className="trolley-meter" aria-hidden="true">
              <span style={{ width: `${(gotCount / plan.items.length) * 100}%` }} />
            </div>
          )}
          {chips.length > 1 && (
            <nav className="aisle-chips" aria-label="Aisles">
              <button className={aisle === null ? "on" : ""} aria-pressed={aisle === null} onClick={() => pickAisle(null)}>
                All <span className="n">{toGet.length}</span>
              </button>
              {chips.map(([a, n]) => (
                <button key={a} className={aisle === a ? "on" : ""} aria-pressed={aisle === a} onClick={() => pickAisle(a)}>
                  {a} <span className="n">{n}</span>
                </button>
              ))}
            </nav>
          )}
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
              {plan.items.length > 0 && toGet.length === 0 && (
                <p className="empty">
                  <Icon name="cartFill" /> Everything's in the trolley.
                </p>
              )}
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
            <button type="submit" className="primary" disabled={!text.trim()} aria-label="Add">
              <Icon name="add" /> <span className="label">Add</span>
            </button>
            <button type="button" className="scan-button" onClick={() => (setScanned(null), setScanning(true))} aria-label="Scan a barcode" title="Scan a barcode">
              <Icon name="scan" size={22} />
            </button>
          </form>

          {scanned && (
            <div className="scan-result" role="status">
              <p>
                <Icon name={scanned.add ? "scan" : "checked"} size={18} /> {scanned.message}
              </p>
              {scanned.add && (
                <div className="add-form">
                  <input value={scanName} onChange={(e) => setScanName(e.target.value)} placeholder="What is it?" aria-label="Name for the scanned item" maxLength={80} />
                  <button className="primary" disabled={!scanName.trim()} onClick={() => addScanned(false)}>
                    Add
                  </button>
                  <button className="link" disabled={!scanName.trim()} onClick={() => addScanned(true)}>
                    Add, in the trolley
                  </button>
                </div>
              )}
              <span className="scan-result-actions">
                <button className="link" onClick={() => (setScanned(null), setScanning(true))}>
                  Scan another
                </button>
                <button className="link" onClick={() => setScanned(null)}>
                  Done
                </button>
              </span>
            </div>
          )}
          {scanning && (
            <Suspense fallback={null}>
              <Scanner title="Scan a barcode" onCode={(c) => void onScanned(c)} onClose={() => setScanning(false)} />
            </Suspense>
          )}

          {recorded && (
            <p className="undo" role="status">
              <Icon name="checked" size={16} /> Recorded {recorded.products} {recorded.products === 1 ? "thing" : "things"} from {recorded.store} on{" "}
              {day(recorded.bought_on).toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" })}. The next shop has moved on.{" "}
              <button
                className="link"
                onClick={() =>
                  run(async () => {
                    await api.forgetRecordedShop(recorded.order_ref);
                    setRecorded(null);
                    await load();
                  })
                }
              >
                Undo
              </button>
            </p>
          )}

          <div className="record-cta">
            <button className={inTrolley.length || gotCount ? "primary" : "link"} onClick={() => setRecording(true)}>
              <Icon name="checked" size={18} /> {gotCount ? "Done shopping: record this shop" : "Record a shop"}
            </button>
            <span className="muted">Shopped somewhere with no data to upload? Record it so the next shop moves on.</span>
          </div>
          {recording && (
            <Suspense fallback={null}>
              <RecordShop
                items={plan.items}
                inTrolley={(i) => got.has(key(i))}
                run={run}
                onClose={() => setRecording(false)}
                onRecorded={(r) => {
                  setRecording(false);
                  setRecorded(r);
                  emptyTrolley();
                  void load();
                }}
              />
            </Suspense>
          )}

          {inTrolley.length > 0 && (
            <div className="trolley">
              <div className="section-head">
                <h3 className="part-title">
                  <Icon name="cart" size={16} /> In the trolley ({inTrolley.length})
                </h3>
                <button className="link" onClick={emptyTrolley}>
                  Untick all
                </button>
              </div>
              <ul className="shop-items">{byTrips(inTrolley).map((i) => row(i))}</ul>
            </div>
          )}

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
          <details className="hint badges-help">
            <summary className="muted">What the badges mean</summary>
          <p className="muted hint">
            <span className="badge weekly">Weekly</span> and <span className="badge scheduled">Every 2 weeks</span> are things you buy like
            clockwork. <span className="badge unsure">Not sure</span> means you buy it unevenly or now and then, so it waits under Maybe
            until you add it. <span className="badge pick">Pick one</span> is a set where one will do this week: tap the one you'll get.
            Removing something only takes it off this shop. Tap an aisle to see just that aisle, and tick things off as they go in the
            trolley.
          </p>
          </details>
        </section>
      </div>

      {/* The progress bars: calories against a week, and the typical shop by aisle. */}
      <aside className="shop-side" aria-label="How this shop compares">
        {(plan.items.length > 0 || typical?.kcal_week) && (
          <section aria-labelledby="kcal-heading">
            <h2 id="kcal-heading">Calories</h2>
            <Nutrition
              items={plan.items}
              typical={typical}
              groups={foodGroups}
              adults={adults}
              setAdults={setAdults}
              children={children}
              setChildren={setChildren}
            />
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

function ShopRow({
  i,
  showAisle,
  onChoose,
  got,
  onGot,
  action,
}: {
  i: ShopItem;
  showAisle: boolean;
  onChoose: (optionId: number) => void;
  got?: boolean;
  onGot?: () => void;
  action: ReactNode;
}) {
  return (
    <li className={`${i.badge}${got ? " got" : ""}`}>
      {onGot && (
        <button
          className="got-toggle"
          aria-pressed={got}
          aria-label={got ? `Take ${i.name} out of the trolley` : `${i.name} is in the trolley`}
          title={got ? "In the trolley: tap to untick" : "Tick when it's in the trolley"}
          onClick={onGot}
        >
          <Icon name={got ? "checked" : "unchecked"} size={24} />
        </button>
      )}
      <div className="shop-item-main">
        <span className="shop-item-name">
          {i.name}
          {i.qty > 1 && <span className="muted"> ×{i.qty}</span>}
        </span>
        <span className="shop-item-meta">
          {i.kind === "or" && i.chosen === null && <span className="badge pick">Pick one</span>}
          <span className={`badge ${i.badge}`}>{i.label}</span>
          <span className="muted">{i.detail}</span>
          {i.kcal_low !== null && i.kcal_high !== null && <span className="muted meta-extra">≈ {range(i.kcal_low * i.qty, i.kcal_high * i.qty)} kcal</span>}
          {showAisle && <span className="muted meta-extra">· {i.category}</span>}
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

// Reference intakes for an adult on 2,000 kcal a day; scaled to the household's calories.
const RI = { protein: 50, carbs: 260, fat: 70 };
const MACRO_NAMES = { protein: "Protein", carbs: "Carbs", fat: "Fat" } as const;
type Macro = keyof typeof RI;

/** What the shop comes to in calories against a week for the household, with the household, a usual week,
 * macros and the food pyramid tucked away until you open them. */
function Nutrition({
  items,
  typical,
  groups,
  adults,
  setAdults,
  children,
  setChildren,
}: {
  items: ShopItem[];
  typical: TypicalShop;
  groups: FoodGroup[];
  adults: number;
  setAdults: (n: number) => void;
  children: number;
  setChildren: (n: number) => void;
}) {
  const known = items.filter((i) => i.kcal_low !== null && i.kcal_high !== null);
  const low = known.reduce((s, i) => s + i.kcal_low! * i.qty, 0);
  const high = known.reduce((s, i) => s + i.kcal_high! * i.qty, 0);
  const missing = items.length - known.length;
  const adultWeek = adults * KCAL_ADULT * 7;
  const childWeek = children * KCAL_CHILD * 7;
  const need = adultWeek + childWeek;
  const pct = (n: number) => Math.round((n / need) * 100);
  const width = (n: number, of = need) => `${Math.min(100, (n / of) * 100)}%`;
  const who = [plural(adults, "adult", "adults"), children > 0 && plural(children, "child", "children")].filter(Boolean).join(" and ");
  const usual = typical?.kcal_week ?? null;

  const withMacros = items.filter((i) => i.protein !== null || i.carbs !== null || i.fat !== null);
  const grams = (m: Macro) => items.reduce((s, i) => s + (i[m] ?? 0) * i.qty, 0);
  const macroNeed = (m: Macro) => (RI[m] * need) / 2000;

  return (
    <div className="kcal" aria-live="polite">
      {known.length === 0 ? (
        <p className="muted">Add calories per pack to your items (Purchased items → Calories & macros) to see what this shop comes to.</p>
      ) : (
        <>
          <p className="kcal-line">
            <strong>≈ {range(low, high)} kcal</strong>{" "}
            <span className="muted">
              {pct(low) === pct(high) ? pct(low) : `${pct(low)}–${pct(high)}`}% of a week for {who}
            </span>
          </p>
          <div className="meter" aria-hidden="true">
            <span className="high" style={{ width: width(high) }} />
            <span style={{ width: width(low) }} />
          </div>
          {(missing > 0 || low !== high) && (
            <p className="muted kcal-note">
              {missing > 0 && `${plural(missing, "item has", "items have")} no calories yet. `}
              {low !== high && "The range depends on what you pick."}
            </p>
          )}
        </>
      )}

      <details className="more">
        <summary>Household, usual week and macros</summary>
        <table className="household">
          <tbody>
            <tr>
              <th scope="row">
                <label>
                  Adults <input type="number" min={1} max={12} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
                </label>
              </th>
              <td className="muted per-day">× {num(KCAL_ADULT)} a day</td>
              <td>{num(adultWeek)} kcal a week</td>
            </tr>
            <tr>
              <th scope="row">
                <label>
                  Children <input type="number" min={0} max={12} value={children} onChange={(e) => setChildren(Number(e.target.value))} />
                </label>
              </th>
              <td className="muted per-day">× {num(KCAL_CHILD)} a day</td>
              <td>{num(childWeek)} kcal a week</td>
            </tr>
            <tr className="total">
              <th scope="row">Together</th>
              <td className="per-day" />
              <td>
                <strong>{num(need)} kcal a week</strong>
              </td>
            </tr>
          </tbody>
        </table>

        {usual !== null && typical && (
          <div className="kcal-row">
            <p className="kcal-label">
              A usual week <span className="muted">≈ {num(usual)} kcal, {pct(usual)}%</span>
            </p>
            <div className="meter" aria-hidden="true">
              <span style={{ width: width(usual) }} />
            </div>
            <p className="muted kcal-note">
              Over the {plural(typical.weeks, "week", "weeks")} you shopped; weeks with no shopping are left out.
              {typical.kcal_known < 0.95 && ` Counts the ${Math.round(typical.kcal_known * 100)}% of things with calories set.`}
            </p>
          </div>
        )}

        <div className="kcal-row">
          <p className="kcal-label">Macros in this shop</p>
          {withMacros.length === 0 ? (
            <p className="muted kcal-note">Add protein, carbs and fat per pack on the Purchased items page to see these.</p>
          ) : (
            <>
              <ul className="macros">
                {(Object.keys(RI) as Macro[]).map((m) => (
                  <li key={m}>
                    <span>{MACRO_NAMES[m]}</span>
                    <span className="meter" aria-hidden="true">
                      <span style={{ width: width(grams(m), macroNeed(m)) }} />
                    </span>
                    <span className="macro-value">
                      {num(grams(m))} g <span className="muted">of {num(macroNeed(m))}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted kcal-note">
                Against a week's reference intake for {who}. From the {withMacros.length} of {plural(items.length, "item", "items")} with
                macros set.
              </p>
            </>
          )}
        </div>
      </details>

      {groups.length > 0 && items.length > 0 && <Pyramid items={items} groups={groups} />}
    </div>
  );
}

/** The food pyramid with this shop on it: how many things on each shelf, top shelf (treats) smallest. */
// An icon for each shelf of the pyramid.
const SHELF_ICONS: Record<string, IconName> = { veg: "veg", starch: "bread", dairy: "milk", protein: "protein", fats: "fats", treats: "treats" };

function Pyramid({ items, groups }: { items: ShopItem[]; groups: FoodGroup[] }) {
  const count = (id: string) => items.filter((i) => i.food_group === id).length;
  const notFood = items.filter((i) => !i.food_group).length;
  const most = Math.max(1, ...groups.map((g) => count(g.id)));
  const shelves = [...groups].reverse(); // top first
  return (
    <details className="more">
      <summary>Food pyramid</summary>
      <ol className="pyramid" aria-label="Food pyramid, top shelf first">
        {shelves.map((g, i) => {
          const n = count(g.id);
          return (
            <li key={g.id} style={{ width: `${55 + (45 * i) / (shelves.length - 1)}%` }} title={`${g.name}: ${g.advice}`}>
              <span className="shelf-fill" style={{ width: `${(n / most) * 100}%` }} aria-hidden="true" />
              <span className="shelf-text">
                <span className="shelf-name">
                  <Icon name={SHELF_ICONS[g.id] ?? "veg"} size={16} /> {g.name}
                </span>
                <span className="muted">
                  {n} · {g.advice}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="muted kcal-note">
        Things on this shop on each shelf of the food pyramid.{notFood > 0 && ` ${plural(notFood, "thing isn't", "things aren't")} food.`} Set an
        item's food group on the Purchased items page if it's guessed wrong.
      </p>
    </details>
  );
}

/** A typical shop from your history, aisle by aisle. Tap an aisle to see just that aisle in the list. */
function Typical({ t, aisle, pick }: { t: NonNullable<TypicalShop>; aisle: string | null; pick: (aisle: string) => void }) {
  const most = Math.max(...t.aisles.map((a) => a.products), 1);
  return (
    <section aria-labelledby="typical-heading" className="typical-card">
      <div className="section-head">
        <h2 id="typical-heading">Your typical shop</h2>
        <span className="muted" title={`${shortDate(t.from)} to ${shortDate(t.to)}`}>
          {plural(t.trips, "trip", "trips")}
        </span>
      </div>
      <p className="muted typical-sum">
        {t.products} products{t.spend !== null && ` · €${t.spend.toFixed(2)}`}
        {t.kcal !== null && ` · ${num(t.kcal)} kcal`} a shop
      </p>
      <ul className="typical">
        {t.aisles.map((a) => (
          <li key={a.aisle}>
            <button
              className={`typical-row${aisle === a.aisle ? " on" : ""}`}
              aria-pressed={aisle === a.aisle}
              onClick={() => pick(a.aisle)}
              title={a.top.length ? `Mostly ${a.top.join(", ")}` : undefined}
            >
              <span className="typical-name">{a.aisle}</span>
              <span className="bar" aria-hidden="true">
                <span style={{ width: `${(a.products / most) * 100}%` }} />
              </span>
              <span className="typical-value">
                {a.products}
                {a.spend !== null && <span className="muted"> · €{a.spend.toFixed(2)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted hint">Products and spend per shop in each aisle over the last year. Tap an aisle to see just that aisle.</p>
    </section>
  );
}
