import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry, Condition, Finish } from '@mtg/shared';
import { wishPrefsMet } from '@mtg/shared';
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

/**
 * What a slot (or a wish) asks of a copy: an edition plus the same optional
 * finish/condition/language preferences a wishlist line carries. Undefined —
 * or null for the edition — means "any", and condition is a minimum.
 */
export interface OwnWants {
  scryfallId?: string | null;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

export interface OwnershipIndex {
  /** Ownership of an oracle card; pass the shown printing to resolve exact vs other. */
  lookup(oracleId: string, scryfallId?: string | null): OwnedStatus;
  /**
   * Ownership measured against what a slot wants: `ownsExact` is true when some
   * owned copy meets every preference the slot names. "Any" preferences match
   * anything, so a slot that pins nothing counts as had the moment you own the
   * card in any edition.
   */
  lookupWanted(oracleId: string, wants: OwnWants): OwnedStatus;
  /** Every printing (scryfallId) held for this oracle card — empty if none. */
  ownedPrintings(oracleId: string): string[];
  /** The copies owned of one oracle card, newest write order — empty if none. */
  ownedCopies(oracleId: string): CollectionEntry[];
}

interface OracleOwn {
  qty: number;
  forTrade: number;
  ids: Set<string>;
  entries: CollectionEntry[];
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
        g = { qty: 0, forTrade: 0, ids: new Set(), entries: [] };
        byOracle.set(e.oracleId, g);
      }
      g.qty += e.quantity;
      g.forTrade += e.quantityForTrade;
      g.ids.add(e.scryfallId);
      g.entries.push(e);
    }
    return {
      lookup(oracleId, scryfallId) {
        const g = byOracle.get(oracleId);
        if (!g) return NONE;
        return { qty: g.qty, forTrade: g.forTrade, ownsExact: !!scryfallId && g.ids.has(scryfallId) };
      },
      lookupWanted(oracleId, wants) {
        const g = byOracle.get(oracleId);
        if (!g) return NONE;
        const met = g.entries.some(
          (e) => (!wants.scryfallId || wants.scryfallId === e.scryfallId) && wishPrefsMet(wants, e),
        );
        return { qty: g.qty, forTrade: g.forTrade, ownsExact: met };
      },
      ownedPrintings(oracleId) {
        const g = byOracle.get(oracleId);
        return g ? [...g.ids] : [];
      },
      ownedCopies(oracleId) {
        return byOracle.get(oracleId)?.entries ?? [];
      },
    };
  }, [rows]);
}
