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

/** 'commander' is the command zone: counts toward Commander's 100, sets the color identity. */
export type DeckBoard = 'main' | 'side' | 'commander';

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

/**
 * A single wishlist line shared during a trade (for wishlist⇄tradelist match
 * highlighting). Self-contained (carries name) like TradeLine.
 */
export interface WishLine {
  oracleId: string;
  /** null = "any printing". */
  scryfallId: string | null;
  name: string;
  quantity: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

/**
 * Compact price history for one collection printing (every printing in the
 * collection is tracked automatically): one row per card, not one per
 * card-day. `eur[i]`/`usd[i]` are integer cents for the day `startDay + i`
 * (UTC); days with no reading (app not opened, no price) are null. A few bytes
 * per card per day, so tracking a whole collection stays ~20 MB/year instead
 * of ~1 GB with row-per-day snapshot objects.
 */
export interface PriceHistory {
  scryfallId: string;
  startDay: string; // YYYY-MM-DD (UTC) of index 0
  eur: (number | null)[]; // integer cents per day
  usd: (number | null)[]; // integer cents per day; same length as eur
}
