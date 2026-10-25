import { useState } from "react";
import type { PriceMove } from "./api";
import { useWidth } from "./useWidth";

const euro = (n: number) => `€${n.toFixed(2)}`;
const signedEuro = (n: number) => `${n >= 0 ? "+" : "−"}€${Math.abs(n).toFixed(2)}`;
const pct = (n: number) => `${Math.abs(n * 100).toFixed(0)}%`;
const monthName = (m: string, year = false) =>
  new Date(m + "-15T12:00:00").toLocaleDateString("en-IE", year ? { month: "short", year: "numeric" } : { month: "short" });

type IndexPoint = { month: string; index: number; products: number };

const H = 150;
const LEFT = 40;
const RIGHT = 54;
const TOP = 12;
const BOTTOM = 22;

/**
 * Your own grocery price index, month by month: 100 is what things cost when you first bought them. One line,
 * with 100 drawn as the line to beat and the latest value labelled at its end.
 */
export function PriceIndex({ index }: { index: IndexPoint[] }) {
  const [hover, setHover] = useState<IndexPoint | null>(null);
  const [box, W] = useWidth<HTMLDivElement>(640);
  if (index.length < 2) return null;

  const values = index.map((p) => p.index);
  const pad = Math.max(2, (Math.max(...values, 100) - Math.min(...values, 100)) * 0.15);
  const low = Math.floor(Math.min(...values, 100) - pad);
  const high = Math.ceil(Math.max(...values, 100) + pad);
  const step = (W - LEFT - RIGHT) / (index.length - 1);
  const x = (i: number) => LEFT + i * step;
  const y = (v: number) => TOP + (1 - (v - low) / (high - low)) * (H - TOP - BOTTOM);
  const line = index.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.index).toFixed(1)}`).join("");
  const last = index[index.length - 1];
  const every = Math.max(1, Math.ceil(index.length / Math.max(2, Math.floor((W - LEFT - RIGHT) / 46))));

  const pick = (clientX: number, svg: SVGSVGElement) => {
    const at = clientX - svg.getBoundingClientRect().left;
    const i = Math.max(0, Math.min(index.length - 1, Math.round((at - LEFT) / step)));
    setHover(index[i]);
  };

  return (
    <div className="price-index" ref={box}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Your price index went from ${index[0].index} in ${monthName(index[0].month, true)} to ${last.index} in ${monthName(last.month, true)}; 100 is what things cost when you first bought them.`}
        onMouseMove={(e) => pick(e.clientX, e.currentTarget)}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => pick(e.clientX, e.currentTarget)}
      >
        {[low, high].map((v) => (
          <g key={v}>
            <line className="grid" x1={LEFT} x2={W - RIGHT} y1={y(v)} y2={y(v)} />
            <text className="axis" x={LEFT - 6} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <line className="baseline-100" x1={LEFT} x2={W - RIGHT} y1={y(100)} y2={y(100)} />
        <text className="axis" x={LEFT - 6} y={y(100) + 4} textAnchor="end">
          100
        </text>
        <path className="index-line" d={line} />
        <circle className="index-dot" cx={x(index.length - 1)} cy={y(last.index)} r={4} />
        <text className="index-label" x={x(index.length - 1) + 8} y={y(last.index) + 4}>
          {last.index.toFixed(1)}
        </text>
        {index.map((p, i) =>
          i % every === 0 || i === index.length - 1 ? (
            <text key={p.month} className="axis" x={x(i)} y={H - 6} textAnchor="middle">
              {monthName(p.month, i === 0 || p.month.endsWith("-01"))}
            </text>
          ) : null,
        )}
        {hover && (
          <g>
            <line className="crosshair" x1={x(index.indexOf(hover))} x2={x(index.indexOf(hover))} y1={TOP} y2={H - BOTTOM} />
            <circle className="index-dot on" cx={x(index.indexOf(hover))} cy={y(hover.index)} r={5} />
          </g>
        )}
        <rect x={LEFT} y={0} width={W - LEFT - RIGHT} height={H} fill="transparent" />
      </svg>
      <p className="muted chart-status" role="status">
        {hover
          ? `${monthName(hover.month, true)}: ${hover.index.toFixed(1)} (${hover.index >= 100 ? "+" : "−"}${Math.abs(hover.index - 100).toFixed(1)}% on when you first bought them), from ${hover.products} things`
          : "Shelf prices (deals left out) against what things cost when you first bought them: 100, the dashed line. Hover or tap a month."}
      </p>
    </div>
  );
}

/**
 * What's driving it: each price change as a bar left (cheaper) or right (dearer) of zero, sized by what it adds
 * to a month's shopping at the rate you buy it, biggest first. Tap one to open it.
 */
export function PriceImpact({ moves, onPick }: { moves: PriceMove[]; onPick?: (catalogId: number) => void }) {
  if (!moves.length) return null;
  const most = Math.max(...moves.map((m) => Math.abs(m.impact)), 0.01);
  return (
    <ul className="impact" aria-label="Price changes, by what they add to a month's shopping">
      {moves.map((m) => {
        const up = m.change > 0;
        const width = `${(Math.abs(m.impact) / most) * 100}%`;
        return (
          <li key={m.catalog_id}>
            <button className="impact-row" onClick={() => onPick?.(m.catalog_id)} disabled={!onPick} title={onPick ? `Open ${m.name}` : undefined}>
              <span className="impact-name">{m.name}</span>
              <span className="impact-bars" aria-hidden="true">
                <span className="impact-half left">{!up && <span className="impact-bar down" style={{ width }} />}</span>
                <span className="impact-zero" />
                <span className="impact-half right">{up && <span className="impact-bar up" style={{ width }} />}</span>
              </span>
              <span className="impact-value">
                <strong>{signedEuro(m.impact)}</strong>
                <span className="muted">/mo</span>
              </span>
              <span className="impact-detail muted">
                {euro(m.before)} → {euro(m.after)} {up ? "▲" : "▼"} {pct(m.change)} · about {m.per_month} a month
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
