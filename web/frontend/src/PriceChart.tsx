import { useState } from "react";
import { useWidth } from "./useWidth";

type Purchase = { bought_on: string; unit_price: number | null; qty: number; catalog_id?: number; kind_name?: string };
type Point = { day: string; price: number; qty: number; deal: boolean; usual: number };
type Series = { id: string; name: string; points: Point[]; slot: number };

const H = 170;
const LEFT = 46;
const RIGHT = 14;
const TOP = 12;
const BOTTOM = 24;
const DEAL = 0.85; // a price this far under the usual one is a deal (Clubcard price, half price…)
const MAX_SERIES = 3; // the colours that stay apart for everyone; more kinds are left to the list above

const euro = (n: number) => `€${n.toFixed(2)}`;
const time = (iso: string) => new Date(iso + "T12:00:00").getTime();
const fmt = (iso: string, year = true) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-IE", year ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** One point a day (the average if bought twice), each marked a deal when well under the usual price around it. */
function points(purchases: Purchase[]): Point[] {
  const days = new Map<string, { sum: number; n: number; qty: number }>();
  for (const p of purchases) {
    if (p.unit_price === null) continue;
    const d = days.get(p.bought_on) ?? { sum: 0, n: 0, qty: 0 };
    days.set(p.bought_on, { sum: d.sum + p.unit_price, n: d.n + 1, qty: d.qty + p.qty });
  }
  const raw = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, price: d.sum / d.n, qty: d.qty }));
  return raw.map((p, i) => {
    // The usual price: the median of the buys around it (four either side).
    const usual = median(raw.slice(Math.max(0, i - 4), i + 5).map((q) => q.price));
    return { ...p, usual, deal: raw.length >= 3 && p.price < usual * DEAL };
  });
}

