import { useState } from "react";
import { useWidth } from "./useWidth";

type Purchase = { bought_on: string; unit_price: number | null };
type Point = { day: string; price: number };

const H = 150;
const LEFT = 44;
const RIGHT = 12;
const TOP = 10;
const BOTTOM = 22;

const euro = (n: number) => `€${n.toFixed(2)}`;
const time = (iso: string) => new Date(iso + "T12:00:00").getTime();
const fmt = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });

/** One price a day (the average, if it was bought twice that day), oldest first. */
function points(purchases: Purchase[]): Point[] {
  const days = new Map<string, number[]>();
  for (const p of purchases) if (p.unit_price !== null) days.set(p.bought_on, [...(days.get(p.bought_on) ?? []), p.unit_price]);
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ps]) => ({ day, price: ps.reduce((s, x) => s + x, 0) / ps.length }));
}

/** Tidy steps for the price axis: three gridlines on round cent values. */
function ticks(low: number, high: number): number[] {
  const span = Math.max(high - low, 0.1);
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10].find((s) => span / s <= 3) ?? 10;
  const start = Math.floor(low / step) * step;
  const out = [];
  for (let v = start; v <= high + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/**
 * The price each time you bought it, as a line over time, with the change from first to latest. Hover (or tap)
 * for the price on a day. Needs at least two days with a price.
 */
export default function PriceChart({ purchases }: { purchases: Purchase[] }) {
  const [hover, setHover] = useState<Point | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(640);
  const ps = points(purchases);
  if (ps.length < 2) return null;

  const first = ps[0];
  const last = ps[ps.length - 1];
  const yTicks = ticks(Math.min(...ps.map((p) => p.price)), Math.max(...ps.map((p) => p.price)));
  const yLow = yTicks[0];
  const yHigh = yTicks[yTicks.length - 1];
  const t0 = time(first.day);
  const t1 = time(last.day);
  const x = (day: string) => LEFT + ((time(day) - t0) / (t1 - t0 || 1)) * (W - LEFT - RIGHT);
  const y = (price: number) => TOP + (1 - (price - yLow) / (yHigh - yLow || 1)) * (H - TOP - BOTTOM);
  const line = ps.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.price).toFixed(1)}`).join("");
  const change = last.price / first.price - 1;

  const nearest = (clientX: number, svg: SVGSVGElement) => {
    const at = clientX - svg.getBoundingClientRect().left;
    return ps.reduce((best, p) => (Math.abs(x(p.day) - at) < Math.abs(x(best.day) - at) ? p : best), ps[0]);
  };

  return (
    <div className="price-chart" ref={box}>
      <p className="price-head">
        <strong>{euro(last.price)}</strong> <span className="muted">each now</span>
        {Math.abs(change) >= 0.005 ? (
          <span className="price-change">
            {change > 0 ? "▲" : "▼"} {Math.abs(change * 100).toFixed(0)}% since {fmt(first.day)}
          </span>
        ) : (
          <span className="muted"> · no change since {fmt(first.day)}</span>
        )}
      </p>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Price went from ${euro(first.price)} on ${fmt(first.day)} to ${euro(last.price)} on ${fmt(last.day)}.`}
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
          {fmt(first.day)}
        </text>
        <text className="axis" x={W - RIGHT} y={H - 6} textAnchor="end">
          {fmt(last.day)}
        </text>
        <path className="price-line" d={line} />
        <circle className="price-dot" cx={x(last.day)} cy={y(last.price)} r={4} />
        {hover && (
          <g>
            <line className="crosshair" x1={x(hover.day)} x2={x(hover.day)} y1={TOP} y2={H - BOTTOM} />
            <circle className="price-dot on" cx={x(hover.day)} cy={y(hover.price)} r={5} />
          </g>
        )}
        <rect x={LEFT} y={0} width={W - LEFT - RIGHT} height={H} fill="transparent" />
      </svg>
      <p className="muted chart-status" role="status">
        {hover ? `${fmt(hover.day)}: ${euro(hover.price)} each` : `Lowest ${euro(Math.min(...ps.map((p) => p.price)))}, highest ${euro(Math.max(...ps.map((p) => p.price)))}. Hover or tap for a day.`}
      </p>
    </div>
  );
}
