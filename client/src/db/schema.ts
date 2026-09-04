import Dexie, { type Table } from 'dexie';
import type {
  OracleCard,
  Printing,
  CollectionEntry,
  WishlistEntry,
  Deck,
  DeckCard,
  DeckFolder,
  Trade,
  Setting,
  PriceHistory,
  PriceShard,
  SealedItem,
  SealedPriceHistory,
  SyncChange,
  UserEvent,
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
  /** Unopened sealed products (booster boxes, precons still in shrink). */
  sealedItems!: Table<SealedItem, string>;
  wishlist!: Table<WishlistEntry, string>;
  decks!: Table<Deck, string>;
  deckCards!: Table<DeckCard, string>;
  deckFolders!: Table<DeckFolder, string>;
  trades!: Table<Trade, string>;
  settings!: Table<Setting, string>;
  priceHistories!: Table<PriceHistory, string>;
  /** Daily price readings for the unopened products on the shelf, by productId. */
  sealedPriceHistories!: Table<SealedPriceHistory, string>;
  priceShards!: Table<PriceShard, string>;
  events!: Table<UserEvent, string>;
  outbox!: Table<SyncChange, [string, string]>;
  scanData!: Table<import('../scan/store.js').ScanDataRow, string>;
  /** Lazily-fetched sealed catalog and its price map (rows 'current' and 'prices'). */
  sealed!: Table<import('../sealed/store.js').SealedRow, string>;
  setTypes!: Table<import('../cardDb/setTypes.js').SetTypesRow, string>;
  /** Lazily-fetched oracle-tag vocabulary for `otag:` search (row 'current'). */
  oracleTags!: Table<import('../cardDb/oracleTags.js').OracleTagsRow, string>;

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

    // v7 (sync + history plan): the event log and the sync outbox.
    //  - events: append-mostly per-card history (History tab). Backfilled with
    //    one collection.add per existing entry (ts = createdAt, price unknown)
    //    and one wish.add per wishlist line, so every card has a timeline
    //    anchor and an editable acquisition price.
    //  - outbox: latest pending SyncChange per (tbl, rowId), drained by the
    //    sync engine when signed in; harmless bookkeeping when signed out.
    //  - wishlist/deckCards rows gain updatedAt (the LWW comparator).
    this.version(7)
      .stores({
        events: 'id, ts, oracleId, kind',
        outbox: '[tbl+rowId]',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const events: UserEvent[] = [];

        await tx
          .table('wishlist')
          .toCollection()
          .modify((w: WishlistEntry) => {
            if (typeof w.updatedAt !== 'number') w.updatedAt = w.createdAt;
            events.push({
              id: crypto.randomUUID(),
              ts: w.createdAt,
              updatedAt: w.createdAt,
              kind: 'wish.add',
              oracleId: w.oracleId,
              scryfallId: w.scryfallId,
              qty: w.quantity,
            });
          });

        await tx
          .table('deckCards')
          .toCollection()
          .modify((c: DeckCard) => {
            if (typeof c.updatedAt !== 'number') c.updatedAt = now;
          });

        const entries: CollectionEntry[] = await tx.table('collection').toArray();
        for (const e of entries) {
          events.push({
            id: crypto.randomUUID(),
            ts: e.createdAt,
            updatedAt: e.createdAt,
            kind: 'collection.add',
            oracleId: e.oracleId,
            scryfallId: e.scryfallId,
            qty: e.quantity,
            condition: e.condition,
            finish: e.finish,
            lang: e.lang,
            priceEurCents: null,
          });
        }

        if (events.length) await tx.table('events').bulkAdd(events);
      });

    // v8 (card scanning S2): the downloaded art-hash blob, one row keyed by
    // 'current' (replaced wholesale when the scan-data beacon bumps).
    this.version(8).stores({ scanData: 'key' });

    // v9 (sealed products): the lazily-downloaded sealed-product catalog, one
    // row keyed 'current' (replaced when the manifest's sealed hash moves).
    this.version(9).stores({ sealed: 'key' });

    // v10: index events by batchId/tradeId. undo and grouped-history lookups
    // matched these with a full-table filter(); as the append-only events table
    // grows (one row per mutation, forever) that scan gets linearly slower.
    // Both fields are optional, so the indexes are sparse (rows without them are
    // simply absent from the index) — no upgrade callback needed.
    this.version(10).stores({
      events: 'id, ts, oracleId, kind, batchId, tradeId',
    });

    // v11: index events by deckId. A container's own history panel asks for
    // "every event for this deck", which otherwise walks the whole log every
    // time a deck page opens. Sparse like batchId/tradeId (only slot events
    // carry a deckId), so no upgrade callback is needed.
    this.version(11).stores({
      events: 'id, ts, oracleId, kind, batchId, tradeId, deckId',
    });

    // v12 (printing preferences): set code → set_type, one lazily-fetched row
    // keyed 'current' like scanData/sealed. Lets the client tell a normal
    // release from a promo product without bloating every printing row.
    this.version(12).stores({ setTypes: 'key' });

    // v13 (deck folders): decks gain an optional folderId, indexed so opening a
    // folder doesn't scan every deck (sparse — rows without it are simply
    // absent from the index, no upgrade callback needed). Folders get their
    // own table, synced like decks.
    this.version(13).stores({
      decks: 'id, name, updatedAt, folderId',
      deckFolders: 'id, name, updatedAt',
    });

    // v14 (unopened sealed products): a booster box you own has no oracleId and
    // no scryfallId, so it cannot be a collection row — every card join, sort,
    // price history and mover flag in the app assumes those exist. It gets its
    // own table instead, synced like any other user data. Indexed by productId
    // so "how many of this box do I own?" is a lookup, not a scan.
    this.version(14).stores({ sealedItems: 'id, productId, updatedAt' });

    // v15 (sealed value tracking): a box gains and loses value like a card, so
    // it gets the same compact daily readings — keyed by productId, because the
    // sealed price map is, and a box has no scryfallId. Separate from
    // priceHistories rather than sharing it: every reader of that table joins
    // its key against the card DB.
    this.version(15).stores({ sealedPriceHistories: 'productId' });

    // v16: the Scryfall Tagger oracle-tag vocabulary behind `otag:` search.
    // One row, same lazy-fetch-and-cache shape as setTypes.
    this.version(16).stores({ oracleTags: 'key' });
  }
}

export const db = new MtgDatabase();

/**
 * The user-data tables — the set serialized by device transfer and wiped by
 * "delete all my data". Card DB (oracleCards/printings/priceShards), settings,
 * and the sync outbox are deliberately not included. Keep in sync with
 * TransferPayload.
 */
export const USER_DATA_TABLES = [
  db.collection,
  db.sealedItems,
  db.wishlist,
  db.decks,
  db.deckCards,
  db.deckFolders,
  db.trades,
  db.priceHistories,
  db.sealedPriceHistories,
  db.events,
];
