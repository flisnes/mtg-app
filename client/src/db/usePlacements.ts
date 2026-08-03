import { useMemo } from 'react';
import {
  prefsCompatible,
  type Condition,
  type ContainerKind,
  type CopyPrefs,
  type DeckBoard,
  type Finish,
} from '@mtg/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { claimKeyOf } from '../deck/filing.js';
import { collectionKey } from './dataAccess.js';
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
// ---------------------------------------------------------------------------
// Claiming: which slot holds the actual piece of cardboard
// ---------------------------------------------------------------------------
// A card can only be in one place at a time, so exactly one slot can hold any
// one copy you own. Only a *pinned* slot claims one: not an "any printing"
// basic, and naming all four of printing, finish, condition and language — which
// is precisely what filing a copy out of your collection writes. Every other
// slot is brewing, not storage: a pasted decklist line that names no edition
// promises nothing about your shelves, so it claims nothing, never turns green
// and never raises a conflict. That's what keeps the flag from crying wolf, and
// it's why we can be strict about the slots that *are* about real cards.
//
// A claim is exact — same printing, same finish, same condition, same language —
// so it's the collection entry's own key. Copies go to the newest claim first:
// file a card into a new deck and it goes green there, while the deck it left
// turns amber, which is the order the user did things in.
//
// Two functionally identical copies are deliberately indistinguishable: own 2x
// the same printing/finish/condition/language and file one in each of two decks
// and both are backed, both green, no conflict. We can't tell them apart and
// don't need to.

export interface Placement {
  containerId: string;
  kind: ContainerKind;
  name: string;
  /** Copies of this card held there. */
  quantity: number;
  /** Which board, for a deck. Binders and boxes are always 'main'. */
  board: DeckBoard;
  /** Of those copies, how many are a card you actually own and that this
   *  container is holding — the pill's half of the green badge. */
  backed: number;
}

export interface PlacementInfo {
  /** Containers whose slots could be the copy asked about (every container
   *  holding the card, when neither printing nor traits were given), decks
   *  first, then binders, then boxes. */
  places: Placement[];
  /**
   * Copies claimed by pinned slots, counted over the copies this lookup covers
   * — and, when `over`, over the conflicting ones alone, so the number always
   * reads against `owned`.
   */
  claimed: number;
  /** Copies owned of those same copies. */
  owned: number;
  /** One piece of cardboard is filed in more places than you own copies of it. */
  over: boolean;
}

/**
 * One physical copy filed in more places than you own of it — a row in the
 * filing-conflict walkthrough. Self-describing (it carries the copy's identity
 * and every container claiming it) so the resolver needs nothing but the card DB
 * to render it.
 */
export interface FilingConflict {
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  /** Copies of this exact card in your collection. */
  owned: number;
  /** Copies of it promised to containers — more than `owned`, or it wouldn't be here. */
  claimed: number;
  /** The containers claiming it, decks first. */
  places: Placement[];
}

export interface PlacementIndex {
  /**
   * Where a card is filed. Pass the shown printing to narrow it to that edition,
   * and the copy's traits (a collection entry, or what a slot wants) to narrow it
   * to that piece of cardboard. Leave either out and it doesn't narrow on it.
   */
  lookup(oracleId: string, scryfallId?: string | null, copy?: CopyPrefs): PlacementInfo;
  /**
   * How many of a slot's copies are backed by a copy you actually own — the
   * green "this is your card" badge. Always 0 for a slot that doesn't name one
   * physical copy (a brew line, a lands-box basic), and 0 for a claim that lost
   * the copy to a newer one.
   */
  allocated(slotId: string): number;
  /** Every copy filed in more places than you own, card name order not applied
   *  (the resolver sorts once it has the names). */
  conflicts: FilingConflict[];
}

const NONE: PlacementInfo = { places: [], claimed: 0, owned: 0, over: false };

const KIND_ORDER: Record<ContainerKind, number> = { deck: 0, binder: 1, box: 2 };

