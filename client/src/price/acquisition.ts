import type { Finish } from '@mtg/shared';
import { priceForFinish, type CardPrice } from '../cardDb/prices.js';
import { toCents } from './history.js';
import { usdToEur } from './rates.js';

// What a copy was worth the day it changed hands, in EUR cents — the single
// stamp behind every `priceEurCents` in the event log (adds, removals, trade
// exits, imports). One helper because a foil's basis is only as good as the
// price we recorded for it, and a card whose basis is wrong stays wrong
// forever: the number is written once and read for the rest of the card's life.
//
// Per finish, always. A foil copy is stamped with the foil price, never the
// nonfoil one, which is what makes "up €4 since you paid" a fact rather than a
// comparison between two different pieces of cardboard.
//
// The EUR-then-USD ladder matters for foils in particular: Cardmarket's foil
// coverage is thinner than TCGplayer's, so plenty of foils quote in dollars
// only. Converting that quote beats recording nothing, and beats the nonfoil
// euro price by a mile. Without a cached USD rate (the usual case for a
// euro-only user, since rates are fetched lazily) it still comes out null, the
// card falls back to an estimate, and the sheet says so.

/** Market price per copy of this finish in EUR cents, or null when unknown. */
export function acquisitionCents(price: CardPrice | undefined, finish: Finish): number | null {
  if (!price) return null;
  const { eur, usd } = priceForFinish(price, finish);
  if (eur != null) return toCents(eur);
  if (usd != null) {
    const converted = usdToEur(usd);
    if (converted != null) return toCents(converted);
  }
  return null;
}