/** Ticks on round cent values: three or four gridlines. */
function ticks(low: number, high: number): number[] {
  const span = Math.max(high - low, 0.1);
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10].find((s) => span / s <= 3) ?? 10;
  const out = [];
  for (let v = Math.floor(low / step) * step; v <= high + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/**
 * An item's price over time. The shelf price is a step line (it holds until it changes); deals (well under the
 * usual price) are hollow dots below it rather than dips, with what they saved. With several kinds (all kinds of
 * Broccoli together), each kind is its own line, labelled. Hover or tap for a day.
 */
export default function PriceChart({ purchases }: { purchases: Purchase[] }) {
  const [hover, setHover] = useState<{ s: Series; p: Point } | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(640);

  // One series per kind (most bought first), or one for a single product.
  const groups = new Map<string, { name: string; rows: Purchase[] }>();
  for (const p of purchases) {
    const id = String(p.catalog_id ?? "one");
    if (!groups.has(id)) groups.set(id, { name: p.kind_name ?? "", rows: [] });
    groups.get(id)!.rows.push(p);
  }
  const all = [...groups.entries()]
    .map(([id, g]) => ({ id, name: g.name, points: points(g.rows), slot: 0 }))
    .filter((s) => s.points.length > 0)
    .sort((a, b) => b.points.length - a.points.length);
  const series: Series[] = all.slice(0, MAX_SERIES).map((s, i) => ({ ...s, slot: all.length > 1 ? i + 1 : 0 }));
  const hidden = all.length - series.length;
  const flat = series.flatMap((s) => s.points);
  if (flat.length < 2) return null;

  const days = flat.map((p) => p.day).sort();
  const t0 = time(days[0]);
  const t1 = time(days[days.length - 1]);
  const yTicks = ticks(Math.min(...flat.map((p) => p.price)), Math.max(...flat.map((p) => p.price)));
  const yLow = yTicks[0];
  const yHigh = yTicks[yTicks.length - 1];
  const x = (day: string) => LEFT + ((time(day) - t0) / (t1 - t0 || 1)) * (W - LEFT - RIGHT);
  const y = (price: number) => TOP + (1 - (price - yLow) / (yHigh - yLow || 1)) * (H - TOP - BOTTOM);

  // The shelf price as steps through the regular (non-deal) buys.
  const steps = (s: Series) => {
    const regular = s.points.filter((p) => !p.deal);
    if (!regular.length) return "";
    return regular
      .map((p, i) => (i === 0 ? `M${x(p.day).toFixed(1)},${y(p.price).toFixed(1)}` : `H${x(p.day).toFixed(1)}V${y(p.price).toFixed(1)}`))
      .join("");
  };

  const single = series.length === 1 ? series[0] : null;
  const first = single ? single.points.find((p) => !p.deal) ?? single.points[0] : null;
  const last = single ? [...single.points].reverse().find((p) => !p.deal) ?? single.points[single.points.length - 1] : null;
  const change = first && last ? last.price / first.price - 1 : 0;
  const deals = series.flatMap((s) => s.points.filter((p) => p.deal));
  const saved = deals.reduce((sum, p) => sum + (p.usual - p.price) * p.qty, 0);

  const nearest = (clientX: number, svg: SVGSVGElement) => {
    const at = clientX - svg.getBoundingClientRect().left;
    let best: { s: Series; p: Point } | null = null;
    for (const s of series) for (const p of s.points) if (!best || Math.abs(x(p.day) - at) < Math.abs(x(best.p.day) - at)) best = { s, p };
    return best;
  };

  return (
    <div className="price-chart" ref={box}>
      {single && first && last ? (
        <p className="price-head">
          <strong>{euro(last.price)}</strong> <span className="muted">usual price now</span>
          {Math.abs(change) >= 0.005 ? (
            <span className="price-change">
              {change > 0 ? "▲" : "▼"} {Math.abs(change * 100).toFixed(0)}% since {fmt(first.day)}
            </span>
          ) : (
            <span className="muted"> · no change since {fmt(first.day)}</span>
          )}
        </p>
      ) : (
        <ul className="price-legend" aria-label="Kinds">
          {series.map((s) => (
            <li key={s.id}>
              <span className={`swatch-line slot-${s.slot}`} aria-hidden="true" />
              {s.name}
              <span className="muted"> {euro(s.points[s.points.length - 1].price)}</span>
            </li>
          ))}
          {hidden > 0 && <li className="muted">+{hidden} more kinds in the list above</li>}
        </ul>
      )}
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={
          single && first && last
            ? `Usual price went from ${euro(first.price)} on ${fmt(first.day)} to ${euro(last.price)}${deals.length ? `, with ${deals.length} deals` : ""}.`
            : `Prices of ${series.length} kinds over time.`
        }
        onMouseMove={(e) => setHover(nearest(e.clientX, e.currentTarget))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => setHover(nearest(e.clientX, e.currentTarget))}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={LEFT} x2={W - RIGHT} y1={y(v)} y2={y(v)} />
            <text className="axis" x={LEFT - 6} y={y(v) + 4} textAnchor="end">
              {euro(v)}
            </text>
          </g>
        ))}
        <text className="axis" x={LEFT} y={H - 6}>
          {fmt(days[0])}
        </text>
        <text className="axis" x={W - RIGHT} y={H - 6} textAnchor="end">
          {fmt(days[days.length - 1])}
        </text>
        {series.map((s) => (
          <g key={s.id} className={`series slot-${s.slot}`}>
            <path className="price-line" d={steps(s)} />
            {s.points
              .filter((p) => p.deal)
              .map((p) => (
                <circle key={p.day} className="deal-dot" cx={x(p.day)} cy={y(p.price)} r={4.5} />
              ))}
            {(() => {
              const end = [...s.points].reverse().find((p) => !p.deal);
              return end ? <circle className="price-dot" cx={x(end.day)} cy={y(end.price)} r={4} /> : null;
            })()}
          </g>
        ))}
        {hover && (
          <g className={`slot-${hover.s.slot}`}>
            <line className="crosshair" x1={x(hover.p.day)} x2={x(hover.p.day)} y1={TOP} y2={H - BOTTOM} />
            <circle className={hover.p.deal ? "deal-dot on" : "price-dot on"} cx={x(hover.p.day)} cy={y(hover.p.price)} r={6} />
          </g>
        )}
        <rect x={LEFT} y={0} width={W - LEFT - RIGHT} height={H} fill="transparent" />
      </svg>
      <p className="muted chart-status" role="status">
        {hover
          ? `${fmt(hover.p.day)}${series.length > 1 ? ` · ${hover.s.name}` : ""}: ${euro(hover.p.price)}${hover.p.deal ? ` (a deal; usually ${euro(hover.p.usual)})` : ""}`
          : deals.length
            ? `Line: the usual price. ○ ${deals.length} ${deals.length === 1 ? "deal" : "deals"}, saving about ${euro(saved)}. Hover or tap for a day.`
            : "Hover or tap for a day."}
      </p>
    </div>
  );
}
