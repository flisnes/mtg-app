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
  PriceHistory,
  PriceShard,
} from '@mtg/shared';
import { recordDay, toCents } from '../price/history.js';

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
  priceHistories!: Table<PriceHistory, string>;
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

    // v4: compact price history — one row per watched card (cents indexed by
    // day offset) instead of one indexed snapshot object per card-day, so
    // watching a whole collection costs ~20 MB/year instead of ~1 GB.
    // Existing snapshots are folded into histories here; v5 drops the table
    // (a table can only be deleted in a version after the one that reads it).
    this.version(4)
      .stores({ priceHistories: 'scryfallId' })
      .upgrade(async (tx) => {
        const snaps: { scryfallId: string; day: string; eur: number | null; usd: number | null }[] =
          await tx.table('priceSnapshots').toArray();
        const byCard = new Map<string, typeof snaps>();
        for (const s of snaps) {
          const arr = byCard.get(s.scryfallId);
          if (arr) arr.push(s);
          else byCard.set(s.scryfallId, [s]);
        }
        const histories: PriceHistory[] = [];
        byCard.forEach((list, scryfallId) => {
          list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
          const first = list[0]!;
          const h: PriceHistory = { scryfallId, startDay: first.day, eur: [toCents(first.eur)], usd: [toCents(first.usd)] };
          for (let i = 1; i < list.length; i++) {
            const s = list[i]!;
            recordDay(h, s.day, toCents(s.eur), toCents(s.usd));
          }
          histories.push(h);
        });
        if (histories.length) await tx.table('priceHistories').bulkAdd(histories);
      });

    // v5: row-per-day snapshots are gone (migrated in v4).
    this.version(5).stores({ priceSnapshots: null });

    // v6: the whole collection is tracked automatically, so the manual
    // watchlist is gone. Histories of unowned cards are pruned at runtime
    // by recordCollectionPrices, not here.
    this.version(6).stores({ watchlist: null });
  }
}

export const db = new MtgDatabase();

/**
 * The user-data tables — the set serialized by device transfer and wiped by
 * "delete all my data". Card DB (oracleCards/printings/priceShards) and
 * settings are deliberately not included. Keep in sync with TransferPayload.
 */
export const USER_DATA_TABLES = [
  db.collection,
  db.wishlist,
  db.decks,
  db.deckCards,
  db.trades,
  db.priceHistories,
];
