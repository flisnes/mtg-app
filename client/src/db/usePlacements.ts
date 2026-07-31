import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind, DeckBoard } from '@mtg/shared';
import { db } from './schema.js';

// One shared answer to "where is this card?" — the deck / binder / box badge on
// collection cards and the pills in the card sheet. Decks, binders and boxes are
// all rows of the same table, so a single live query over decks + deckCards
// covers all three, and every render site reads the same index instead of
// rolling its own query.
//
// Placements are per printing, not per copy: a slot says "1 Enlightened Tutor
// (The List) in the Legacy deck", not which piece of cardboard. So the badge on
// a Mirage copy stays clean while the List copy shows the deck glyph. A slot
// that pins no printing (added by name, e.g. a pasted decklist) can be any
// edition, so it counts for every printing of that card.
//
// The over-placement flag stays card-wide on purpose: it compares every copy
// placed anywhere against every copy owned in any printing. Narrowing it per
// printing would cry wolf on name-only decklists, where a slot has no edition to
// match against your shelves. It's a flag either way — the app never blocks you
// from listing a card in two places, it just tells you when you've promised more
// copies than you own.

export interface Placement {
  containerId: string;
  kind: ContainerKind;
  name: string;
  /** Copies of this card held there. */
  quantity: number;
  /** Which board, for a deck. Binders and boxes are always 'main'. */
  board: DeckBoard;
}

export interface PlacementInfo {
  /** Containers holding this printing (or the card, when no printing was asked
   *  about), decks first, then binders, then boxes. */
  places: Placement[];
  /** Copies placed across every container, all printings (card-wide). */
  placed: number;
  /** Copies owned, all printings (the yardstick for `over`). */
  owned: number;
  /** More copies placed than owned, card-wide — the same copy is promised twice. */
  over: boolean;
}

export interface PlacementIndex {
  /** Where a card is filed; pass the shown printing to narrow it to that edition. */
  lookup(oracleId: string, scryfallId?: string | null): PlacementInfo;
}

const NONE: PlacementInfo = { places: [], placed: 0, owned: 0, over: false };

const KIND_ORDER: Record<ContainerKind, number> = { deck: 0, binder: 1, box: 2 };

interface OraclePlacements {
  /** Every container, whatever printing. */
  any: Placement[];
  /** Per pinned printing, already merged with the edition-less slots. */
  perPrinting: Map<string, Placement[]>;
  /** The edition-less slots alone — the answer for a printing with no slot of its own. */
  anyEdition: Placement[];
  placed: number;
  owned: number;
  over: boolean;
}

// One card can sit in several boards of one deck (main + sideboard), or in one
// deck twice under different editions; merge those into a single placement so a
// badge counts containers, not slots.
function mergeByContainer(places: Placement[]): Placement[] {
  const merged = new Map<string, Placement>();
  for (const p of places) {
    const cur = merged.get(p.containerId);
    if (cur) cur.quantity += p.quantity;
    else merged.set(p.containerId, { ...p });
  }
  return [...merged.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}

export function usePlacementIndex(): PlacementIndex | undefined {
  const data = useLiveQuery(async () => {
    const [containers, slots, entries] = await Promise.all([
      db.decks.toArray(),
      db.deckCards.toArray(),
      db.collection.toArray(),
    ]);
    return { containers, slots, entries };
  }, []);

  return useMemo(() => {
    if (!data) return undefined;
    const byId = new Map(data.containers.map((c) => [c.id, c]));
    const owned = new Map<string, number>();
    for (const e of data.entries) owned.set(e.oracleId, (owned.get(e.oracleId) ?? 0) + e.quantity);

    // Raw slots bucketed per oracle card, split by the printing they pin (if any).
    interface Buckets {
      all: Placement[];
      pinned: Map<string, Placement[]>;
      loose: Placement[];
    }
    const byOracle = new Map<string, Buckets>();
    for (const s of data.slots) {
      // An "any printing" basic promises nothing about your shelves: it isn't a
      // copy you own, so it neither files a card away nor over-promises one.
      if (s.anyBasic) continue;
      const container = byId.get(s.deckId);
      if (!container) continue; // orphan slot (a delete that hasn't synced yet)
      const place: Placement = {
        containerId: container.id,
        kind: container.kind ?? 'deck',
        name: container.name,
        quantity: s.quantity,
        board: s.board,
      };
      let g = byOracle.get(s.oracleId);
      if (!g) {
        g = { all: [], pinned: new Map(), loose: [] };
        byOracle.set(s.oracleId, g);
      }
      g.all.push(place);
      if (s.scryfallId) {
        const arr = g.pinned.get(s.scryfallId);
        if (arr) arr.push(place);
        else g.pinned.set(s.scryfallId, [place]);
      } else {
        g.loose.push(place);
      }
    }

    const infos = new Map<string, OraclePlacements>();
    byOracle.forEach((g, oracleId) => {
      const any = mergeByContainer(g.all);
      const anyEdition = mergeByContainer(g.loose);
      const perPrinting = new Map<string, Placement[]>();
      // An edition-less slot could be this printing, so it rides along with every
      // pinned one.
      g.pinned.forEach((places, id) => perPrinting.set(id, mergeByContainer([...places, ...g.loose])));
      const placed = any.reduce((s, p) => s + p.quantity, 0);
      const ownedQty = owned.get(oracleId) ?? 0;
      infos.set(oracleId, {
        any,
        perPrinting,
        anyEdition,
        placed,
        owned: ownedQty,
        over: placed > ownedQty,
      });
    });

    return {
      lookup(oracleId: string, scryfallId?: string | null) {
        const g = infos.get(oracleId);
        if (!g) return NONE;
        const places = !scryfallId ? g.any : g.perPrinting.get(scryfallId) ?? g.anyEdition;
        return { places, placed: g.placed, owned: g.owned, over: g.over };
      },
    };
  }, [data]);
}
