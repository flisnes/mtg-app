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
// Placements are per oracle card, not per copy: a slot says "4 Lightning Bolt in
// the Burn deck", not which four pieces of cardboard. That's enough to answer
// "where do I keep this?", and it's why over-placement is a flag rather than an
// error — the app never blocks you from listing a card in two places, it just
// tells you when you've promised more copies than you own.

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
  /** Every container holding this card, decks first, then binders, then boxes. */
  places: Placement[];
  /** Copies placed across all of them. */
  placed: number;
  /** Copies owned, all printings (the yardstick for `over`). */
  owned: number;
  /** More copies placed than owned — the same copy is promised twice. */
  over: boolean;
}

export interface PlacementIndex {
  lookup(oracleId: string): PlacementInfo;
}

const NONE: PlacementInfo = { places: [], placed: 0, owned: 0, over: false };

const KIND_ORDER: Record<ContainerKind, number> = { deck: 0, binder: 1, box: 2 };

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

    const byOracle = new Map<string, Placement[]>();
    for (const s of data.slots) {
      const container = byId.get(s.deckId);
      if (!container) continue; // orphan slot (a delete that hasn't synced yet)
      const place: Placement = {
        containerId: container.id,
        kind: container.kind ?? 'deck',
        name: container.name,
        quantity: s.quantity,
        board: s.board,
      };
      const arr = byOracle.get(s.oracleId);
      if (arr) arr.push(place);
      else byOracle.set(s.oracleId, [place]);
    }
    // One card can sit in several boards of one deck (main + sideboard); merge
    // those into a single placement so the badge counts containers, not slots.
    const infos = new Map<string, PlacementInfo>();
    byOracle.forEach((places, oracleId) => {
      const merged = new Map<string, Placement>();
      for (const p of places) {
        const cur = merged.get(p.containerId);
        if (cur) cur.quantity += p.quantity;
        else merged.set(p.containerId, { ...p });
      }
      const list = [...merged.values()].sort(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
      );
      const placed = list.reduce((s, p) => s + p.quantity, 0);
      const ownedQty = owned.get(oracleId) ?? 0;
      infos.set(oracleId, { places: list, placed, owned: ownedQty, over: placed > ownedQty });
    });

    return {
      lookup(oracleId: string) {
        return infos.get(oracleId) ?? NONE;
      },
    };
  }, [data]);
}
