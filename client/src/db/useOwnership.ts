import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './schema.js';

// One shared answer to "do I own this card?" for the ownership checkmark shown
// on cards everywhere (search, scan, wishlist, decks, trade, the card sheet).
// A single live query over the whole collection, grouped per oracle, so every
// render site reads the same source instead of each rolling its own query.

export interface OwnedStatus {
  /** Copies owned across every printing of this oracle card. */
  qty: number;
  /** Copies marked for trade across every printing. */
  forTrade: number;
  /** Do we own the exact printing being shown (not just some other edition)? */
  ownsExact: boolean;
}

export interface OwnershipIndex {
  /** Ownership of an oracle card; pass the shown printing to resolve exact vs other. */
  lookup(oracleId: string, scryfallId?: string | null): OwnedStatus;
  /** Every printing (scryfallId) held for this oracle card — empty if none. */
  ownedPrintings(oracleId: string): string[];
}

interface OracleOwn {
  qty: number;
  forTrade: number;
  ids: Set<string>;
}

const NONE: OwnedStatus = { qty: 0, forTrade: 0, ownsExact: false };

export function useOwnershipIndex(): OwnershipIndex | undefined {
  const rows = useLiveQuery(() => db.collection.toArray(), []);
  return useMemo(() => {
    if (!rows) return undefined;
    const byOracle = new Map<string, OracleOwn>();
    for (const e of rows) {
      let g = byOracle.get(e.oracleId);
      if (!g) {
        g = { qty: 0, forTrade: 0, ids: new Set() };
        byOracle.set(e.oracleId, g);
      }
      g.qty += e.quantity;
      g.forTrade += e.quantityForTrade;
      g.ids.add(e.scryfallId);
    }
    return {
      lookup(oracleId, scryfallId) {
        const g = byOracle.get(oracleId);
        if (!g) return NONE;
        return { qty: g.qty, forTrade: g.forTrade, ownsExact: !!scryfallId && g.ids.has(scryfallId) };
      },
      ownedPrintings(oracleId) {
        const g = byOracle.get(oracleId);
        return g ? [...g.ids] : [];
      },
    };
  }, [rows]);
}
