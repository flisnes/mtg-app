import { useLiveQuery } from 'dexie-react-hooks';
import type { DayReadings, Finish, UserEvent } from '@mtg/shared';
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
//
// Foils get a second flag. The daily archive is nonfoil-only (see
// notes/foil-price-tracking.md), so rung 3 on a foil copy prices it off the
// plain version, which for a chase foil is not even the right order of
// magnitude. Same for anything acquired before v0.53.0, when every finish was
// stamped with the nonfoil price. Neither is fixable after the fact — we have
// no historical foil prices to go back for — so both are flagged
// (`crossFinish`) and the sheet says which number it couldn't stand behind.

/**
 * Adds recorded before this stamped the nonfoil price on every finish; a foil's
 * basis from before it is the plain version's price. v0.53.0, 2026-07-25.
 */
export const FOIL_PRICING_SINCE = Date.parse('2026-07-25T00:00:00Z');

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
  /** True when any counted copy is foil or etched and its figure could only
   *  come from a nonfoil price. See the note above. */
  crossFinish: boolean;
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
 * Prices are stamped per copy *and per finish*, so pass the `finish` being
 * shown and only that finish's acquisitions count: a card owned both plain and
 * foil gets two honest bases rather than one blended average. Adds that name no
 * finish (an "any printing" wish fulfilled, a lands-box basic) count towards
 * every finish. Omit `finish` to average across all of them, which is what
 * callers with no single finish in view want.
 */
export function costBasisOf(
  events: readonly UserEvent[],
  scryfallId?: string,
  history?: DayReadings,
  finish?: Finish,
): CostBasis | null {
  let paid = 0;
  let copies = 0;
  let since = Infinity;
  let estimated = false;
  let crossFinish = false;
  for (const e of events) {
    if (e.kind !== 'collection.add') continue;
    if (scryfallId && e.scryfallId && e.scryfallId !== scryfallId) continue;
    if (finish && e.finish && e.finish !== finish) continue;
    const copyFinish = e.finish ?? finish ?? 'nonfoil';
    let cents = e.priceEurCents ?? null;
    if (cents == null) {
      if (!history) continue;
      const near = centsNearest(history, dayKeyOf(e.ts));
      if (!near) continue;
      cents = near.cents;
      estimated = true;
      if (copyFinish !== 'nonfoil') crossFinish = true;
    } else if (copyFinish !== 'nonfoil' && e.ts < FOIL_PRICING_SINCE) {
      crossFinish = true;
    }
    const qty = e.qty ?? 1;
    paid += (cents / 100) * qty;
    copies += qty;
    if (e.ts < since) since = e.ts;
  }
  if (copies <= 0) return null;
  return { perCopy: paid / copies, copies, since, estimated, crossFinish };
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
  finish?: Finish,
): CostBasis | null | undefined {
  return useLiveQuery(async () => {
    if (!oracleId) return null;
    const events = await db.events.where('oracleId').equals(oracleId).toArray();
    return costBasisOf(events, scryfallId, history ?? undefined, finish);
  }, [oracleId, scryfallId, history, finish]);
}

/** A card measured against what it cost, with both figures in one currency. */
export interface AcquisitionGain {
  /** Average paid per copy. */
  paid: number;
  /** What a copy is worth now. */
  now: number;
  /** now − paid. */
  delta: number;
  pct: number | null;
  /** Currency code the three amounts above are quoted in. */
  unit: string;
  since: number;
  /** The basis was estimated off the archive, not recorded (see CostBasis). */
  estimated: boolean;
  /** The basis could only come from a nonfoil price (see CostBasis). */
  crossFinish: boolean;
}

/**
 * Line what a copy is worth now up against what the copies cost. Null when
 * nothing was paid on record, or when a USD-quoted card and a EUR price can't
 * be put in one currency because there's no rate to hand.
 *
 * `now` is the current price of the *finish being shown*, which callers that
 * know it must pass: the trend's own last reading is a nonfoil number, and
 * measuring what you paid for a foil against the plain version's price invents
 * a loss on every foil card in the collection. Without it the fallback is that
 * last reading, which is right for nonfoil and all a caller with no printing to
 * hand (the sealed shelf) can offer.
 */
export function acquisitionGain(
  trend: HistoryChange,
  basis: CostBasis | null | undefined,
  now?: { amount: number; currency: BaseCurrency } | null,
): AcquisitionGain | null {
  if (!basis || !(basis.perCopy > 0)) return null;
  const from: BaseCurrency = now ? now.currency : trend.cur === 'eur' ? 'EUR' : 'USD';
  const raw = now ? now.amount : trend.current;
  const converted = convertToDisplay(raw, from);
  const paid = convertToDisplay(basis.perCopy, 'EUR');
  const pair =
    converted != null && paid != null
      ? { now: converted, paid, unit: getPrefs().displayCurrency }
      : from === 'EUR'
        ? { now: raw, paid: basis.perCopy, unit: 'EUR' }
        : null;
  if (!pair) return null;
  const delta = pair.now - pair.paid;
  return {
    ...pair,
    delta,
    pct: pair.paid ? (delta / pair.paid) * 100 : null,
    since: basis.since,
    estimated: basis.estimated,
    crossFinish: basis.crossFinish,
  };
}
