import { DAY_MS, dayOffset, type DayReadings, type Finish, type MonthlyReadings, type PriceHistory } from '@mtg/shared';

// Pure helpers for the compact daily-readings format (see shared/src/user.ts).
// Everything that doesn't need the row's identity takes a bare DayReadings, so
// card printings and sealed products share one implementation.
//
// No db imports — also used by the Dexie v4 upgrade in db/schema.ts and by
// transfer-payload sanitization, both of which must not depend on tracking.ts.

export { dayOffset };

/** Today's day key, in the UTC "YYYY-MM-DD" form readings are stamped with. */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Currency units → integer cents (the storage format). */
export function toCents(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null;
}

/**
 * Append one day's reading (integer cents) to a history, null-padding any gap
 * days. No-op (returns false) if that day is already covered or precedes
 * startDay. Pass `foil` to record the foil lanes too; a lane the row doesn't
 * have yet is created (null-padded back to startDay) on its first non-null
 * reading, and an existing foil lane is padded to match on days without one.
 */
export function recordDay(
  h: DayReadings,
  day: string,
  eur: number | null,
  usd: number | null,
  foil?: { eur: number | null; usd: number | null },
): boolean {
  const idx = dayOffset(h.startDay, day);
  if (idx < 0 || idx < h.eur.length) return false;
  while (h.eur.length < idx) {
    h.eur.push(null);
    h.usd.push(null);
  }
  h.eur.push(eur);
  h.usd.push(usd);
  const put = (lane: 'eurFoil' | 'usdFoil', v: number | null) => {
    if (!h[lane] && v == null) return;
    const arr = h[lane] ?? (h[lane] = []);
    while (arr.length < idx) arr.push(null);
    arr.length = idx; // a foil lane never runs past the nonfoil ones
    arr.push(v);
  };
  put('eurFoil', foil?.eur ?? null);
  put('usdFoil', foil?.usd ?? null);
  return true;
}

/** Days on which the row holds a foil reading, in either currency. */
function foilDays(h: DayReadings): number {
  const len = Math.max(h.eurFoil?.length ?? 0, h.usdFoil?.length ?? 0);
  let n = 0;
  for (let i = 0; i < len; i++) if (h.eurFoil?.[i] != null || h.usdFoil?.[i] != null) n++;
  return n;
}

/** What `readingsFor` hands back: the series to read, and which finish it is. */
interface FinishReadings {
  readings: DayReadings;
  /** True when `readings` is the foil price, false when it's the nonfoil line. */
  foil: boolean;
}

/**
 * The daily series to read for a finish. A foil copy reads the foil lanes once
 * they hold two days of readings, enough to draw a line; until then (and for
 * nonfoil, and for etched, which isn't archived) it reads the nonfoil line,
 * and `foil: false` tells the caller to say so. Without the two-day floor every
 * foil's sparkline would vanish on the first day its foil lane is recorded.
 * Never a mix of the two: a line that switches finish part way along would
 * draw a jump that never happened.
 */
export function readingsFor(h: DayReadings, finish?: Finish | null): FinishReadings {
  if (finish !== 'foil' || foilDays(h) < 2) return { readings: h, foil: false };
  const len = Math.max(h.eurFoil?.length ?? 0, h.usdFoil?.length ?? 0);
  const lane = (a?: (number | null)[]) => Array.from({ length: len }, (_, i) => a?.[i] ?? null);
  const monthly = h.monthly && { startMonth: h.monthly.startMonth, eur: h.monthly.eurFoil, usd: h.monthly.usdFoil };
  return { readings: { startDay: h.startDay, eur: lane(h.eurFoil), usd: lane(h.usdFoil), monthly }, foil: true };
}

/**
 * Merge two histories of the same printing into one day-aligned row. Readings
 * are unioned; where both have one for the same day, `b`'s wins. Callers pass
 * (server, local) so the device's own readings (e.g. today's, not archived
 * yet) survive on top of the server's longer window.
 */
export function mergeHistories(a: PriceHistory, b: PriceHistory): PriceHistory {
  // An unparseable startDay can't be aligned; the other row wins outright.
  if (dayOffset(a.startDay, a.startDay) !== 0) return b;
  if (dayOffset(b.startDay, b.startDay) !== 0) return a;
  // A row with an empty daily window (a printing the server only knows by the
  // month) mustn't drag startDay back to its placeholder.
  const days = [a, b].filter((h) => h.eur.length > 0);
  const startDay = days.length ? days.map((h) => h.startDay).sort()[0]! : b.startDay;
  const offA = dayOffset(startDay, a.startDay);
  const offB = dayOffset(startDay, b.startDay);
  const len = Math.max(0, ...days.map((h) => dayOffset(startDay, h.startDay) + h.eur.length));
  const lane = (key: 'eur' | 'usd' | 'eurFoil' | 'usdFoil') => {
    const out: (number | null)[] = new Array(len).fill(null);
    let any = false;
    // Later wins, so b (the device's own readings) lands on top of a.
    for (const [h, off] of [[a, offA], [b, offB]] as const) {
      const src = h[key];
      if (!src) continue;
      for (let i = 0; i < src.length; i++) {
        if (src[i] == null || off + i < 0 || off + i >= len) continue;
        out[off + i] = src[i]!;
        any = true;
      }
    }
    return { out, any };
  };
  const merged: PriceHistory = { scryfallId: b.scryfallId, startDay, eur: lane('eur').out, usd: lane('usd').out };
  for (const key of ['eurFoil', 'usdFoil'] as const) {
    if (!a[key] && !b[key]) continue;
    const { out, any } = lane(key);
    if (any) merged[key] = out;
  }
  // Only the server sends monthly history, and its copy is the newer one.
  const monthly = a.monthly ?? b.monthly;
  if (monthly) merged.monthly = monthly;
  return merged;
}