/** A filed slot: where it is, plus what it asks of the copy filling it.
 *  `backed` is per container, not per slot — it's added when slots are merged. */
interface Slot extends Omit<Placement, 'backed'> {
  id: string;
  /** The edition it pins; undefined = any (a slot added by name). */
  scryfallId?: string;
  prefs: CopyPrefs;
  /** The one physical copy this slot names, when it names one at all. */
  claimKey?: string;
  updatedAt: number;
}

/** Supply and demand for one physical copy (printing + finish + condition + lang). */
interface Claim {
  owned: number;
  claimed: number;
  /** The slots asking for it, so a conflict can list the containers involved. */
  slots: Slot[];
}

interface OraclePlacements {
  slots: Slot[];
  /** Keyed by claim key; only copies some slot actually names appear here. */
  claims: Map<string, Claim>;
  /** Merged answers per question asked — a list view asks the same one per row. */
  cache: Map<string, PlacementInfo>;
}

// One card can sit in several boards of one deck (main + sideboard), or in one
// deck twice under different editions; merge those into a single placement so a
// badge counts containers, not slots.
function mergeByContainer(slots: Slot[], allocated: Map<string, number>): Placement[] {
  const merged = new Map<string, Placement>();
  for (const s of slots) {
    const backed = allocated.get(s.id) ?? 0;
    const cur = merged.get(s.containerId);
    if (cur) {
      cur.quantity += s.quantity;
      cur.backed += backed;
    } else
      merged.set(s.containerId, {
        containerId: s.containerId,
        kind: s.kind,
        name: s.name,
        quantity: s.quantity,
        board: s.board,
        backed,
      });
  }
  return [...merged.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}

/**
 * Just how many copies are filed in more places than you own — the notification
 * bell's dot. The bell lives in the header on every screen, so this deliberately
 * skips the full placement index: two table reads plus the container *ids* (an
 * index-only scan) instead of joining every slot to its container.
 */
export function useFilingConflictCount(): number {
  return (
    useLiveQuery(async () => {
      const [slots, entries, containerIds] = await Promise.all([
        db.deckCards.toArray(),
        db.collection.toArray(),
        db.decks.toCollection().primaryKeys(),
      ]);
      const live = new Set(containerIds);
      const owned = new Map<string, number>();
      for (const e of entries) {
        const k = collectionKey(e);
        owned.set(k, (owned.get(k) ?? 0) + e.quantity);
      }
      const claimed = new Map<string, number>();
      for (const s of slots) {
        const k = claimKeyOf(s);
        // Skip slots orphaned by a container delete that hasn't synced yet — the
        // placement index ignores them too, so a phantom dot would never resolve.
        if (!k || !live.has(s.deckId)) continue;
        claimed.set(k, (claimed.get(k) ?? 0) + s.quantity);
      }
      let n = 0;
      claimed.forEach((c, k) => {
        if (c > (owned.get(k) ?? 0)) n++;
      });
      return n;
    }, []) ?? 0
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
    // Copies owned, per physical-copy identity. Entries are unique on that key,
    // so this is one row each — summed anyway to be safe.
    const ownedByCopy = new Map<string, number>();
    for (const e of data.entries) {
      const k = collectionKey(e);
      ownedByCopy.set(k, (ownedByCopy.get(k) ?? 0) + e.quantity);
    }

    // Raw slots bucketed per oracle card, each keeping the edition and the traits
    // it asks for; the filtering happens per question at lookup time.
    const byOracle = new Map<string, Slot[]>();
    const claiming: Slot[] = [];
    for (const s of data.slots) {
      // An "any printing" basic promises nothing about your shelves: it isn't a
      // copy you own, so it neither files a card away nor over-promises one.
      if (s.anyBasic) continue;
      const container = byId.get(s.deckId);
      if (!container) continue; // orphan slot (a delete that hasn't synced yet)
      const slot: Slot = {
        id: s.id,
        containerId: container.id,
        kind: container.kind ?? 'deck',
        name: container.name,
        quantity: s.quantity,
        board: s.board,
        ...(s.scryfallId ? { scryfallId: s.scryfallId } : {}),
        prefs: { condition: s.condition, finish: s.finish, lang: s.lang },
        // Pinned all the way down = this slot is about one real card of yours.
        ...(claimKeyOf(s) ? { claimKey: claimKeyOf(s) } : {}),
        updatedAt: s.updatedAt,
      };
      if (slot.claimKey) claiming.push(slot);
      const arr = byOracle.get(s.oracleId);
      if (arr) arr.push(slot);
      else byOracle.set(s.oracleId, [slot]);
    }

    // Hand the copies out, newest claim first: the deck you just filed the card
    // into gets it, the one you took it out of goes wanting. Ties break on id so
    // the answer never flickers between renders.
    const allocated = new Map<string, number>();
    const unspoken = new Map(ownedByCopy);
    for (const s of [...claiming].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))) {
      const left = unspoken.get(s.claimKey!) ?? 0;
      const take = Math.min(left, s.quantity);
      if (take > 0) unspoken.set(s.claimKey!, left - take);
      allocated.set(s.id, take);
    }

    const infos = new Map<string, OraclePlacements>();
    const conflicts: FilingConflict[] = [];
    byOracle.forEach((slots, oracleId) => {
      const claims = new Map<string, Claim>();
      for (const s of slots) {
        if (!s.claimKey) continue;
        const c = claims.get(s.claimKey);
        if (c) {
          c.claimed += s.quantity;
          c.slots.push(s);
        } else claims.set(s.claimKey, { owned: ownedByCopy.get(s.claimKey) ?? 0, claimed: s.quantity, slots: [s] });
      }
      infos.set(oracleId, { slots, claims, cache: new Map() });
      // A pinned slot knows all four traits, so any of its slots can spell the
      // copy out for the resolver.
      claims.forEach((c) => {
        if (c.claimed <= c.owned) return;
        const s = c.slots[0]!;
        conflicts.push({
          oracleId,
          scryfallId: s.scryfallId!,
          condition: s.prefs.condition!,
          finish: s.prefs.finish!,
          lang: s.prefs.lang!,
          owned: c.owned,
          claimed: c.claimed,
          places: mergeByContainer(c.slots, allocated),
        });
      });
    });

    return {
      lookup(oracleId: string, scryfallId?: string | null, copy?: CopyPrefs) {
        const g = infos.get(oracleId);
        if (!g) return NONE;
        const key = `${scryfallId ?? ''}|${copy?.finish ?? ''}|${copy?.lang ?? ''}|${copy?.condition ?? ''}`;
        let info = g.cache.get(key);
        if (!info) {
          const matched = g.slots.filter(
            (s) =>
              (!scryfallId || !s.scryfallId || s.scryfallId === scryfallId) &&
              (!copy || prefsCompatible(s.prefs, copy)),
          );
          // The ⚠ is about one piece of cardboard, so it counts the copies the
          // matched slots actually name. A question loose enough to touch several
          // copies at once (a search hit, which knows a printing but no traits)
          // reports the ones in conflict, so "3 claimed / 2 owned" is always a
          // true sentence about the same set of cards.
          const keys = [...new Set(matched.map((s) => s.claimKey).filter((k): k is string => !!k))];
          const over = keys.filter((k) => {
            const c = g.claims.get(k)!;
            return c.claimed > c.owned;
          });
          const counted = over.length > 0 ? over : keys;
          let claimed = 0;
          let owned = 0;
          for (const k of counted) {
            const c = g.claims.get(k)!;
            claimed += c.claimed;
            owned += c.owned;
          }
          info = { places: mergeByContainer(matched, allocated), claimed, owned, over: over.length > 0 };
          g.cache.set(key, info);
        }
        return info;
      },
      allocated(slotId: string) {
        return allocated.get(slotId) ?? 0;
      },
      conflicts,
    };
  }, [data]);
}
