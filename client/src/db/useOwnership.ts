import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry, Condition, Finish } from '@mtg/shared';
import { wishPrefsMet } from '@mtg/shared';
import { db } from './schema.js';

// One shared answer to "where does this card stand with me?" for the checkmark
// shown on cards everywhere (search, scan, wishlist, decks, trade, the card
// sheet). Two live queries — the whole collection and the whole wishlist —
// grouped per oracle, so every render site reads the same source instead of
// each rolling its own.

export interface OwnedStatus {
  /** Copies owned across every printing of this oracle card. */
  qty: number;
  /** Copies marked for trade across every printing. */
  forTrade: number;
  /** Do we own the exact printing being shown (not just some other edition)? */
  ownsExact: boolean;
  /** Copies wished for across every printing of this oracle. */
  wished: number;
  /** Are for-trade copies of the exact printing being shown? (Not just of some
   *  other edition of the same card.) Inverts the tradelist chip. */
  tradesExact?: boolean;
  /** Does a wish actually cover the printing being shown — either it names this
   *  one, or it's on "any printing" so anything counts? Inverts the wish chip. */
  wishesExact?: boolean;
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
   * Ownership measured against what a slot wants: `ownsExact` is true only when
   * the slot names all four (edition, finish, condition, language) *and* you own
   * a copy meeting them. A slot still on "any" is a shopping note, not a card
   * you can point at, so it stays on the single check.
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

/** Wishes for one oracle card, kept per printing so a chip can say whether the
 *  printing on screen is the one you're hunting. */
interface OracleWish {
  qty: number;
  /** Printings the wishes name; empty when every wish is on "any printing". */
  ids: Set<string>;
  /** At least one wish is on "any printing", so every printing is the one. */
  anyPrinting: boolean;
}

const NONE: OwnedStatus = { qty: 0, forTrade: 0, ownsExact: false, wished: 0 };

export function useOwnershipIndex(): OwnershipIndex | undefined {
  const rows = useLiveQuery(() => db.collection.toArray(), []);
  const wishes = useLiveQuery(() => db.wishlist.toArray(), []);
  return useMemo(() => {
    if (!rows || !wishes) return undefined;
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
    // Wishes are counted per oracle, not per printing: a wish can sit on "any
    // printing", so "you're after this card" is the only claim it always makes.
    // The printings are kept alongside anyway, for the chip that says "this is
    // the one".
    const wishedByOracle = new Map<string, OracleWish>();
    for (const w of wishes) {
      let g = wishedByOracle.get(w.oracleId);
      if (!g) {
        g = { qty: 0, ids: new Set(), anyPrinting: false };
        wishedByOracle.set(w.oracleId, g);
      }
      g.qty += w.quantity;
      if (w.scryfallId) g.ids.add(w.scryfallId);
      else g.anyPrinting = true;
    }
    /** Does a wish cover this printing? "Any printing" covers all of them. */
    const wishCovers = (g: OracleWish | undefined, scryfallId?: string | null) =>
      !!g && g.qty > 0 && (g.anyPrinting || (!!scryfallId && g.ids.has(scryfallId)));
    return {
      lookup(oracleId, scryfallId) {
        const w = wishedByOracle.get(oracleId);
        const wished = w?.qty ?? 0;
        const wishesExact = wishCovers(w, scryfallId);
        const g = byOracle.get(oracleId);
        if (!g) return wished ? { ...NONE, wished, wishesExact } : NONE;
        return {
          qty: g.qty,
          forTrade: g.forTrade,
          ownsExact: !!scryfallId && g.ids.has(scryfallId),
          wished,
          wishesExact,
          tradesExact: !!scryfallId && g.entries.some((e) => e.scryfallId === scryfallId && e.quantityForTrade > 0),
        };
      },
      lookupWanted(oracleId, wants) {
        const w = wishedByOracle.get(oracleId);
        const wished = w?.qty ?? 0;
        const wishesExact = wishCovers(w, wants.scryfallId);
        const g = byOracle.get(oracleId);
        if (!g) return wished ? { ...NONE, wished, wishesExact } : NONE;
        // Exact means exact: the slot has to say which printing, finish,
        // condition and language it means before we can claim you have *that*
        // card. Leave anything on "any" and it's the single check.
        const pinned = !!wants.scryfallId && !!wants.finish && !!wants.condition && !!wants.lang;
        const met =
          pinned && g.entries.some((e) => wants.scryfallId === e.scryfallId && wishPrefsMet(wants, e));
        return {
          qty: g.qty,
          forTrade: g.forTrade,
          ownsExact: met,
          wished,
          wishesExact,
          tradesExact: !!wants.scryfallId && g.entries.some((e) => e.scryfallId === wants.scryfallId && e.quantityForTrade > 0),
        };
      },
      ownedPrintings(oracleId) {
        const g = byOracle.get(oracleId);
        return g ? [...g.ids] : [];
      },
      ownedCopies(oracleId) {
        return byOracle.get(oracleId)?.entries ?? [];
      },
    };
  }, [rows, wishes]);
}
