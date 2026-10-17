import { useState } from "react";

type Week = { week: string; qty: number; trips: number; kinds?: string[] };
type Cell = Week & { future: boolean };

const ROWS = 4; // weeks per column: a steady 4, so a weekly or fortnightly habit lines up across the grid
const CELL = 20;
const GAP = 4;
const TOP = 16; // room for the month names

const day = (iso: string) => new Date(iso + "T12:00:00");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (s: string, opts: Intl.DateTimeFormatOptions) => day(s).toLocaleDateString("en-IE", opts);
const mondayOf = (s: string) => {
  const d = day(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
};
// A week belongs to the month its Monday is in; alternate months are shaded.
const monthIndex = (week: string) => Number(week.slice(0, 4)) * 12 + Number(week.slice(5, 7));

/**
 * A square for every week, oldest first, four to a column, filled when the item was bought that week. Alternate
 * months are shaded, with the month's name above the column it starts in. The week it's expected next has a
 * dashed outline.
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

  const columns = Math.ceil(cells.length / ROWS);
  const width = columns * (CELL + GAP);
  const height = TOP + ROWS * (CELL + GAP);
  const at = (i: number) => ({ x: Math.floor(i / ROWS) * (CELL + GAP), y: TOP + (i % ROWS) * (CELL + GAP) });

  // Each column is named after the month of its top square, unless that's the same as the column before.
  const labels: { x: number; text: string }[] = [];
  let lastMonth = -1;
  for (let col = 0; col < columns; col++) {
    const top = cells[col * ROWS];
    if (monthIndex(top.week) !== lastMonth) {
      labels.push({ x: col * (CELL + GAP), text: fmt(top.week, { month: "short" }).slice(0, 3) });
      lastMonth = monthIndex(top.week);
    }
  }

  const boughtWeeks = weeks.filter((w) => w.qty > 0).length;

  return (
    <div className="weekly">
      <div className="weekly-scroll">
        <svg width={width} height={height} role="img" aria-label={`Bought in ${boughtWeeks} of the last ${weeks.length} weeks.`}>
          {labels.map((l) => (
            <text key={l.x} x={l.x} y={TOP - 5} className="axis">
              {l.text}
            </text>
          ))}
          {cells.map((c, i) => {
            const { x, y } = at(i);
            const isExpected = c.week === expectedWeek;
            const shade = monthIndex(c.week) % 2 === 0 ? " shade" : "";
            return (
              <rect
                key={c.week}
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={4}
                className={`cell${shade}${c.qty > 0 ? " bought" : ""}${c.future ? " future" : ""}${isExpected ? " expected" : ""}${hover?.week === c.week ? " on" : ""}`}
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setHover(hover?.week === c.week ? null : c)}
              >
                <title>{describe(c, isExpected)}</title>
              </rect>
            );
          })}
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
              <span className="swatch" aria-hidden="true" />
              <span className="swatch shade" aria-hidden="true" /> not bought (shading marks the months)
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
  const what = c.future
    ? "still to come"
    : c.qty === 0
      ? "none bought"
      : `${c.qty} bought${c.trips > 1 ? ` on ${c.trips} trips` : ""}${c.kinds?.length ? ` (${c.kinds.join(", ")})` : ""}`;
  return `${when}: ${what}${isExpected ? " (expected next)" : ""}`;
}
