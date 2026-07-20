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
  updatedAt: number;
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
  /** Preferred printing for display (image/price). Undefined = the card's default printing. */
  scryfallId?: string;
  quantity: number;
  board: DeckBoard;
  updatedAt: number;
}

/**
 * A completed local trade record. `partner` is the other side's account
 * username when both parties were signed in and shared identities during the
 * session; null = anonymous ("Other User").
 */
export interface Trade {
  id: string;
  completedAt: number;
  partner: string | null;
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

// ---------------------------------------------------------------------------
// Event log: an append-mostly per-user history of what happened to the
// collection. Powers the card History tab ("owned since", value while owned,
// decks tried, wishlist journey). Events are emitted by the device where the
// change originates; sync copies them verbatim. Only the user-editable fields
// (priceEurCents, reason) ever change after emission — updatedAt is the
// last-write-wins comparator for those edits.
// ---------------------------------------------------------------------------

/** Why copies left the collection. Removals default to 'sold'; user-editable. */
export type RemovalReason = 'sold' | 'traded' | 'lost' | 'other';

export const REMOVAL_REASONS: readonly RemovalReason[] = ['sold', 'traded', 'lost', 'other'];

export type UserEventKind =
  | 'collection.add'
  | 'collection.remove'
  | 'deck.add'
  | 'deck.remove'
  | 'wish.add'
  | 'wish.fulfilled'
  | 'wish.remove';

export const USER_EVENT_KINDS: readonly UserEventKind[] = [
  'collection.add',
  'collection.remove',
  'deck.add',
  'deck.remove',
  'wish.add',
  'wish.fulfilled',
  'wish.remove',
];

/**
 * How a change was made. Distinguishes an ordinary edit from a bulk import, a
 * sealed-product add, a trade, or a scan — the edit-history view uses it to
 * pick the row's icon and to group the lines of one operation into a single
 * entry. Absent on pre-feature events (they render as 'manual').
 */
export type EventSource = 'manual' | 'import' | 'sealed' | 'trade' | 'scan';

export interface UserEvent {
  id: string;
  /** When it happened (ms epoch). */
  ts: number;
  /** LWW comparator; equals ts until the user edits price/reason. */
  updatedAt: number;
  kind: UserEventKind;
  oracleId: string;
  /** Printing involved; null on "any printing" wish events. */
  scryfallId?: string | null;
  /** Copies involved (always positive; the kind carries the direction). */
  qty?: number;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  /**
   * Market price per copy in EUR cents at event time (collection.add =
   * acquisition price, collection.remove = exit price). null = unknown at the
   * time. User-editable afterwards.
   */
  priceEurCents?: number | null;
  /** collection.remove only. */
  reason?: RemovalReason;
  deckId?: string;
  /** Denormalized so history still renders after the deck is deleted. */
  deckName?: string;
  board?: DeckBoard;
  /** Trade session id for trade-driven changes (also the grouping key). */
  tradeId?: string;
  /** How the change was made; drives the edit-history icon + grouping. */
  source?: EventSource;
  /** Groups the events of one bulk operation (an import or sealed add). */
  batchId?: string;
  /** Human label for a batch (e.g. the sealed product's name). */
  batchLabel?: string;
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
