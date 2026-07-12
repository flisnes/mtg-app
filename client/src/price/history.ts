import type { PriceHistory } from '@mtg/shared';

// Pure helpers for the compact PriceHistory format (see shared/src/user.ts).
// No db imports — also used by the Dexie v4 upgrade in db/schema.ts and by
// transfer-payload sanitization, both of which must not depend on tracking.ts.

const DAY_MS = 86_400_000;

/** Currency units → integer cents (the storage format). */
export function toCents(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null;
}

/** Whole days from `startDay` to `day` (both YYYY-MM-DD, parsed as UTC). -1 if unparseable. */
export function dayOffset(startDay: string, day: string): number {
  const d = (Date.parse(day) - Date.parse(startDay)) / DAY_MS;
  return Number.isFinite(d) ? Math.round(d) : -1;
}

/**
 * Append one day's reading (integer cents) to a history, null-padding any gap
 * days. No-op (returns false) if that day is already covered or precedes
 * startDay.
 */
export function recordDay(h: PriceHistory, day: string, eur: number | null, usd: number | null): boolean {
  const idx = dayOffset(h.startDay, day);
  if (idx < 0 || idx < h.eur.length) return false;
  while (h.eur.length < idx) {
    h.eur.push(null);
    h.usd.push(null);
  }
  h.eur.push(eur);
  h.usd.push(usd);
  return true;
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
 * Change since tracking began, in the card's display currency (whatever the
 * latest reading has, EUR preferred). Null when nothing was ever recorded.
 */
export function historyChange(h: PriceHistory): HistoryChange | null {
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

