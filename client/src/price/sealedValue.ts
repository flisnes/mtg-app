import { useLiveQuery } from 'dexie-react-hooks';
import { DAY_MS, type SealedItem, type SealedPriceHistory } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrefs } from '../prefs.js';
import { canConvert, convertToDisplay } from './rates.js';

// What the sealed shelf has been worth, day by day — the series behind the
// sealed value chart. Built from the daily readings price/sealedTracking.ts
// records for every product you own.
//
// A box counts from the day it landed on the shelf (`SealedItem.createdAt`)
// onward, so the line steps up when you buy rather than pretending you always
// owned it. Quantity changes aren't logged — a sealed row has no event history —
// so today's count applies for every day since; the last point therefore always
// equals the header total, which is the number that has to agree.
//
// Everything lands in one display-currency unit, by the same rule as the card
// series: the base currency's reading wins, the other one fills in, and a
// missing FX rate falls back to the raw quote.

/** One day of the shelf's worth. */
export interface SealedValuePoint {
  /** Whole UTC days since the epoch. */
  day: number;
  ts: number;
  /** Market value of the products held that day, in display units. */
  total: number;
}

export interface SealedValueSeries {
  pts: SealedValuePoint[];
  /** Currency code every value above is quoted in. */
  unit: string;
  /** Products that landed on the shelf, keyed by the day they landed on. */
  addsByDay: Map<number, SealedItem[]>;
  /** Copies on the shelf with no recorded reading at all. */
  unpriced: number;
}

type Cur = 'eur' | 'usd';

/** A history reduced to the one currency series the chart reads it in. */
interface Reader {
  cur: Cur;
  readings: readonly (number | null)[];
  /** Day number of readings[0]. */
  startDay: number;
}

/** Day number (whole UTC days since the epoch) of a "YYYY-MM-DD" day key. */
function dayNum(day: string): number {
  return Math.round(Date.parse(day) / DAY_MS);
}

/**
 * Build the daily series. Pure — the hook below feeds it. Returns null when
 * there aren't at least two days of readings to draw a line between.
 */
export function buildSealedValueSeries(
  items: readonly SealedItem[],
  histories: readonly SealedPriceHistory[],
): SealedValueSeries | null {
  const base: Cur = getPrefs().baseCurrency === 'USD' ? 'usd' : 'eur';
  const readers = new Map<string, Reader>();
  let first = Infinity;
  let last = -Infinity;
  for (const h of histories) {
    const startDay = dayNum(h.startDay);
    if (!Number.isFinite(startDay)) continue;
    const other: Cur = base === 'eur' ? 'usd' : 'eur';
    // The two markets genuinely disagree on sealed, so a product quoted only by
    // the one that isn't your base currency still belongs on the chart.
    const cur: Cur = h[base].some((v) => v != null) ? base : other;
    if (!h[cur].some((v) => v != null)) continue;
    readers.set(h.productId, { cur, readings: h[cur], startDay });
    if (startDay < first) first = startDay;
    const end = startDay + h[cur].length - 1;
    if (end > last) last = end;
  }
  const N = last - first + 1;
  if (!readers.size || !(N >= 2)) return null;

  // One rate per currency for the whole chart; without both, the raw quotes are
  // summed in the base currency instead (same fallback priceValue makes).
  const converted = canConvert();
  const unit = converted ? getPrefs().displayCurrency : getPrefs().baseCurrency;
  const scale: Record<Cur, number> = {
    eur: (converted ? convertToDisplay(1, 'EUR') : null) ?? 1,
    usd: (converted ? convertToDisplay(1, 'USD') : null) ?? 1,
  };

  const totals = new Float64Array(N);
  const addsByDay = new Map<number, SealedItem[]>();
  let unpriced = 0;

  for (const item of items) {
    const reader = readers.get(item.productId);
    if (!reader) {
      // Never quoted, or added after the last reading: nothing to draw it with.
      unpriced += item.quantity;
      continue;
    }
    const added = Math.floor(item.createdAt / DAY_MS);
    // Bought before tracking began: it was already on the shelf on day one, and
    // there's no step to mark.
    if (added >= first) {
      const on = Math.min(added, last);
      const list = addsByDay.get(on);
      if (list) list.push(item);
      else addsByDay.set(on, [item]);
    }
    const from = Math.max(0, Math.min(added, last) - first);

    let price = NaN;
    for (let d = 0; d < N; d++) {
      const idx = first + d - reader.startDay;
      if (idx >= 0 && idx < reader.readings.length) {
        const c = reader.readings[idx];
        // Gaps hold the last reading: a day the app wasn't opened is not a day
        // the box was worth nothing.
        if (c != null) price = (c / 100) * scale[reader.cur];
      }
      if (d >= from && Number.isFinite(price)) totals[d]! += item.quantity * price;
    }
  }

  const pts: SealedValuePoint[] = [];
  for (let d = 0; d < N; d++) {
    const day = first + d;
    pts.push({ day, ts: day * DAY_MS, total: totals[d]! });
  }
  return { pts, unit, addsByDay, unpriced };
}

/** The live daily value series for the sealed shelf. Null = not enough data. */
export function useSealedValueSeries(): SealedValueSeries | null | undefined {
  return useLiveQuery(async () => {
    const [items, histories] = await Promise.all([db.sealedItems.toArray(), db.sealedPriceHistories.toArray()]);
    if (!items.length) return null;
    return buildSealedValueSeries(items, histories);
  }, []);
}

/** Every recorded sealed history, by product id — the shelf's trend marks and change sorts. */
export function useSealedHistories(): Map<string, SealedPriceHistory> | undefined {
  return useLiveQuery(async () => new Map((await db.sealedPriceHistories.toArray()).map((h) => [h.productId, h])), []);
}
