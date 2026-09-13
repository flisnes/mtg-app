import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry, OracleCard } from '@mtg/shared';
import type { OwnedSource } from '../deck/manaFixes.js';
import type { PlacementIndex } from './usePlacements.js';
import { db } from './schema.js';

// The collection half of the mana-fix panel: every card you own that makes
// mana, with where its copies are and how many of them no deck is using.
//
// Gated rather than always-on. It reads the whole collection and then the
// oracle row of every distinct card in it, which is a chunk of work to do for a
// deck whose mana is already fine — so the panel asks for it only once the
// colored-source report has actually found a hole.

interface OwnedCard {
  oracle: OracleCard;
  entries: CollectionEntry[];
}

/**
 * Mana sources you own, scored against one deck: `inDecks` counts the copies
 * some *other* deck is holding, and the copies come back with the unspoken-for
 * ones first, so a fix files cardboard that is actually spare.
 *
 * Binders and boxes are storage, not use. A card in a trade binder is free to
 * go in a deck; a card in another deck is that deck's card.
 */
export function useOwnedSources(
  deckId: string,
  placements: PlacementIndex | undefined,
  enabled: boolean,
): OwnedSource[] | undefined {
  const owned = useLiveQuery(async (): Promise<OwnedCard[] | undefined> => {
    if (!enabled) return undefined;
    const byOracle = new Map<string, CollectionEntry[]>();
    for (const e of await db.collection.toArray()) {
      if (e.quantity <= 0) continue;
      const list = byOracle.get(e.oracleId);
      if (list) list.push(e);
      else byOracle.set(e.oracleId, [e]);
    }
    const cards = await db.oracleCards.bulkGet([...byOracle.keys()]);
    const out: OwnedCard[] = [];
    // `mana` or `fetch` is the whole filter: everything else in the collection
    // is a spell, and a spell is not a fix for a colored-source count.
    for (const c of cards) {
      if (c && (c.mana || c.fetch)) out.push({ oracle: c, entries: byOracle.get(c.oracleId)! });
    }
    return out;
  }, [enabled]);

  return useMemo(() => {
    if (!owned) return undefined;
    return owned.map(({ oracle, entries }) => {
      const places = placements?.lookup(oracle.oracleId).places ?? [];
      const elsewhere = places.filter((p) => p.kind === 'deck' && p.containerId !== deckId);
      // Which *printing* another deck holds is a question the placement index
      // can only answer for a slot that pins one; a decklist line added by name
      // matches every copy you own. So the count is taken per card, where it is
      // exact, and used only to order the copies a fix would file.
      const taken = (e: CollectionEntry) =>
        (placements?.lookup(oracle.oracleId, e.scryfallId, e).places ?? []).some(
          (p) => p.kind === 'deck' && p.containerId !== deckId,
        );
      const copies = [...entries]
        .sort((a, b) => Number(taken(a)) - Number(taken(b)) || b.quantity - a.quantity)
        .map((e) => ({
          scryfallId: e.scryfallId,
          condition: e.condition,
          finish: e.finish,
          lang: e.lang,
          quantity: e.quantity,
        }));
      return {
        oracle,
        owned: entries.reduce((n, e) => n + e.quantity, 0),
        inDecks: elsewhere.reduce((n, p) => n + p.quantity, 0),
        inDeckNames: [...elsewhere].sort((a, b) => b.quantity - a.quantity).map((p) => p.name),
        where: places
          .filter((p) => p.kind !== 'deck')
          .map((p) => ({ name: p.name, kind: p.kind, quantity: p.quantity }))
          .sort((a, b) => b.quantity - a.quantity),
        copies,
      };
    });
  }, [owned, placements, deckId]);
}
