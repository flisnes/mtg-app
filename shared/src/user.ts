// User data types. Stored locally in IndexedDB (Dexie). Never leaves the device
// except as the opaque TradeLine[] exchanged during a trade session.
//
// Invariants (enforced in the data-access layer, not the UI — beta plan §4):
//  - The tradelist is NOT a separate table: it is `quantityForTrade > 0` on a
//    CollectionEntry, with `quantityForTrade <= quantity`.
//  - Collection entries are unique on (scryfallId, condition, finish, lang);
//    adding a duplicate increments quantity.
//  - "Owned" (for deck checkmarks) = sum of quantity over all CollectionEntry
//    with a matching oracleId (any printing counts).

import type { Finish, Format } from './card.js';

export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export const CONDITIONS: readonly Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const FINISHES: readonly Finish[] = ['nonfoil', 'foil', 'etched'];

export interface CollectionEntry {
  id: string;
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity: number;
  /** 0..quantity — this IS the tradelist. */
  quantityForTrade: number;
  createdAt: number;
  updatedAt: number;
}

export interface WishlistEntry {
  id: string;
  oracleId: string;
  /** null = "any printing". */
  scryfallId: string | null;
  quantity: number;
  createdAt: number;
}

export type DeckBoard = 'main' | 'side';

/** A deck's format; 'casual' means no legality checks. */
export type DeckFormat = Format | 'casual';

export const DECK_FORMATS: readonly DeckFormat[] = [
  'casual',
  'standard',
  'pioneer',
  'modern',
  'legacy',
  'vintage',
  'pauper',
  'commander',
];

export interface Deck {
  id: string;
  name: string;
  /** Missing on decks created before formats existed → treat as 'casual'. */
  format?: DeckFormat;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeckCard {
  id: string;
  deckId: string;
  oracleId: string;
  quantity: number;
  board: DeckBoard;
}

/** A completed local trade record. `partner` is reserved for future accounts; UI renders "Other User". */
export interface Trade {
  id: string;
  completedAt: number;
  partner: null;
  given: TradeLine[];
  received: TradeLine[];
}

/** A single card line inside an offer. Self-contained (carries name) so history renders without the card DB. */
export interface TradeLine {
  oracleId: string;
  scryfallId: string;
  name: string;
  quantity: number;
  condition: Condition;
  finish: Finish;
  lang: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

/** A printing whose price the user is tracking. */
export interface WatchedCard {
  scryfallId: string;
  oracleId: string;
  createdAt: number;
}

/** A recorded price point, captured when the app opens (deduped per day). */
export interface PriceSnapshot {
  id: string;
  scryfallId: string;
  at: number; // ms timestamp
  day: string; // YYYY-MM-DD, dedupe key
  eur: number | null;
  usd: number | null;
}
