import { useEffect, useState } from "react";
import { api, type CatalogItem } from "./api";

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type Figure = "kcal" | "protein" | "carbs" | "fat";
const FIGURES: { key: Figure; label: string; unit: string }[] = [
  { key: "kcal", label: "Calories", unit: "kcal" },
  { key: "protein", label: "Protein", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
];
const MODE_KEY = "shopping-list.nutrition-mode";
// The same aisles the server treats as not food.
const NOT_FOOD = /household|toiletr|baby|pet|cleaning|health|beauty|home/i;

/** Grams (or ml) in a pack, read from a name like "Brennans Family Pan 800g", "Milk 2L" or "Cola 6 x 330ml". */
export function sizeFromName(name: string): number | null {
  const m = name.toLowerCase().replace(",", ".").match(/(?:(\d+)\s*x\s*)?(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l|litre|litres)\b/);
  if (!m) return null;
  const per = { kg: 1000, g: 1, ml: 1, cl: 10, l: 1000, litre: 1000, litres: 1000 }[m[3] as "kg"];
  return (m[1] ? Number(m[1]) : 1) * Number(m[2]) * per;
}

const round = (n: number, whole: boolean) => (whole ? Math.round(n) : Math.round(n * 10) / 10);

/**
 * Calories and macros for many items at once: one row each, saved as you leave a box. Type them per pack, or per
 * 100 g straight off the label with the pack size, and it works out the pack.
 */
export default function NutritionTable({ catalog, run }: { catalog: CatalogItem[]; run: Run }) {
  const [per100, setPer100] = useState(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "100";
    } catch {
      return false;
    }
  });
  const [missingOnly, setMissingOnly] = useState(true);
  const [find, setFind] = useState("");
  const setMode = (on: boolean) => {
    setPer100(on);
    try {
      localStorage.setItem(MODE_KEY, on ? "100" : "pack");
    } catch {
      // Not remembered on this device.
    }
  };

  // Food only: anything with a food group (yours or guessed), or in a food aisle. Nappies, candles and the like stay out.
  const food = catalog.filter(
    (c) => c.kind !== "or" && (c.food_group !== "" || c.food_group_guess !== "" || (!NOT_FOOD.test(c.category) && c.category !== "Other")),
  );
  const missing = (c: CatalogItem) => FIGURES.some((f) => c[f.key] === null);
  const q = find.trim().toLowerCase();
  const rows = food
    .filter((c) => (!missingOnly || missing(c)) && (!q || c.name.toLowerCase().includes(q)))
    .sort((a, b) => b.trips - a.trips || a.name.localeCompare(b.name));
  const done = food.filter((c) => !missing(c)).length;

  return (
    <section aria-labelledby="nutrition-table-heading" className="nutrition-table">
      <div className="section-head">
        <h2 id="nutrition-table-heading">Calories and macros</h2>
        <span className="muted">
          {done} of {food.length} done
        </span>
      </div>
      <p className="muted part-note">
        Type them from the pack: each box saves when you leave it. Most bought first. Things that aren't food are left out: give one a food group if it should be here.
      </p>
      <div className="nutrition-controls">
        <div className="order" role="radiogroup" aria-label="Figures are">
          <button role="radio" aria-checked={!per100} aria-pressed={!per100} onClick={() => setMode(false)}>
            Per pack
          </button>
          <button role="radio" aria-checked={per100} aria-pressed={per100} onClick={() => setMode(true)}>
            Per 100 g
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> Only ones with gaps
        </label>
        <input type="search" className="filter" placeholder="Find an item…" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find an item" />
      </div>
      {per100 && <p className="muted part-note">Per 100 g (or 100 ml) as on the label, with the pack size: the pack's figures are worked out from them.</p>}

      {rows.length === 0 ? (
        <p className="empty">{missingOnly ? "Every item has all four. Nicely done." : "No items match."}</p>
      ) : (
        <div className="nutrition-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Item</th>
                {per100 && <th scope="col">Pack g/ml</th>}
                {FIGURES.map((f) => (
                  <th scope="col" key={f.key}>
                    {f.label} <span className="muted">{f.unit}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Row key={c.id} item={c} per100={per100} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Row({ item, per100, run }: { item: CatalogItem; per100: boolean; run: Run }) {
  const [size, setSize] = useState(() => sizeFromName(item.name)?.toString() ?? "");
  const grams = Number(size) > 0 ? Number(size) : null;
  return (
    <tr>
      <th scope="row">
        <span className="nutrition-name">{item.name}</span>
        {item.trips > 0 && <span className="muted"> · {item.trips}×</span>}
      </th>
      {per100 && (
        <td>
          <input
            className="size"
            inputMode="decimal"
            value={size}
            placeholder="?"
            aria-label={`Pack size in grams or ml for ${item.name}`}
            onChange={(e) => setSize(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </td>
      )}
      {FIGURES.map((f) => (
        <td key={f.key}>
          <Cell item={item} figure={f.key} per100={per100} grams={grams} run={run} />
        </td>
      ))}
    </tr>
  );
}

function Cell({ item, figure, per100, grams, run }: { item: CatalogItem; figure: Figure; per100: boolean; grams: number | null; run: Run }) {
  const whole = figure === "kcal";
  const pack = item[figure];
  const shown = pack === null ? "" : per100 ? (grams ? String(round((pack * 100) / grams, false)) : "") : String(pack);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const needsSize = per100 && !grams;

  const commit = () => {
    const t = text.trim().replace(",", ".");
    if (t === shown) return;
    const n = t === "" ? null : Number(t);
    if (n !== null && !(n >= 0)) return setText(shown);
    const value = n === null ? null : round(per100 && grams ? (n * grams) / 100 : n, whole);
    if (value !== pack) void run(() => api.editCommon(item.id, { [figure]: value }));
  };

  return (
    <input
      inputMode={whole && !per100 ? "numeric" : "decimal"}
      value={text}
      disabled={needsSize}
      placeholder={needsSize ? "size?" : "–"}
      title={needsSize ? "Add the pack size first" : undefined}
      aria-label={`${figure === "kcal" ? "Calories" : figure} ${per100 ? "per 100 g" : "per pack"} for ${item.name}`}
      onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
