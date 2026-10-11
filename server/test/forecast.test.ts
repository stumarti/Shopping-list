import { describe, expect, it } from "vitest";
import { buyingDays, DAY, forecast, seasonalIndex, type PurchaseEvent } from "../src/forecast.js";

const NOW = Date.UTC(2026, 9, 11, 12); // Sun 11 Oct 2026
const ev = (key: string, daysAgo: number, qty = 1, sectionId = "dairy"): PurchaseEvent => ({
  key,
  name: key.charAt(0).toUpperCase() + key.slice(1),
  brand: null,
  size: null,
  sectionId,
  qty,
  at: NOW - daysAgo * DAY,
});
const every = (key: string, gap: number, times: number, lastDaysAgo: number, qty = 1) =>
  Array.from({ length: times }, (_, i) => ev(key, lastDaysAgo + i * gap, qty));

describe("buyingDays", () => {
  it("counts purchases on the same day once and adds their quantities", () => {
    expect(buyingDays([ev("milk", 7), ev("milk", 7, 2), ev("milk", 0)])).toEqual([
      { at: NOW - 7 * DAY, qty: 3 },
      { at: NOW, qty: 1 },
    ]);
  });
});

describe("forecast", () => {
  it("predicts weekly items that are due, with the usual quantity and a reason", () => {
    const [milk] = forecast(every("milk", 7, 8, 6, 2), NOW);
    expect(milk).toMatchObject({ key: "milk", qty: 2, dueInDays: 1, usualEveryDays: 7, lastBoughtDaysAgo: 6, confidence: "high" });
    expect(milk.reason).toBe("About every week · last bought 6 days ago");
  });

  it("leaves out things that aren't due within the horizon", () => {
    expect(forecast(every("coffee", 30, 5, 5), NOW)).toEqual([]);
    expect(forecast(every("coffee", 30, 5, 5), NOW, { horizonDays: 30 })).toHaveLength(1);
  });

  it("leaves out things you seem to have stopped buying, and one-off pairs", () => {
    expect(forecast(every("formula", 7, 10, 90), NOW)).toEqual([]);
    expect(forecast([ev("paint", 200), ev("paint", 10)], NOW)).toEqual([]);
  });

  it("skips items already on the list or snoozed", () => {
    expect(forecast(every("milk", 7, 6, 6), NOW, { skip: new Set(["milk"]) })).toEqual([]);
  });

  it("marks irregular habits as less certain", () => {
    const irregular = [ev("cheese", 2), ev("cheese", 5), ev("cheese", 20), ev("cheese", 23), ev("cheese", 40)];
    expect(forecast(irregular, NOW, { horizonDays: 30 })[0].confidence).not.toBe("high");
  });

  it("ranks surer and more overdue items first", () => {
    const out = forecast([...every("milk", 7, 8, 7), ...every("bread", 4, 8, 5)], NOW);
    expect(out.map((p) => p.key)).toEqual(["bread", "milk"]);
  });
});

describe("seasons", () => {
  // Two years of history: strawberries bought weekly in June and July only; milk all year round.
  const history: PurchaseEvent[] = [];
  for (let d = 0; d < 730; d += 7) {
    const at = NOW - d * DAY;
    history.push({ ...ev("milk", d) });
    const m = new Date(at).getUTCMonth();
    if (m === 5 || m === 6) history.push({ ...ev("strawberries", d, 1, "produce") });
    if (m === 11 && new Date(at).getUTCDate() > 10) history.push({ ...ev("brussels sprouts", d, 1, "produce") });
  }

  it("works out which months something is bought in", () => {
    const days = buyingDays(history.filter((e) => e.key === "strawberries"));
    const index = seasonalIndex(days, NOW - 730 * DAY, NOW)!;
    expect(index[5]).toBeGreaterThan(3);
    expect(index[0]).toBe(0);
  });

  it("doesn't suggest out-of-season items in October, even though they're 'overdue'", () => {
    const keys = forecast(history, NOW).map((p) => p.key);
    expect(keys).toContain("milk");
    expect(keys).not.toContain("strawberries");
    expect(keys).not.toContain("brussels sprouts");
  });

  it("suggests seasonal items when their season comes round", () => {
    const december = Date.UTC(2026, 11, 14, 12);
    const out = forecast(history, december, { firstSeen: NOW - 730 * DAY });
    const sprouts = out.find((p) => p.key === "brussels sprouts")!;
    expect(sprouts.reason).toBe("You usually buy this in December");
    expect(sprouts.seasonal?.peakMonths).toEqual([11]);
    expect(out.find((p) => p.key === "strawberries")).toBeUndefined();
  });
});
