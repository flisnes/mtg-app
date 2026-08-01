import { useMemo } from 'react';
import { prefsCompatible, type ContainerKind, type CopyPrefs, type DeckBoard } from '@mtg/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './schema.js';

// One shared answer to "where is this card?" — the deck / binder / box badge on
// collection cards and the pills in the card sheet. Decks, binders and boxes are
// all rows of the same table, so a single live query over decks + deckCards
// covers all three, and every render site reads the same index instead of
// rolling its own query.
//
// Placements narrow as far as the slot lets them. A slot says "1 Enlightened
// Tutor (The List) in the Legacy deck", so the badge on a Mirage copy stays
// clean while the List copy shows the deck glyph; pick the copy out of your
// collection and the slot also remembers its finish, condition and language, so
// your Spanish Mox Diamond and your English one point at different decks. What a
// slot leaves unsaid it doesn't narrow on: a name-only decklist slot pins no
// edition and no traits, so it counts for every copy of that card.
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
  /** Containers whose slots could be the copy asked about (every container
   *  holding the card, when neither printing nor traits were given), decks
   *  first, then binders, then boxes. */
  places: Placement[];
  /** Copies placed across every container, all printings (card-wide). */
  placed: number;
  /** Copies owned, all printings (the yardstick for `over`). */
  owned: number;
  /** More copies placed than owned, card-wide — the same copy is promised twice. */
  over: boolean;
}

export interface PlacementIndex {
  /**
   * Where a card is filed. Pass the shown printing to narrow it to that edition,
   * and the copy's traits (a collection entry, or what a slot wants) to narrow it
   * to that piece of cardboard. Leave either out and it doesn't narrow on it.
   */
  lookup(oracleId: string, scryfallId?: string | null, copy?: CopyPrefs): PlacementInfo;
}

const NONE: PlacementInfo = { places: [], placed: 0, owned: 0, over: false };

const KIND_ORDER: Record<ContainerKind, number> = { deck: 0, binder: 1, box: 2 };

/** A filed slot: where it is, plus what it asks of the copy filling it. */
interface Slot extends Placement {
  /** The edition it pins; undefined = any (a slot added by name). */
  scryfallId?: string;
  prefs: CopyPrefs;
}

interface OraclePlacements {
  slots: Slot[];
  placed: number;
  owned: number;
  over: boolean;
  /** Merged answers per question asked — a list view asks the same one per row. */
  cache: Map<string, Placement[]>;
}

// One card can sit in several boards of one deck (main + sideboard), or in one
// deck twice under different editions; merge those into a single placement so a
// badge counts containers, not slots.
function mergeByContainer(slots: Slot[]): Placement[] {
  const merged = new Map<string, Placement>();
  for (const s of slots) {
    const cur = merged.get(s.containerId);
    if (cur) cur.quantity += s.quantity;
    else
      merged.set(s.containerId, {
        containerId: s.containerId,
        kind: s.kind,
        name: s.name,
        quantity: s.quantity,
        board: s.board,
      });
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

    // Raw slots bucketed per oracle card, each keeping the edition and the traits
    // it asks for; the filtering happens per question at lookup time.
    const byOracle = new Map<string, Slot[]>();
    for (const s of data.slots) {
      // An "any printing" basic promises nothing about your shelves: it isn't a
      // copy you own, so it neither files a card away nor over-promises one.
      if (s.anyBasic) continue;
      const container = byId.get(s.deckId);
      if (!container) continue; // orphan slot (a delete that hasn't synced yet)
      const slot: Slot = {
        containerId: container.id,
        kind: container.kind ?? 'deck',
        name: container.name,
        quantity: s.quantity,
        board: s.board,
        ...(s.scryfallId ? { scryfallId: s.scryfallId } : {}),
        prefs: { condition: s.condition, finish: s.finish, lang: s.lang },
      };
      const arr = byOracle.get(s.oracleId);
      if (arr) arr.push(slot);
      else byOracle.set(s.oracleId, [slot]);
    }

    const infos = new Map<string, OraclePlacements>();
    byOracle.forEach((slots, oracleId) => {
      // Card-wide on purpose (see the note up top): every copy placed anywhere,
      // against every copy owned in any printing.
      const placed = slots.reduce((sum, s) => sum + s.quantity, 0);
      const ownedQty = owned.get(oracleId) ?? 0;
      infos.set(oracleId, {
        slots,
        placed,
        owned: ownedQty,
        over: placed > ownedQty,
        cache: new Map(),
      });
    });

    return {
      lookup(oracleId: string, scryfallId?: string | null, copy?: CopyPrefs) {
        const g = infos.get(oracleId);
        if (!g) return NONE;
        const key = `${scryfallId ?? ''}|${copy?.finish ?? ''}|${copy?.lang ?? ''}|${copy?.condition ?? ''}`;
        let places = g.cache.get(key);
        if (!places) {
          places = mergeByContainer(
            g.slots.filter(
              (s) =>
                (!scryfallId || !s.scryfallId || s.scryfallId === scryfallId) &&
                (!copy || prefsCompatible(s.prefs, copy)),
            ),
          );
          g.cache.set(key, places);
        }
        return { places, placed: g.placed, owned: g.owned, over: g.over };
      },
    };
  }, [data]);
}
