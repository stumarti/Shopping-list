import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import { api, itemLinks, type CatalogItem, type CommonChange, type FoodGroup, type ItemHistory, type Links } from "./api";
import { byTrips, OrderToggle, useOrder } from "./Order";
import PriceChart from "./PriceChart";
import Spending from "./Spending";
import WeeklyChart from "./WeeklyChart";
import Icon from "./Icon";

const Scanner = lazy(() => import("./Scanner"));
const NutritionTable = lazy(() => import("./NutritionTable"));

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

/** Your purchased items (and any you added), most bought first or aisle by aisle. Kinds of one thing sit under their generic item
 * (Broccoli: tenderstem, florets). Tap one for its weekly history and when you'll want it next. */
export default function Manage({ catalog, categories, links, groupBy, run }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  // Generic items whose kinds are showing; kinds are folded away until you open them.
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set());
  const toggleKinds = (id: number) => {
    const next = new Set(unfolded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setUnfolded(next);
  };
  const [order, setOrder] = useOrder();
  const [foodGroups, setFoodGroups] = useState<FoodGroup[]>([]);
  const [macros, setMacros] = useState(false);
  // On a wide screen the open item sits in a panel beside the list; on a phone it opens in the list.
  const wide = useWide(880);
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
  // Kinds show when unfolded, when your search matches one, or when one of them is open.
  const kindsShown = (id: number) => unfolded.has(id) || (f !== "" && kindsOf(id).some(matches)) || kindsOf(id).some((k) => k.id === open);

  // Open: in the side panel on a wide screen, opened in the list on a phone.
  const isOpen = (id: number) => (wide && !macros ? panelItem?.id === id : open === id);

  const row = (item: CatalogItem, kind = false) => (
    <li key={item.id} className={`${isOpen(item.id) ? "open" : ""}${kind ? " kind" : ""}`}>
      <button
        className="common-name"
        aria-expanded={wide ? undefined : isOpen(item.id)}
        aria-current={wide && isOpen(item.id) ? "true" : undefined}
        onClick={() => setOpen(wide ? item.id : open === item.id ? null : item.id)}
      >
        <span>
          {item.name}
          {item.or_id !== null && sets.has(item.or_id) && <span className="tag-or"> or {sets.get(item.or_id)}</span>}
          {order === "often" && !kind && <span className="muted aisle-note"> · {item.category}</span>}
        </span>
        <span className="common-right">
          <span className="muted trips">{item.trips > 0 ? `${item.trips}×` : ""}</span>
          <span className="chev" aria-hidden="true">
            {wide ? "›" : isOpen(item.id) ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {!kind && kindsOf(item.id).length > 0 && (
        <button className="kinds-toggle" aria-expanded={kindsShown(item.id)} onClick={() => toggleKinds(item.id)}>
          {kindsShown(item.id) ? "▾" : "▸"} {kindsOf(item.id).length} kinds
          {!kindsShown(item.id) && <span className="muted"> · {kindsOf(item.id).slice(0, 3).map((k) => k.name).join(", ")}{kindsOf(item.id).length > 3 ? "…" : ""}</span>}
        </button>
      )}
      {open === item.id && !wide && (
        <ItemDetail
          key={item.id}
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

  // The item in the side panel: the one you opened, or else the most bought.
  const firstItem = groups[0]?.[1][0] ?? null;
  const panelItem = wide && !macros ? (catalog.find((c) => c.id === open) ?? firstItem) : null;

  return (
    <>
    <Spending refresh={catalog.length} />
    <div className={panelItem ? "items-layout" : undefined}>
    <section aria-labelledby="common-heading" className="items-list">
      <div className="section-head">
        <h2 id="common-heading">Purchased items</h2>
        {count > 0 && (
          <span className="common-head-actions">
            <button className={`link macros-toggle${macros ? " on" : ""}`} aria-pressed={macros} onClick={() => setMacros(!macros)}>
              <Icon name="fire" size={16} /> {macros ? "Back to items" : "Calories & macros"}
            </button>
            {!macros && <OrderToggle order={order} setOrder={setOrder} />}
          </span>
        )}
      </div>
      {macros && (
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <NutritionTable catalog={catalog} run={run} />
        </Suspense>
      )}
      {!macros && (
      <>
      <p className="muted">
        {count} items
        {count > 0 && (
          <>
            {" · "}
            <button
              className="link danger"
              onClick={() => {
                if (confirm(`Remove all ${count} items? Your list and purchase history stay, and Settings → Rebuild from history can bring them back.`))
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
          No items yet. Upload your Tesco data, or add some, in <a href="#settings">Settings</a>.
        </p>
      ) : (
        <input
          type="search"
          className="filter"
          placeholder="Find an item or barcode…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Find an item"
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
                {kindsShown(item.id) && kindsOf(item.id).map((k) => row(k, true))}
              </Fragment>
            ))}
          </ul>
        </div>
      ))}
      {count > 0 && (
        <p className="muted hint">
          The number is how many shopping trips each item was on. In an item's Details, group kinds of one thing under a generic item
          (Kind of: Broccoli), or put things where one will do into a pick-one set (Pick one of: Protein).
        </p>
      )}
      </>
      )}
    </section>
    {panelItem && (
      <section className="items-panel" aria-label={panelItem.name}>
        <ItemDetail
          key={panelItem.id}
          item={panelItem}
          catalog={catalog}
          categories={categories}
          foodGroups={foodGroups}
          links={links}
          run={run}
          onGone={() => setOpen(null)}
          title
        />
      </section>
    )}
    </div>
    </>
  );
}

/** Whether the window is at least this wide, kept up to date. */
function useWide(px: number) {
  const query = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const onChange = () => setWide(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [query]);
  return wide;
}

function ItemDetail({
  item,
  catalog,
  categories,
  foodGroups,
  links,
  run,
  onGone,
  title = false,
}: {
  item: CatalogItem;
  catalog: CatalogItem[];
  categories: string[];
  foodGroups: FoodGroup[];
  links: Links | null;
  run: Props["run"];
  onGone: () => void;
  /** Show the item's name on top (in the side panel, where the row isn't beside it). */
  title?: boolean;
}) {
  const [tab, setTab] = useState<"history" | "nutrition" | "details">("history");
  // Compare as the generic item (null: all its kinds together, the default) or one exact product.
  const [focus, setFocus] = useState<number | null>(null);
  const [history, setHistory] = useState<ItemHistory | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [name, setName] = useState(item.name);
  const [barcode, setBarcode] = useState(item.barcode);
  const [scanning, setScanning] = useState(false);
  const [nutritionNote, setNutritionNote] = useState<string | null>(null);
  const hasAll = item.kcal !== null && item.protein !== null && item.carbs !== null && item.fat !== null;
  const hasNone = item.kcal === null && item.protein === null && item.carbs === null && item.fat === null;
  // Calories and macros from Open Food Facts by barcode; only empty ones, unless replacing.
  const fillNutrition = (overwrite: boolean) => {
    setNutritionNote("Looking it up…");
    void run(async () => {
      try {
        const r = await api.fillNutrition(item.id, overwrite);
        const names = r.filled.map((f) => ({ kcal: "calories", protein: "protein", carbs: "carbs", fat: "fat" })[f] ?? f);
        setNutritionNote(
          !r.found
            ? "Open Food Facts has no nutrition (or no pack size) for this barcode. Type them in from the pack."
            : names.length
              ? `Filled ${names.join(", ")} from Open Food Facts (${r.basis}).`
              : "Nothing to fill: it already had those.",
        );
      } catch (e) {
        setNutritionNote(null);
        throw e;
      }
    });
  };
  const groupName = (id: number | null) => catalog.find((c) => c.id === id)?.name ?? "";
  const [group, setGroup] = useState(groupName(item.group_id));
  const [orSet, setOrSet] = useState(groupName(item.or_id));
  const kinds = catalog.filter((c) => c.group_id === item.id);
  const generics = catalog.filter((c) => c.kind !== "or" && c.group_id === null && c.id !== item.id);
  const setNames = catalog.filter((c) => c.kind === "or");

  useEffect(() => {
    api.itemHistory(focus ?? item.id, focus !== null).then(setHistory, () => setHistory(null));
  }, [item.id, focus]);
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
  const priced = history?.purchases.filter((p) => p.unit_price !== null).length ?? 0;
  // Several kinds counted together: their prices are a mix.
  const mixed = Boolean(history && history.view === "generic" && history.by_kind.length > 1);

  return (
    <div className="detail">
      {title && (
        <div className="detail-title">
          <h3>{item.name}</h3>
          <span className="muted">
            {item.category}
            {item.trips > 0 && ` · on ${item.trips} ${item.trips === 1 ? "trip" : "trips"}`}
          </span>
        </div>
      )}
      <div className="detail-tabs" role="tablist" aria-label={`About ${item.name}`}>
        {(
          [
            ["history", "History"],
            ["nutrition", "Nutrition"],
            ["details", "Details"],
          ] as const
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "history" && (
        <div role="tabpanel">
      {!history ? (
        <p className="muted">Loading…</p>
      ) : bought === 0 ? (
        <p className="muted">No purchases of this yet.</p>
      ) : (
        <>
          {history.kind && history.by_kind.length > 0 && (
            <div className="view-pick" role="radiogroup" aria-label="Compare as">
              <button role="radio" aria-checked={focus === null} className={focus === null ? "on" : ""} onClick={() => setFocus(null)}>
                All {history.kind.name}
              </button>
              {history.by_kind.map((k) => (
                <button key={k.id} role="radio" aria-checked={focus === k.id} className={focus === k.id ? "on" : ""} onClick={() => setFocus(k.id)}>
                  {k.name}
                </button>
              ))}
            </div>
          )}
          <p className="next">
            <NextPurchase expected={s!.next_expected} />
          </p>
          {history.kind && (
            <p className="kind-note">
              {history.view === "generic"
                ? `All kinds of ${history.kind.name} counted together, since any of them will do. Pick one above for just that product.`
                : `Just ${history.item.name}. Pick All ${history.kind.name} to count every kind.`}
            </p>
          )}
          <p className="muted stats">
            Bought {s!.trips} {s!.trips === 1 ? "time" : "times"}
            {s!.every_days !== null && `, about every ${s!.every_days === 7 ? "week" : `${s!.every_days} days`}`}, last {fmt(s!.last_bought)}
            {s!.usual_qty > 1 && `. Usually ${Math.round(s!.usual_qty)} at a time`}.
            {s!.price && priced <= 1 && <> {euro(s!.price.now)} each.</>}
            {history.spend > 0 && <> You've spent {euro(history.spend)}{mixed ? " on them all" : " on it"}.</>}
          </p>
          {mixed && (
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
          {priced > 1 && (
            <>
              <h4>Price</h4>
              {mixed && <p className="muted small">Each kind's price as bought, so a jump can be a different kind. Pick one above to follow one product.</p>}
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
        </div>
      )}

      {tab === "nutrition" && (
        <div role="tabpanel" className="edit-fields">
        <fieldset className="nutrition">
          <legend>Per pack (or each)</legend>
          <Amount label="Calories" unit="kcal" value={item.kcal} average={item.kinds_average?.kcal} whole onSave={(v) => save({ kcal: v })} />
          <Amount label="Protein" unit="g" value={item.protein} average={item.kinds_average?.protein} onSave={(v) => save({ protein: v })} />
          <Amount label="Carbs" unit="g" value={item.carbs} average={item.kinds_average?.carbs} onSave={(v) => save({ carbs: v })} />
          <Amount label="Fat" unit="g" value={item.fat} average={item.kinds_average?.fat} onSave={(v) => save({ fat: v })} />
          {item.kinds_average && (
            <p className="muted nutrition-note">
              A generic item: an empty box uses the average of its {kinds.length} kinds (shown in grey), and that's what the next shop
              counts. Type your own figure, per pack or per one, to use that instead.
            </p>
          )}
          <div className="nutrition-fill">
            <button
              type="button"
              className="link"
              disabled={!item.barcode}
              title={item.barcode ? undefined : "Add or scan its barcode first"}
              onClick={() => fillNutrition(hasAll)}
            >
              <Icon name="fire" size={16} /> {hasAll ? "Replace from Open Food Facts" : "Fill from Open Food Facts"}
            </button>
            {!item.barcode && <span className="muted"> · needs a barcode</span>}
            {nutritionNote && (
              <p className="muted" role="status">
                {nutritionNote}
              </p>
            )}
          </div>
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
        </div>
      )}

      {tab === "details" && (
        <div role="tabpanel">
          <div className="edit-fields two">
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
              placeholder="e.g. Broccoli"
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
              placeholder="e.g. Protein"
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
          <span className="with-unit">
            <input
              value={barcode}
              inputMode="numeric"
              maxLength={14}
              placeholder="None"
              onChange={(e) => setBarcode(e.target.value.replace(/\D/g, ""))}
              onBlur={() => barcode !== item.barcode && save({ barcode })}
            />
            <button type="button" className="scan-button" onClick={() => setScanning(true)} aria-label={`Scan the barcode for ${item.name}`} title="Scan">
              <Icon name="scan" size={22} />
            </button>
          </span>
        </label>
        {scanning && (
          <Suspense fallback={null}>
            <Scanner
              title={`Scan ${item.name}`}
              onClose={() => setScanning(false)}
              onCode={(code) => {
                setScanning(false);
                setBarcode(code);
                // A new barcode with no figures yet: fill them straight away.
                void save({ barcode: code }).then(() => hasNone && fillNutrition(false));
              }}
            />
          </Suspense>
        )}
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
      )}
    </div>
  );
}

/** A number per pack, saved when you leave the box; empty clears it. */
function Amount({
  label,
  unit,
  value,
  average,
  whole,
  onSave,
}: {
  label: string;
  unit: string;
  value: number | null;
  /** A generic item's kinds' average, shown when there's no figure of its own. */
  average?: number | null;
  whole?: boolean;
  onSave: (v: number | null) => void;
}) {
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
          placeholder={average != null ? `≈ ${average}` : "–"}
          title={average != null && value === null ? "The average of its kinds" : undefined}
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
