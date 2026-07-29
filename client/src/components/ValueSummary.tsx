import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { containerKind } from '../deck/containers.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { addToTotal, formatTotal, pricedForFinish, type PriceTotal } from './CardSorting.js';

// Compact "total value" readout for page headers. It sits in the empty space
// beside a page's options menu, so it costs no extra vertical room.

export function HeaderValue({ label = 'Total value', value }: { label?: string; value: string | undefined }) {
  return (
    <div className="header-value" title={value ? `${label}: ${value}` : undefined}>
      <span className="header-value-label">{label}</span>
      <span className="header-value-amount">{value ?? '…'}</span>
    </div>
  );
}

/** Total value of the collection (or just the copies marked for trade). */
export function useCollectionValue(onlyTrade = false): PriceTotal | undefined {
  return useLiveQuery(async () => {
    const entries = await db.collection.toArray();
    const relevant = onlyTrade ? entries.filter((e) => e.quantityForTrade > 0) : entries;
    const [oracleMap, printMap] = await Promise.all([
      getOracleCardsByIds(relevant.map((e) => e.oracleId)),
      getPrintingsByIds(relevant.map((e) => e.scryfallId)),
    ]);
    const total: PriceTotal = { eur: 0, usd: 0 };
    for (const e of relevant) {
      const qty = onlyTrade ? e.quantityForTrade : e.quantity;
      addToTotal(total, qty, pricedForFinish(printMap.get(e.scryfallId), e.finish), oracleMap.get(e.oracleId));
    }
    return total;
  }, [onlyTrade]);
}

/** Combined value of every card across every deck, binder or box of one kind. */
export function useContainersValue(kind: ContainerKind): PriceTotal | undefined {
  return useLiveQuery(async () => {
    const ids = new Set(
      (await db.decks.toArray()).filter((d) => containerKind(d) === kind).map((d) => d.id),
    );
    const cards = (await db.deckCards.toArray()).filter((c) => ids.has(c.deckId));
    const [oracleMap, printMap] = await Promise.all([
      getOracleCardsByIds(cards.map((c) => c.oracleId)),
      getPrintingsByIds(cards.map((c) => c.scryfallId).filter((s): s is string => !!s)),
    ]);
    const total: PriceTotal = { eur: 0, usd: 0 };
    for (const c of cards) {
      addToTotal(total, c.quantity, c.scryfallId ? printMap.get(c.scryfallId) : undefined, oracleMap.get(c.oracleId));
    }
    return total;
  }, [kind]);
}

/** Format a live total for the header, or undefined while it loads. */
export function headerValue(total: PriceTotal | undefined): string | undefined {
  return total ? formatTotal(total) : undefined;
}
