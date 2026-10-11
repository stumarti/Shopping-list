// Works out what you're likely to need soon from what you've bought before (ticked items and receipts).
//
// For each product:
//   - purchases on the same day count once, so a big shop doesn't look like five separate buys
//   - the usual gap is the median gap between buying days (robust to the odd skipped week)
//   - with a year or more of history, a seasonal index compares how often you buy it in each
//     calendar month with your average month: >1.8 is "you usually buy this now", <0.3 is "out of season"
//   - things you seem to have stopped buying (long overdue) are left out

export const DAY = 24 * 60 * 60 * 1000;

export interface PurchaseEvent {
  key: string;
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
  qty: number;
  at: number;
}

export interface Prediction {
  key: string;
  name: string;
  brand: string | null;
  size: string | null;
  sectionId: string;
  qty: number;
  dueInDays: number;
  lastBoughtDaysAgo: number;
  usualEveryDays: number | null;
  timesBought: number;
  seasonal: { peakMonths: number[]; indexNow: number } | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Merge purchases within a day of each other into one buying day (quantities added). */
export function buyingDays(events: PurchaseEvent[]): Array<{ at: number; qty: number }> {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const days: Array<{ at: number; qty: number }> = [];
  for (const e of sorted) {
    const last = days[days.length - 1];
    if (last && e.at - last.at < DAY) last.qty += e.qty;
    else days.push({ at: e.at, qty: e.qty });
  }
  return days;
}

/**
 * How much more (or less) often you buy something in each calendar month than in an average month,
 * allowing for how many times each month appears in your history. null until there's ~a year of history.
 */
export function seasonalIndex(days: Array<{ at: number }>, firstSeen: number, now: number): number[] | null {
  if (now - firstSeen < 300 * DAY || days.length < 4) return null;
  const counts = Array(12).fill(0);
  for (const d of days) counts[new Date(d.at).getUTCMonth()]++;
  // How many times each calendar month was "observed" in the history window.
  const exposure = Array(12).fill(0);
  const cursor = new Date(Date.UTC(new Date(firstSeen).getUTCFullYear(), new Date(firstSeen).getUTCMonth(), 1));
  while (cursor.getTime() <= now) {
    exposure[cursor.getUTCMonth()]++;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const totalExposure = exposure.reduce((a, b) => a + b, 0);
  const overall = days.length / totalExposure;
  return counts.map((c, m) => (exposure[m] ? c / exposure[m] / overall : 1));
}

function confidenceOf(n: number, intervals: number[]): Prediction["confidence"] {
  if (intervals.length < 2) return "low";
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const sd = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
  const cv = sd / mean;
  if (n >= 5 && cv < 0.5) return "high";
  if (n >= 3 && cv < 1) return "medium";
  return "low";
}

const roundDays = (ms: number) => Math.round(ms / DAY);

export function forecast(
  events: PurchaseEvent[],
  now: number,
  opts: { horizonDays?: number; skip?: Set<string>; firstSeen?: number } = {},
): Prediction[] {
  const horizon = opts.horizonDays ?? 7;
  const byKey = new Map<string, PurchaseEvent[]>();
  for (const e of events) {
    if (e.at > now) continue;
    byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  }
  // Seasonality needs the length of the household's whole history, not just this product's.
  const firstSeen = opts.firstSeen ?? Math.min(...events.map((e) => e.at));
  const month = new Date(now + 3 * DAY).getUTCMonth();

  const out: Prediction[] = [];
  for (const [key, list] of byKey) {
    if (opts.skip?.has(key)) continue;
    const days = buyingDays(list);
    if (days.length < 2) continue;
    const latest = list.reduce((a, b) => (b.at > a.at ? b : a));
    const last = days[days.length - 1].at;
    const intervals = days.slice(1).map((d, i) => d.at - days[i].at);
    const usual = median(intervals);
    const qty = Math.max(1, Math.round(median(days.map((d) => d.qty))));
    const index = seasonalIndex(days, firstSeen, now);
    const peakMonths = index ? index.flatMap((v, m) => (v >= 1.8 ? [m] : [])) : [];
    const indexNow = index ? index[month] : 1;
    const isSeasonal = peakMonths.length > 0 && peakMonths.length <= 6;
    const sinceLast = now - last;

    const base = {
      key,
      name: latest.name,
      brand: latest.brand,
      size: latest.size,
      sectionId: latest.sectionId,
      qty,
      lastBoughtDaysAgo: roundDays(sinceLast),
      usualEveryDays: roundDays(usual),
      timesBought: days.length,
      seasonal: isSeasonal ? { peakMonths, indexNow: Math.round(indexNow * 10) / 10 } : null,
    };

    if (isSeasonal && indexNow >= 1.8) {
      // In season: buy again if you haven't since your usual in-season gap (or a month).
      const inSeason = intervals.filter((_, i) => peakMonths.includes(new Date(days[i + 1].at).getUTCMonth()));
      const gap = inSeason.length ? Math.min(median(inSeason), 45 * DAY) : 30 * DAY;
      const dueIn = (last + gap - now) / DAY;
      if (dueIn <= horizon) {
        out.push({
          ...base,
          dueInDays: Math.round(dueIn),
          usualEveryDays: inSeason.length ? roundDays(gap) : null,
          confidence: days.length >= 4 ? "medium" : "low",
          reason: `You usually buy this in ${MONTHS[month]}`,
        });
      }
      continue;
    }

    // Out of season, or you seem to have stopped buying it.
    if (isSeasonal && indexNow < 0.3) continue;
    if (sinceLast > Math.max(3 * usual, usual + 21 * DAY)) continue;
    // Two buys far apart isn't a habit.
    if (days.length === 2 && usual > 60 * DAY) continue;

    const dueIn = (last + usual - now) / DAY;
    if (dueIn > horizon) continue;
    const every = roundDays(usual);
    out.push({
      ...base,
      dueInDays: Math.round(dueIn),
      confidence: confidenceOf(days.length, intervals),
      reason:
        dueIn < -1
          ? `Usually every ${every} days, last bought ${base.lastBoughtDaysAgo} days ago`
          : `About every ${every === 7 ? "week" : every === 14 ? "two weeks" : `${every} days`} · last bought ${base.lastBoughtDaysAgo === 0 ? "today" : `${base.lastBoughtDaysAgo} days ago`}`,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.dueInDays - b.dueInDays || a.name.localeCompare(b.name));
}
