import { useEffect, useState } from "react";
import { useWidth } from "./useWidth";
import { api, type Spending as Data } from "./api";
import { PriceImpact, PriceIndex } from "./PriceTrends";

const H = 140;
const LEFT = 48;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 22;
const GAP = 2;

const euro = (n: number) => `€${n.toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const roundEuro = (n: number) => `€${Math.round(n).toLocaleString("en-IE")}`;
const monthName = (m: string, year = false) =>
  new Date(m + "-15T12:00:00").toLocaleDateString("en-IE", year ? { month: "short", year: "numeric" } : { month: "short" });
const fmt = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
const moved = (index: number | null, change: number) => (index !== null ? index / 100 - 1 : change);
const pct = (n: number) => `${Math.abs(n * 100).toFixed(1)}%`;

type Month = { month: string; spend: number; trips: number };

/** Every month from the first to the last, with months you didn't shop at all as gaps. */
function allMonths(months: Month[]): Month[] {
  if (!months.length) return [];
  const have = new Map(months.map((m) => [m.month, m]));
  const out: Month[] = [];
  let [y, mo] = months[0].month.split("-").map(Number);
  const end = months[months.length - 1].month;
  for (;;) {
    const key = `${y}-${String(mo).padStart(2, "0")}`;
    out.push(have.get(key) ?? { month: key, spend: 0, trips: 0 });
    if (key === end) return out;
    mo === 12 ? ((y += 1), (mo = 1)) : (mo += 1);
  }
}

/** Upper bound for the axis: a round number just above the biggest month. */
function niceMax(n: number) {
  const step = [50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => n / s <= 4) ?? 5000;
  return Math.max(step, Math.ceil(n / step) * step);
}

/** What you've spent and how prices have moved, from your purchase history. The headline shows; the month by
 * month chart and the biggest price changes open below it. */
export default function Spending({ refresh, onPick }: { refresh: number; onPick?: (catalogId: number) => void }) {
  const [data, setData] = useState<Data>(null);
  const [hover, setHover] = useState<Month | null>(null);
  // Price changes per generic item (all kinds of broccoli together, the default), or per exact product.
  const [exact, setExact] = useState(false);
  const [box, W] = useWidth<HTMLDivElement>(640);
  useEffect(() => {
    api.spending(exact).then(setData, () => setData(null));
  }, [refresh, exact]);
  if (!data) return null;
  // How much prices have moved: the price index's latest month (shelf prices), else the before-and-after average.
  const lastIndex = data.index.length >= 2 ? data.index[data.index.length - 1].index : null;

  const months = allMonths(data.months);
  const max = niceMax(Math.max(...months.map((m) => m.spend)));
  const slot = (W - LEFT - RIGHT) / months.length;
  const barW = Math.max(2, slot - GAP);
  const y = (v: number) => TOP + (1 - v / max) * (H - TOP - BOTTOM);
  const base = y(0);
  const p = data.prices;
  // Name every month when there's room, every other when it's tight, else only the first and each January.
  const labelled = (m: Month, i: number) => slot >= 34 || (slot >= 17 && i % 2 === 0) || i === 0 || m.month.endsWith("-01");

  return (
    <section aria-labelledby="spend-heading" className="spending">
      <details>
        <summary>
          <span className="spend-title" id="spend-heading">
            Spending and prices
          </span>
          <span className="spend-headline">
            <strong>{roundEuro(data.total)}</strong> <span className="muted">since {fmt(data.from)}</span> ·{" "}
            <strong>{euro(data.a_week)}</strong> <span className="muted">a week</span>
            {p && (
              <>
                {" · "}
                <span>
                  prices {moved(lastIndex, p.change) >= 0 ? "▲ up" : "▼ down"} {pct(moved(lastIndex, p.change))}
                </span>
              </>
            )}
          </span>
        </summary>

        <p className="muted">
          {euro(data.total)} over {data.trips} shops: about {euro(data.a_shop)} a shop and {euro(data.a_week)} a week. A week only counts if
          you shopped that week ({data.weeks} weeks), so weeks away don't bring it down.
        </p>

        <h4>Month by month</h4>
        <div ref={box}>
        <svg
          className="spend-chart"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Monthly spending from ${monthName(months[0].month, true)} to ${monthName(months[months.length - 1].month, true)}.`}
          onMouseLeave={() => setHover(null)}
        >
          {[0, max / 2, max].map((v) => (
            <g key={v}>
              <line className="grid" x1={LEFT} x2={W - RIGHT} y1={y(v)} y2={y(v)} />
              <text className="axis" x={LEFT - 6} y={y(v) + 4} textAnchor="end">
                {roundEuro(v)}
              </text>
            </g>
          ))}
          {months.map((m, i) => {
            const x = LEFT + i * slot + GAP / 2;
            const top = y(m.spend);
            const r = Math.min(4, barW / 2, base - top);
            return (
              <g key={m.month} onMouseEnter={() => setHover(m)} onClick={() => setHover(m)}>
                {/* Hit target: the whole column, bigger than the bar. */}
                <rect x={LEFT + i * slot} y={TOP} width={slot} height={H - TOP - BOTTOM} fill="transparent" />
                {m.spend > 0 ? (
                  <path
                    className={`spend-bar${hover?.month === m.month ? " on" : ""}`}
                    d={`M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z`}
                  />
                ) : (
                  <line className="no-shop" x1={x} x2={x + barW} y1={base - 1} y2={base - 1} />
                )}
                {labelled(m, i) && (
                  <text className="axis" x={x + barW / 2} y={H - 6} textAnchor="middle">
                    {monthName(m.month, i === 0 || m.month.endsWith("-01"))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        </div>
        <p className="muted chart-status" role="status">
          {hover
            ? hover.trips
              ? `${monthName(hover.month, true)}: ${euro(hover.spend)} on ${hover.trips} ${hover.trips === 1 ? "shop" : "shops"}`
              : `${monthName(hover.month, true)}: no shopping`
            : "Hover or tap a month."}
        </p>

        {p && (
          <>
            <div className="section-head prices-head">
              <h4>Prices</h4>
              <div className="order" role="radiogroup" aria-label="Compare prices by">
                <button role="radio" aria-checked={!exact} aria-pressed={!exact} onClick={() => setExact(false)}>
                  Generic items
                </button>
                <button role="radio" aria-checked={exact} aria-pressed={exact} onClick={() => setExact(true)}>
                  Exact products
                </button>
              </div>
            </div>
            <p>
              Things you buy again and again cost{" "}
              <strong>
                {moved(lastIndex, p.change) >= 0 ? "▲" : "▼"} {pct(moved(lastIndex, p.change))} {moved(lastIndex, p.change) >= 0 ? "more" : "less"}
              </strong>{" "}
              than when you started, which is about <strong>{p.impact >= 0 ? `+€${p.impact.toFixed(2)}` : `−€${Math.abs(p.impact).toFixed(2)}`}</strong> on a
              month's shopping.
            </p>
            <h5>Your grocery prices</h5>
            <PriceIndex index={data.index} />
            <h5>What's driving it</h5>
            <p className="muted part-note">
              Each price change, sized by what it adds (or saves) a month at the rate you buy it: biggest first, not just the biggest
              percentage.{onPick && " Tap one to open it."}
            </p>
            <PriceImpact moves={[...p.up, ...p.down].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))} onPick={onPick} />
          </>
        )}
      </details>
    </section>
  );
}