/** One deep-history reading: mid-month (UTC ms) and the month's cents. */
interface MonthPoint {
  ts: number;
  cents: number;
}

/**
 * One currency's monthly deep-history points from months entirely before
 * `beforeDay` (the daily series' first reading), oldest first. A month that
 * overlaps the daily window is left to the daily readings, which are finer.
 */
export function monthlyBefore(m: MonthlyReadings | undefined, cur: 'eur' | 'usd', beforeDay: string): MonthPoint[] {
  const cells = m?.[cur];
  if (!m || !/^\d{4}-\d{2}$/.test(m.startMonth) || !Array.isArray(cells)) return [];
  const cutoff = beforeDay.slice(0, 7);
  const [y0, m0] = m.startMonth.split('-').map(Number) as [number, number];
  const out: MonthPoint[] = [];
  for (let i = 0; i < cells.length; i++) {
    const at = new Date(Date.UTC(y0, m0 - 1 + i, 15));
    if (at.toISOString().slice(0, 7) >= cutoff) break;
    const v = cells[i];
    if (v != null) out.push({ ts: at.getTime(), cents: v });
  }
  return out;
}

/**
 * The EUR reading on `day`, or the nearest one up to `lookback` days earlier
 * (prices move slowly; a reading from a few days before is a fine estimate).
 * Null when the history doesn't cover that day.
 */
export function centsAround(h: DayReadings, day: string, lookback = 7): number | null {
  const idx = dayOffset(h.startDay, day);
  if (idx < 0) return null;
  for (let i = Math.min(idx, h.eur.length - 1); i >= 0 && idx - i <= lookback; i--) {
    const v = h.eur[i];
    if (v != null) return v;
  }
  return null;
}

/**
 * The EUR reading nearest `day` in either direction, and how many days away it
 * was. Unlike centsAround this will look *forward*, because it answers a
 * different question: what was this card worth when I got it? A card acquired
 * before its history starts (everything you owned before the event log existed,
 * or before the server archive did) has no earlier reading to find, and the
 * first one recorded is the honest estimate. Ties go to the earlier day.
 */
export function centsNearest(h: DayReadings, day: string): { cents: number; awayDays: number } | null {
  if (Number.isNaN(Date.parse(day))) return null;
  const idx = dayOffset(h.startDay, day);
  let best: { cents: number; awayDays: number } | null = null;
  for (let i = 0; i < h.eur.length; i++) {
    const v = h.eur[i];
    if (v == null) continue;
    const away = Math.abs(i - idx);
    if (!best || away < best.awayDays) best = { cents: v, awayDays: away };
    // Readings are in day order, so once we start moving away we are done.
    else if (i > idx) break;
  }
  return best;
}

/** Day number (whole UTC days since the epoch) of a "YYYY-MM-DD" day key. */
export function dayNum(day: string): number {
  return Math.round(Date.parse(day) / DAY_MS);
}

/** The UTC day key ("YYYY-MM-DD") an epoch-ms timestamp falls on. */
export function dayKeyOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * The timestamp a record that only knows its day gets (a purchase date off a
 * receipt, a date typed into a form): noon UTC, so it reads as that calendar
 * day in every timezone a phone can be in, and dayKeyOf gives the day back.
 */
export function tsOfDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 12);
}

/** The inverse of dayKeyOf, for a date input's value; null for anything but "YYYY-MM-DD". */
export function tsOfDayKey(key: string): number | null {
  const m = key.match(/^(\d{4})-(\d\d)-(\d\d)$/);
  return m ? tsOfDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** Summary of a card's recorded price movement, in currency units. */
export interface HistoryChange {
  cur: 'eur' | 'usd';
  /** Chronological non-null readings of `cur` (sparkline input). */
  series: number[];
  first: number;
  current: number;
  /** current − first. */
  delta: number;
  /** Percent vs the first reading; null when it was 0. */
  pct: number | null;
  points: number;
}

/**
 * Change since tracking began, in the row's display currency (whatever the
 * latest reading has, EUR preferred). Null when nothing was ever recorded.
 */
export function historyChange(h: DayReadings): HistoryChange | null {
  let cur: 'eur' | 'usd' | null = null;
  for (let i = h.eur.length - 1; i >= 0 && !cur; i--) {
    if (h.eur[i] != null) cur = 'eur';
    else if (h.usd[i] != null) cur = 'usd';
  }
  if (!cur) return null;
  const series: number[] = [];
  for (const v of h[cur]) if (v != null) series.push(v / 100);
  const first = series[0]!;
  const current = series[series.length - 1]!;
  const delta = current - first;
  return { cur, series, first, current, delta, pct: first ? (delta / first) * 100 : null, points: series.length };
}

