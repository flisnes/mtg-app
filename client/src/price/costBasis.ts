import { useLiveQuery } from 'dexie-react-hooks';
import type { UserEvent } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrefs, type BaseCurrency } from '../prefs.js';
import type { HistoryChange } from './history.js';
import { convertToDisplay } from './rates.js';

// What a card cost you, and how it has done since. "Up 87% since we started
// recording prices" is a fact about our archive; "up 5% since you paid for it"
// is a fact about your money, and that's the one worth leading with.
//
// Acquisition prices are recorded in EUR cents whatever the display settings
// say, so everything here converts before it compares.

/** What the recorded acquisitions of one printing cost, averaged per copy. */
export interface CostBasis {
  /** Average paid per copy, in EUR units. */
  perCopy: number;
  /** Copies the average is over. */
  copies: number;
  /** Earliest acquisition counted. */
  since: number;
}

/**
 * Average paid per copy across every acquisition with a recorded price. Copies
 * bought without one simply don't count — an average of what we know beats a
 * zero we made up. Printing-agnostic events belong to every printing's basis.
 */
export function costBasisOf(events: readonly UserEvent[], scryfallId?: string): CostBasis | null {
  let paid = 0;
  let copies = 0;
  let since = Infinity;
  for (const e of events) {
    if (e.kind !== 'collection.add' || e.priceEurCents == null) continue;
    if (scryfallId && e.scryfallId && e.scryfallId !== scryfallId) continue;
    const qty = e.qty ?? 1;
    paid += (e.priceEurCents / 100) * qty;
    copies += qty;
    if (e.ts < since) since = e.ts;
  }
  if (copies <= 0) return null;
  return { perCopy: paid / copies, copies, since };
}

/** Live cost basis for the shown printing of a card. */
export function useCostBasis(oracleId: string | undefined, scryfallId: string | undefined): CostBasis | null | undefined {
  return useLiveQuery(async () => {
    if (!oracleId) return null;
    return costBasisOf(await db.events.where('oracleId').equals(oracleId).toArray(), scryfallId);
  }, [oracleId, scryfallId]);
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
  return { ...pair, delta, pct: pair.paid ? (delta / pair.paid) * 100 : null, since: basis.since };
}
