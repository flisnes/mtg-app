import { useLiveQuery } from 'dexie-react-hooks';
import type { DayReadings, UserEvent } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrefs, type BaseCurrency } from '../prefs.js';
import { centsNearest, dayKeyOf, type HistoryChange } from './history.js';
import { convertToDisplay } from './rates.js';

// What a card cost you, and how it has done since. "Up 87% since we started
// recording prices" is a fact about our archive; "up 5% since you paid for it"
// is a fact about your money, and that's the one worth leading with.
//
// Acquisition prices are recorded in EUR cents whatever the display settings
// say, so everything here converts before it compares.
//
// Where the per-copy figure comes from, best source first:
//
//   1. What you told us you paid. Editing the price on a History event writes
//      the same priceEurCents the add stamped, so this needs no separate slot:
//      your number simply replaces ours.
//   2. The card's market price on the day it went in, stamped automatically by
//      every add path in dataAccess.ts. This is the usual case.
//   3. The recorded reading nearest the day it went in, when neither of the
//      above is on file. That covers the cards the v7 upgrade backfilled with a
//      null price (everything you owned before the event log existed) and any
//      card the price DB didn't know on the day you added it. Looking forward
//      as well as back matters here: a card acquired before its history starts
//      has no earlier reading, and the first one recorded is the fair estimate.
//
// Rung 3 is an estimate off the archive rather than a fact about your money, so
// it's flagged (`estimated`) and the sheet says so.

/** What the recorded acquisitions of one printing cost, averaged per copy. */
export interface CostBasis {
  /** Average paid per copy, in EUR units. */
  perCopy: number;
  /** Copies the average is over. */
  copies: number;
  /** Earliest acquisition counted. */
  since: number;
  /** True when any copy's figure came off the archive (rung 3) rather than a
   *  recorded price. */
  estimated: boolean;
}

/**
 * Average paid per copy across every acquisition, following the ladder above.
 * A copy we can't price at all simply doesn't count: an average of what we know
 * beats a zero we made up. Printing-agnostic events belong to every printing's
 * basis.
 *
 * `history` is that printing's recorded readings, and is what rung 3 reads;
 * without it the ladder stops at rung 2, which is what callers that have no
 * history to hand get.
 *
 * Prices are per copy *and per finish* as stamped, but averaged across finishes
 * here, because a PriceHistory has no foil lane to separate them with yet. When
 * it grows one, this is where the finish filter goes.
 */
export function costBasisOf(
  events: readonly UserEvent[],
  scryfallId?: string,
  history?: DayReadings,
): CostBasis | null {
  let paid = 0;
  let copies = 0;
  let since = Infinity;
  let estimated = false;
  for (const e of events) {
    if (e.kind !== 'collection.add') continue;
    if (scryfallId && e.scryfallId && e.scryfallId !== scryfallId) continue;
    let cents = e.priceEurCents ?? null;
    if (cents == null) {
      if (!history) continue;
      const near = centsNearest(history, dayKeyOf(e.ts));
      if (!near) continue;
      cents = near.cents;
      estimated = true;
    }
    const qty = e.qty ?? 1;
    paid += (cents / 100) * qty;
    copies += qty;
    if (e.ts < since) since = e.ts;
  }
  if (copies <= 0) return null;
  return { perCopy: paid / copies, copies, since, estimated };
}

/**
 * Live cost basis for the shown printing of a card. Callers that already hold
 * the printing's history pass it in, both to spare a second read and so the
 * basis is computed against the *merged* (server-backfilled) readings rather
 * than whatever this device happened to record.
 */
export function useCostBasis(
  oracleId: string | undefined,
  scryfallId: string | undefined,
  history?: DayReadings | null,
): CostBasis | null | undefined {
  return useLiveQuery(async () => {
    if (!oracleId) return null;
    const events = await db.events.where('oracleId').equals(oracleId).toArray();
    return costBasisOf(events, scryfallId, history ?? undefined);
  }, [oracleId, scryfallId, history]);
}

/** A card measured against what it cost, with both figures in one currency. */
export interface AcquisitionGain {
  /** Average paid per copy. */
  paid: number;
  /** Latest recorded price. */
  now: number;
  /** now − paid. */
  delta: number;
  pct: number | null;
  /** Currency code the three amounts above are quoted in. */
  unit: string;
  since: number;
  /** The basis was estimated off the archive, not recorded (see CostBasis). */
  estimated: boolean;
}

/**
 * Line the latest reading up against what the copies cost. Null when nothing
 * was paid on record, or when a USD-quoted card and a EUR price can't be put
 * in one currency because there's no rate to hand.
 */
export function acquisitionGain(trend: HistoryChange, basis: CostBasis | null | undefined): AcquisitionGain | null {
  if (!basis || !(basis.perCopy > 0)) return null;
  const from: BaseCurrency = trend.cur === 'eur' ? 'EUR' : 'USD';
  const now = convertToDisplay(trend.current, from);
  const paid = convertToDisplay(basis.perCopy, 'EUR');
  const pair =
    now != null && paid != null
      ? { now, paid, unit: getPrefs().displayCurrency }
      : trend.cur === 'eur'
        ? { now: trend.current, paid: basis.perCopy, unit: 'EUR' }
        : null;
  if (!pair) return null;
  const delta = pair.now - pair.paid;
  return {
    ...pair,
    delta,
    pct: pair.paid ? (delta / pair.paid) * 100 : null,
    since: basis.since,
    estimated: basis.estimated,
  };
}
