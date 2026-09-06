import { useLiveQuery } from 'dexie-react-hooks';
import { DAY_MS, type Finish, type PriceHistory, type UserEvent, type UserEventKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPricesByIds, priceForFinish, type CardPrice } from '../cardDb/prices.js';
import { getPrefs } from '../prefs.js';
import { canConvert, convertToDisplay } from './rates.js';

// What the whole collection has been worth, day by day — the series behind the
// collection value chart. Built from two records that already exist:
//
//  - priceHistories: one daily price row per printing (price/tracking.ts).
//  - events: every collection.add / collection.remove, with the quantity and
//    (usually) what the copy cost at the time.
//
// A card is only worth something on the days you actually held it, so holdings
// are replayed forward through the event log. The starting stock is whatever
// today's collection needs it to be once the in-window events are undone, which
// keeps the last point of the chart equal to the header total rather than
// letting a gap in the log drift the two apart.
//
// Everything lands in one display-currency unit, by the same rule the value
// totals use (priceValue in CardSorting): the base currency's reading wins, the
// other one fills in, and a missing FX rate falls back to the raw quote.
//
// The same replay draws a deck, binder or box: swap the event kinds for
// deck.add / deck.remove and the holdings for that container's slots. Those
// events carry no price of their own, so the cost basis is handed in from the
// collection's acquisitions instead (`paidByKey`).

/** One day of the collection's worth. */
export interface CollectionValuePoint {
  /** Whole UTC days since the epoch. */
  day: number;
  ts: number;
  /** Market value of the copies held at end of day, in display units. */
  total: number;
  /** What those same copies cost — recorded acquisition prices where known. */
  basis: number;
  /** total − basis: what the pile has gained or lost since you got it. */
  gain: number;
}

export interface CollectionValueSeries {
  pts: CollectionValuePoint[];
  /** Currency code every value above is quoted in. */
  unit: string;
  /** The add/remove events replayed, keyed by the day they land on. */
  eventsByDay: Map<number, UserEvent[]>;
  /** Copies held today whose printing has no recorded price at all. */
  unpriced: number;
  /** The kind that counts as copies arriving — the rest are copies leaving. */
  addKind: UserEventKind;
}

