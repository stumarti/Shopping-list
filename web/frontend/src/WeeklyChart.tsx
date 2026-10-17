import { useState } from "react";

type Week = { week: string; qty: number; trips: number };
type Cell = Week & { future: boolean };

const CELL = 22;
const GAP = 5; // with the cell, wide enough for a month name
const LEFT = 18; // room for the week numbers
const TOP = 16; // room for the month names

const day = (iso: string) => new Date(iso + "T12:00:00");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (s: string, opts: Intl.DateTimeFormatOptions) => day(s).toLocaleDateString("en-IE", opts);
const mondayOf = (s: string) => {
  const d = day(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
};

/**
 * A square for every week, in a column per month (a week belongs to the month its Monday is in), filled when
 * the item was bought that week. The week it's expected next has a dashed outline.
 */
export default function WeeklyChart({ weeks, expected }: { weeks: Week[]; expected: string | null }) {
  const [hover, setHover] = useState<Cell | null>(null);
  if (!weeks.length) return null;

  // Carry on to the expected week if it's still to come.
  const cells: Cell[] = weeks.map((w) => ({ ...w, future: false }));
  const expectedWeek = expected ? mondayOf(expected) : null;
  if (expectedWeek) {
    const d = day(cells[cells.length - 1].week);
    let added = 0;
    while (iso(d) < expectedWeek && added < 26) {
      d.setDate(d.getDate() + 7);
      cells.push({ week: iso(d), qty: 0, trips: 0, future: true });
      added++;
    }
  }

  // Columns by month.
  const months: { key: string; cells: Cell[] }[] = [];
  for (const c of cells) {
    const key = c.week.slice(0, 7);
    if (months[months.length - 1]?.key !== key) months.push({ key, cells: [] });
    months[months.length - 1].cells.push(c);
  }

  const rows = Math.max(...months.map((m) => m.cells.length));
  const width = LEFT + months.length * (CELL + GAP);
  const height = TOP + rows * (CELL + GAP);
  const boughtWeeks = weeks.filter((w) => w.qty > 0).length;

  return (
    <div className="weekly">
      <div className="weekly-scroll">
        <svg width={width} height={height} role="img" aria-label={`Bought in ${boughtWeeks} of the last ${weeks.length} weeks.`}>
          {Array.from({ length: rows }, (_, r) => (
            <text key={r} x={LEFT - 6} y={TOP + r * (CELL + GAP) + CELL / 2 + 4} className="axis" textAnchor="end">
              {r + 1}
            </text>
          ))}
          {months.map((m, i) => (
            <g key={m.key} transform={`translate(${LEFT + i * (CELL + GAP)},0)`}>
              <text x={0} y={TOP - 5} className="axis">
                {fmt(m.key + "-15", { month: "short" }).slice(0, 3)}
              </text>
              {m.cells.map((c, r) => {
                const isExpected = c.week === expectedWeek;
                return (
                  <rect
                    key={c.week}
                    x={0}
                    y={TOP + r * (CELL + GAP)}
                    width={CELL}
                    height={CELL}
                    rx={4}
                    className={`cell${c.qty > 0 ? " bought" : ""}${c.future ? " future" : ""}${isExpected ? " expected" : ""}${hover?.week === c.week ? " on" : ""}`}
                    onMouseEnter={() => setHover(c)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setHover(hover?.week === c.week ? null : c)}
                  >
                    <title>{describe(c, isExpected)}</title>
                  </rect>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <p className="weekly-key muted" role="status">
        {hover ? (
          describe(hover, hover.week === expectedWeek)
        ) : (
          <>
            <span className="key-item">
              <span className="swatch bought" aria-hidden="true" /> bought
            </span>
            <span className="key-item">
              <span className="swatch" aria-hidden="true" /> not bought
            </span>
            {expectedWeek && (
              <span className="key-item">
                <span className="swatch expected" aria-hidden="true" /> expected next
              </span>
            )}
          </>
        )}
      </p>
    </div>
  );
}

function describe(c: Cell, isExpected: boolean): string {
  const when = `Week of ${fmt(c.week, { day: "numeric", month: "short", year: "numeric" })}`;
  const what = c.future ? "still to come" : c.qty === 0 ? "none bought" : `${c.qty} bought${c.trips > 1 ? ` on ${c.trips} trips` : ""}`;
  return `${when}: ${what}${isExpected ? " (expected next)" : ""}`;
}
