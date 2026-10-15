import { useLiveQuery } from 'dexie-react-hooks';
import type { DeckCard, OracleCard } from '@mtg/shared';
import { db } from './schema.js';

export interface CommandZoneCard {
  slot: DeckCard;
  card: OracleCard;
}

const NONE: CommandZoneCard[] = [];

/**
 * Who's in a deck's command zone, live: the slots (for a chosen color) paired
 * with their oracle cards. Slots whose card isn't in the card DB are dropped.
 * No deck id means an empty zone; undefined while the first read is in flight.
 */
export function useCommandZone(deckId: string | undefined): CommandZoneCard[] | undefined {
  return useLiveQuery(async () => {
    if (!deckId) return NONE;
    const slots = await db.deckCards.where('[deckId+board]').equals([deckId, 'commander']).toArray();
    if (!slots.length) return NONE;
    const cards = await db.oracleCards.bulkGet(slots.map((s) => s.oracleId));
    return slots.flatMap((slot, i) => {
      const card = cards[i];
      return card ? [{ slot, card }] : [];
    });
  }, [deckId]);
}