/** Which moves to replay, and what to fall back on when they carry no price. */
export interface ValueSeriesOpts {
  addKind?: UserEventKind;
  removeKind?: UserEventKind;
  /** Average paid per copy in EUR units, by `scryfallId|finish`. */
  paidByKey?: Map<string, number>;
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

/** How a printing-and-finish is keyed everywhere in here. */
export function valueKeyOf(scryfallId: string, finish: Finish): string {
  return `${scryfallId}|${finish}`;
}

/**
 * How much more (or less) a finish costs than the nonfoil the history tracks.
 * Only nonfoil prices are recorded per day, so a foil's line is the nonfoil
 * line scaled by today's foil premium — an approximation, but one that keeps a
 * foil-heavy collection's chart ending where the header total says it should.
 */
function finishFactor(p: CardPrice | undefined, finish: Finish, cur: Cur): number {
  if (!p || finish === 'nonfoil') return 1;
  const plain = p[cur];
  const variant = priceForFinish(p, finish)[cur];
  if (plain == null || variant == null || plain <= 0) return 1;
  return variant / plain;
}

/**
 * Build the daily series. Pure — the hook below feeds it, and so can a test.
 * Returns null when there aren't at least two days of readings to draw.
 */
export function buildCollectionValueSeries(
  entries: readonly { scryfallId: string; finish: Finish; quantity: number }[],
  events: readonly UserEvent[],
  histories: readonly PriceHistory[],
  prices: Map<string, CardPrice>,
  opts: ValueSeriesOpts = {},
): CollectionValueSeries | null {
  const addKind = opts.addKind ?? 'collection.add';
  const removeKind = opts.removeKind ?? 'collection.remove';
  const paidByKey = opts.paidByKey;
  const base: Cur = getPrefs().baseCurrency === 'USD' ? 'usd' : 'eur';
  const readers = new Map<string, Reader>();
  let first = Infinity;
  let last = -Infinity;
  for (const h of histories) {
    const startDay = dayNum(h.startDay);
    if (!Number.isFinite(startDay)) continue;
    const other: Cur = base === 'eur' ? 'usd' : 'eur';
    const cur: Cur = h[base].some((v) => v != null) ? base : other;
    if (!h[cur].some((v) => v != null)) continue;
    readers.set(h.scryfallId, { cur, readings: h[cur], startDay });
    if (startDay < first) first = startDay;
    const end = startDay + h[cur].length - 1;
    if (end > last) last = end;
  }
  const N = last - first + 1;
  if (!readers.size || !(N >= 2)) return null;

  // One rate per currency for the whole chart. Without both we can't put EUR-
  // and USD-quoted cards on one axis, so the raw quotes are summed in the base
  // currency instead — same fallback priceValue makes for a sort.
  const converted = canConvert();
  const unit = converted ? getPrefs().displayCurrency : getPrefs().baseCurrency;
  const scale: Record<Cur, number> = {
    eur: (converted ? convertToDisplay(1, 'EUR') : null) ?? 1,
    usd: (converted ? convertToDisplay(1, 'USD') : null) ?? 1,
  };

  const held = new Map<string, number>();
  for (const e of entries) {
    if (e.quantity > 0) held.set(valueKeyOf(e.scryfallId, e.finish), (held.get(valueKeyOf(e.scryfallId, e.finish)) ?? 0) + e.quantity);
  }

  /** In-window moves per key, ascending, stamped with their day index. */
  const moves = new Map<string, { d: number; e: UserEvent }[]>();
  /** Net copies each in-window move adds, so the starting stock can be derived. */
  const netIn = new Map<string, number>();
  /** What the copies bought *before* the window cost, per key. */
  const older = new Map<string, { paid: number; copies: number }>();
  const eventsByDay = new Map<number, UserEvent[]>();

  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  for (const e of ordered) {
    if (e.kind !== addKind && e.kind !== removeKind) continue;
    if (!e.scryfallId) continue;
    const key = valueKeyOf(e.scryfallId, e.finish ?? 'nonfoil');
    const qty = e.qty ?? 1;
    const day = Math.floor(e.ts / DAY_MS);
    if (day < first) {
      // Older than any reading: it shaped the starting stock, and if it carried
      // a price it's the best cost basis we have for those copies.
      if (e.kind === addKind && e.priceEurCents != null) {
        const acc = older.get(key) ?? { paid: 0, copies: 0 };
        acc.paid += (e.priceEurCents / 100) * qty;
        acc.copies += qty;
        older.set(key, acc);
      }
      continue;
    }
    // Anything stamped after the last reading (today, before the app recorded
    // today's prices) belongs on the final point rather than off the chart.
    const d = Math.min(day, last) - first;
    const list = moves.get(key);
    if (list) list.push({ d, e });
    else moves.set(key, [{ d, e }]);
    netIn.set(key, (netIn.get(key) ?? 0) + (e.kind === addKind ? qty : -qty));
    const dayKey = first + d;
    const onDay = eventsByDay.get(dayKey);
    if (onDay) onDay.push(e);
    else eventsByDay.set(dayKey, [e]);
  }

  const totals = new Float64Array(N);
  const bases = new Float64Array(N);
  let unpriced = 0;

  for (const key of new Set([...held.keys(), ...moves.keys()])) {
    const sep = key.lastIndexOf('|');
    const scryfallId = key.slice(0, sep);
    const finish = key.slice(sep + 1) as Finish;
    const now = held.get(key) ?? 0;
    const reader = readers.get(scryfallId);
    if (!reader) {
      // Never tracked (or dropped from tracking): it can't be drawn at all.
      unpriced += now;
      continue;
    }
    const factor = finishFactor(prices.get(scryfallId), finish, reader.cur);
    /** Earliest recorded price — the stand-in when a copy's own is unknown. */
    let firstPrice = NaN;
    for (const c of reader.readings) {
      if (c != null) {
        firstPrice = (c / 100) * scale[reader.cur] * factor;
        break;
      }
    }

    let qty = Math.max(0, now - (netIn.get(key) ?? 0));
    const pre = older.get(key);
    const knownPaid = paidByKey?.get(key);
    const seed =
      pre && pre.copies > 0
        ? (pre.paid / pre.copies) * scale.eur
        : knownPaid != null
          ? knownPaid * scale.eur
          : firstPrice;
    let basis = qty * (Number.isFinite(seed) ? seed : 0);

    const list = moves.get(key) ?? [];
    let mi = 0;
    let price = NaN;
    for (let d = 0; d < N; d++) {
      const idx = first + d - reader.startDay;
      if (idx >= 0 && idx < reader.readings.length) {
        const c = reader.readings[idx];
        // Gaps hold the last reading: a day the app wasn't opened is not a day
        // the card was worth nothing.
        if (c != null) price = (c / 100) * scale[reader.cur] * factor;
      }
      while (mi < list.length && list[mi]!.d <= d) {
        const { e } = list[mi]!;
        mi++;
        const n = e.qty ?? 1;
        if (e.kind === addKind) {
          const paid =
            e.priceEurCents != null
              ? (e.priceEurCents / 100) * scale.eur
              : knownPaid != null
                ? knownPaid * scale.eur
                : Number.isFinite(price)
                  ? price
                  : firstPrice;
          qty += n;
          basis += n * (Number.isFinite(paid) ? paid : 0);
        } else {
          // Average cost: we don't track which physical copy left, so the ones
          // that stay carry the mean of what the pile cost.
          const gone = Math.min(n, qty);
          if (qty > 0) basis -= basis * (gone / qty);
          qty -= gone;
        }
      }
      if (qty > 0 && Number.isFinite(price)) {
        totals[d]! += qty * price;
        bases[d]! += basis;
      }
    }
  }

  const pts: CollectionValuePoint[] = [];
  for (let d = 0; d < N; d++) {
    const day = first + d;
    pts.push({ day, ts: day * DAY_MS, total: totals[d]!, basis: bases[d]!, gain: totals[d]! - bases[d]! });
  }
  return { pts, unit, eventsByDay, unpriced, addKind };
}

/** The live daily value series for the whole collection. Null = not enough data. */
export function useCollectionValueSeries(): CollectionValueSeries | null | undefined {
  return useLiveQuery(async () => {
    const [entries, events, histories] = await Promise.all([
      db.collection.toArray(),
      db.events.where('kind').anyOf('collection.add', 'collection.remove').toArray(),
      db.priceHistories.toArray(),
    ]);
    const prices = await getPricesByIds(histories.map((h) => h.scryfallId));
    return buildCollectionValueSeries(entries, events, histories, prices);
  }, []);
}

/**
 * The same series for one deck, binder or box: the copies filed there, replayed
 * through that container's own add/remove log. "Any printing" basics and token
 * slots are left out for the same reason they're left out of the header total —
 * nobody prices a lands-box Island.
 *
 * Filing a card costs nothing, so the cost basis has to come from somewhere
 * else: the collection's acquisitions, averaged per printing and finish.
 */
export function useContainerValueSeries(deckId: string): CollectionValueSeries | null | undefined {
  return useLiveQuery(async () => {
    const [cards, events, acquisitions] = await Promise.all([
      db.deckCards.where('deckId').equals(deckId).toArray(),
      db.events.where('deckId').equals(deckId).toArray(),
      db.events.where('kind').equals('collection.add').toArray(),
    ]);
    const entries = cards
      .filter((c) => c.scryfallId && !c.anyBasic && c.board !== 'token')
      .map((c) => ({ scryfallId: c.scryfallId!, finish: c.finish ?? 'nonfoil', quantity: c.quantity }));
    const ids = [
      ...new Set([
        ...entries.map((e) => e.scryfallId),
        ...events.map((e) => e.scryfallId).filter((s): s is string => !!s),
      ]),
    ];
    if (!ids.length) return null;
    const idSet = new Set(ids);
    const [rows, prices] = await Promise.all([db.priceHistories.bulkGet(ids), getPricesByIds(ids)]);
    const histories = rows.filter((h): h is PriceHistory => !!h);

    const paid = new Map<string, { paid: number; copies: number }>();
    for (const e of acquisitions) {
      if (!e.scryfallId || e.priceEurCents == null || !idSet.has(e.scryfallId)) continue;
      const key = valueKeyOf(e.scryfallId, e.finish ?? 'nonfoil');
      const acc = paid.get(key) ?? { paid: 0, copies: 0 };
      const qty = e.qty ?? 1;
      acc.paid += (e.priceEurCents / 100) * qty;
      acc.copies += qty;
      paid.set(key, acc);
    }
    const paidByKey = new Map([...paid].map(([k, v]) => [k, v.paid / v.copies]));

    return buildCollectionValueSeries(entries, events, histories, prices, {
      addKind: 'deck.add',
      removeKind: 'deck.remove',
      paidByKey,
    });
  }, [deckId]);
}
