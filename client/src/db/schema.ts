import Dexie, { type Table } from 'dexie';
import type {
  OracleCard,
  Printing,
  CollectionEntry,
  WishlistEntry,
  Deck,
  DeckCard,
  Trade,
  Setting,
  WatchedCard,
  PriceSnapshot,
  PriceShard,
} from '@mtg/shared';

// Local IndexedDB store (beta plan §4). Two kinds of data live here:
//  - Card database (oracleCards, printings): read-only, replaced wholesale when
//    the card-DB version changes.
//  - User data (everything else): the only source of truth for the user's
//    collection/wishlist/decks/trade history. Never leaves the device except as
//    opaque TradeLine[] during a trade.
//
// Bump the version number and add an upgrade block for any schema change.

export class MtgDatabase extends Dexie {
  oracleCards!: Table<OracleCard, string>;
  printings!: Table<Printing, string>;
  collection!: Table<CollectionEntry, string>;
  wishlist!: Table<WishlistEntry, string>;
  decks!: Table<Deck, string>;
  deckCards!: Table<DeckCard, string>;
  trades!: Table<Trade, string>;
  settings!: Table<Setting, string>;
  watchlist!: Table<WatchedCard, string>;
  priceSnapshots!: Table<PriceSnapshot, string>;
  priceShards!: Table<PriceShard, string>;

  constructor() {
    super('mtg');

    this.version(1).stores({
      // Card DB. Indexes chosen for name-prefix search + filters (Phase 1).
      oracleCards: 'oracleId, name, rarity, *colorIdentity',
      printings: 'scryfallId, oracleId, set',

      // User data.
      // Compound index enforces the (scryfallId, condition, finish, lang)
      // uniqueness rule at the query layer (dataAccess dedups on it).
      collection: 'id, oracleId, scryfallId, quantityForTrade, [scryfallId+condition+finish+lang]',
      wishlist: 'id, oracleId, scryfallId',
      decks: 'id, name, updatedAt',
      deckCards: 'id, deckId, oracleId, [deckId+board]',
      trades: 'id, completedAt',
      settings: 'key',
    });

    // v2: price watchlist + snapshots (existing tables carry over unchanged).
    this.version(2).stores({
      watchlist: 'scryfallId, oracleId',
      priceSnapshots: 'id, scryfallId, [scryfallId+day]',
    });

    // v3: prices live in 16 shard blobs instead of on every card row, so the
    // daily price refresh writes 16 rows, not ~150k.
    this.version(3).stores({
      priceShards: 'key',
    });
  }
}

export const db = new MtgDatabase();
