import { useLayoutEffect, useRef, useState } from "react";

type Week = { week: string; qty: number; trips: number; kinds?: string[]; shopped?: boolean };
type Cell = Week & { future: boolean };

const ROWS = 4; // weeks per column: a steady 4, so a weekly or fortnightly habit lines up across the grid
const CELL = 20;
const GAP = 4;
const TOP = 30; // room for the years and month names

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
 * dashed outline, and a week with no shopping at all is left hollow, so it isn't read as "didn't buy it". It
 * opens on the latest weeks; scroll left for older ones.
 */
export default function WeeklyChart({ weeks, expected }: { weeks: Week[]; expected: string | null }) {
  const [hover, setHover] = useState<Cell | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [weeks]);
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
  // Above them, the year: over the first column, and wherever a new year starts.
  const labels: { x: number; text: string }[] = [];
  const yearLabels: { x: number; text: string }[] = [];
  let lastMonth = -1;
  let lastYear = "";
  for (let col = 0; col < columns; col++) {
    const top = cells[col * ROWS];
    if (monthIndex(top.week) !== lastMonth) {
      labels.push({ x: col * (CELL + GAP), text: fmt(top.week, { month: "short" }).slice(0, 3) });
      lastMonth = monthIndex(top.week);
    }
    const year = top.week.slice(0, 4);
    if (year !== lastYear) {
      yearLabels.push({ x: col * (CELL + GAP), text: year });
      lastYear = year;
    }
  }

  const boughtWeeks = weeks.filter((w) => w.qty > 0).length;
  const noShopping = weeks.some((w) => w.shopped === false);
  const years = (weeks.length / 52).toFixed(1).replace(/\.0$/, "");

  return (
    <div className="weekly">
      <div className="weekly-scroll" ref={scroller} tabIndex={0} aria-label="Weekly history; scroll for older weeks">
        <svg width={width} height={height} role="img" aria-label={`Bought in ${boughtWeeks} of the last ${weeks.length} weeks.`}>
          {yearLabels.map((l) => (
            <text key={`y${l.x}`} x={l.x} y={11} className="axis year">
              {l.text}
            </text>
          ))}
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
                className={`cell${shade}${c.qty > 0 ? " bought" : ""}${c.shopped === false ? " noshop" : ""}${c.future ? " future" : ""}${isExpected ? " expected" : ""}${hover?.week === c.week ? " on" : ""}`}
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
            {noShopping && (
              <span className="key-item">
                <span className="swatch noshop" aria-hidden="true" /> no shopping that week
              </span>
            )}
            {expectedWeek && (
              <span className="key-item">
                <span className="swatch expected" aria-hidden="true" /> expected next
              </span>
            )}
            {weeks.length > 30 && <span className="key-item">{years} years · scroll back for older weeks</span>}
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
    : c.shopped === false
      ? "no shopping that week"
      : c.qty === 0
      ? "none bought"
      : `${c.qty} bought${c.trips > 1 ? ` on ${c.trips} trips` : ""}${c.kinds?.length ? ` (${c.kinds.join(", ")})` : ""}`;
  return `${when}: ${what}${isExpected ? " (expected next)" : ""}`;
}
