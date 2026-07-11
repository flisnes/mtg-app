import {
  CONDITIONS,
  DECK_FORMATS,
  FINISHES,
  type CollectionEntry,
  type Condition,
  type Deck,
  type DeckBoard,
  type DeckCard,
  type DeckFormat,
  type Finish,
  type PriceSnapshot,
  type Trade,
  type WatchedCard,
  type WishlistEntry,
} from '@mtg/shared';
import { collectionKey } from '../db/dataAccess.js';
import { db, USER_DATA_TABLES } from '../db/schema.js';
import { sanitizeOffer } from '../trade/validate.js';

// Device-transfer payload: every user-data table, serialized on the sending
// device and re-validated on the receiving one. The card DB is NOT included —
// the receiving device has its own; user rows reference cards by id only.
//
// The sending peer is untrusted (no auth on the relay), so — like trade offers
// (trade/validate.ts) — every row is sanitized before it touches Dexie: ids
// required and bounded, enums enforced, quantities clamped, cross-table
// references (deckCards → decks) checked, duplicates merged or dropped.

export const PAYLOAD_VERSION = 1;

export interface TransferPayload {
  version: typeof PAYLOAD_VERSION;
  collection: CollectionEntry[];
  wishlist: WishlistEntry[];
  decks: Deck[];
  deckCards: DeckCard[];
  trades: Trade[];
  watchlist: WatchedCard[];
  priceSnapshots: PriceSnapshot[];
}

/** What a received payload contains, for the receiver's confirm screen. */
export interface TransferCounts {
  cards: number;
  collectionEntries: number;
  wishlist: number;
  decks: number;
  trades: number;
  watchedCards: number;
}

/** Snapshot every user-data table (the same set deleteAllUserData clears). */
export async function exportUserData(): Promise<TransferPayload> {
  return db.transaction(
    'r',
    USER_DATA_TABLES,
    async () => ({
      version: PAYLOAD_VERSION,
      collection: await db.collection.toArray(),
      wishlist: await db.wishlist.toArray(),
      decks: await db.decks.toArray(),
      deckCards: await db.deckCards.toArray(),
      trades: await db.trades.toArray(),
      watchlist: await db.watchlist.toArray(),
      priceSnapshots: await db.priceSnapshots.toArray(),
    }),
  );
}

export function countsOf(p: TransferPayload): TransferCounts {
  return {
    cards: p.collection.reduce((sum, e) => sum + e.quantity, 0),
    collectionEntries: p.collection.length,
    wishlist: p.wishlist.length,
    decks: p.decks.length,
    trades: p.trades.length,
    watchedCards: p.watchlist.length,
  };
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const CONDS = new Set<string>(CONDITIONS);
const FINS = new Set<string>(FINISHES);
const FORMATS = new Set<string>(DECK_FORMATS);
const BOARDS = new Set<string>(['main', 'side', 'commander']);

const MAX_ID = 64;
const MAX_QTY = 9999;

// Belt-and-braces row caps per table; the chunk limit already bounds the
// payload to ~30 MB, these keep any single table from hogging it.
const CAPS = {
  collection: 200_000,
  wishlist: 20_000,
  decks: 2_000,
  deckCards: 200_000,
  trades: 10_000,
  watchlist: 100_000,
  priceSnapshots: 500_000,
} as const;

function id(v: unknown): string | null {
  return typeof v === 'string' && v ? v.slice(0, MAX_ID) : null;
}

function qty(v: unknown, min = 1): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_QTY, Math.max(min, n)) : min;
}

function ts(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function rows(v: unknown, cap: number): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, cap).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

/**
 * Validate a received payload. Returns null only if the envelope itself is not
 * a payload; individually bad rows are dropped, duplicates merged.
 */
export function sanitizeTransferPayload(raw: unknown): TransferPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.version !== PAYLOAD_VERSION) return null;

  // Collection: unique on id and on (scryfallId, condition, finish, lang);
  // key collisions merge quantities, same invariant as applyImport.
  const seenIds = new Set<string>();
  const byKey = new Map<string, CollectionEntry>();
  for (const r of rows(p.collection, CAPS.collection)) {
    const entryId = id(r.id);
    const oracleId = id(r.oracleId);
    const scryfallId = id(r.scryfallId);
    if (!entryId || !oracleId || !scryfallId || seenIds.has(entryId)) continue;
    seenIds.add(entryId);
    const quantity = qty(r.quantity);
    const entry: CollectionEntry = {
      id: entryId,
      oracleId,
      scryfallId,
      condition: (CONDS.has(r.condition as string) ? r.condition : 'NM') as Condition,
      finish: (FINS.has(r.finish as string) ? r.finish : 'nonfoil') as Finish,
      lang: typeof r.lang === 'string' && r.lang ? r.lang.slice(0, 10) : 'en',
      quantity,
      quantityForTrade: Math.min(qty(r.quantityForTrade, 0), quantity),
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    };
    const key = collectionKey(entry);
    const ex = byKey.get(key);
    if (ex) {
      ex.quantity = Math.min(MAX_QTY, ex.quantity + entry.quantity);
      ex.quantityForTrade = Math.min(ex.quantityForTrade + entry.quantityForTrade, ex.quantity);
    } else {
      byKey.set(key, entry);
    }
  }
  const collection = [...byKey.values()];

  // Wishlist: unique on id and (oracleId, scryfallId).
  const wishlist: WishlistEntry[] = [];
  const wishIds = new Set<string>();
  const wishKeys = new Set<string>();
  for (const r of rows(p.wishlist, CAPS.wishlist)) {
    const entryId = id(r.id);
    const oracleId = id(r.oracleId);
    if (!entryId || !oracleId || wishIds.has(entryId)) continue;
    const scryfallId = typeof r.scryfallId === 'string' && r.scryfallId ? r.scryfallId.slice(0, MAX_ID) : null;
    const key = `${oracleId}|${scryfallId ?? ''}`;
    if (wishKeys.has(key)) continue;
    wishIds.add(entryId);
    wishKeys.add(key);
    wishlist.push({ id: entryId, oracleId, scryfallId, quantity: qty(r.quantity), createdAt: ts(r.createdAt) });
  }

  // Decks, then deck cards restricted to surviving decks.
  const decks: Deck[] = [];
  const deckIds = new Set<string>();
  for (const r of rows(p.decks, CAPS.decks)) {
    const deckId = id(r.id);
    if (!deckId || deckIds.has(deckId)) continue;
    deckIds.add(deckId);
    decks.push({
      id: deckId,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 200) : 'Untitled deck',
      format: (FORMATS.has(r.format as string) ? r.format : 'casual') as DeckFormat,
      ...(typeof r.description === 'string' && r.description ? { description: r.description.slice(0, 2000) } : {}),
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    });
  }

  const deckCards: DeckCard[] = [];
  const slotIds = new Set<string>();
  const slotKeys = new Map<string, DeckCard>();
  for (const r of rows(p.deckCards, CAPS.deckCards)) {
    const slotId = id(r.id);
    const deckId = id(r.deckId);
    const oracleId = id(r.oracleId);
    if (!slotId || !deckId || !oracleId || slotIds.has(slotId) || !deckIds.has(deckId)) continue;
    slotIds.add(slotId);
    const board = (BOARDS.has(r.board as string) ? r.board : 'main') as DeckBoard;
    const key = `${deckId}|${oracleId}|${board}`;
    const ex = slotKeys.get(key);
    if (ex) {
      ex.quantity = Math.min(MAX_QTY, ex.quantity + qty(r.quantity));
    } else {
      const slot: DeckCard = { id: slotId, deckId, oracleId, quantity: qty(r.quantity), board };
      slotKeys.set(key, slot);
      deckCards.push(slot);
    }
  }

  // Trade history: lines re-sanitized with the trade-offer sanitizer.
  const trades: Trade[] = [];
  const tradeIds = new Set<string>();
  for (const r of rows(p.trades, CAPS.trades)) {
    const tradeId = id(r.id);
    if (!tradeId || tradeIds.has(tradeId)) continue;
    tradeIds.add(tradeId);
    trades.push({
      id: tradeId,
      completedAt: ts(r.completedAt),
      partner: null,
      given: sanitizeOffer(r.given),
      received: sanitizeOffer(r.received),
    });
  }

  // Price watchlist: keyed on scryfallId.
  const watchlist: WatchedCard[] = [];
  const watchIds = new Set<string>();
  for (const r of rows(p.watchlist, CAPS.watchlist)) {
    const scryfallId = id(r.scryfallId);
    const oracleId = id(r.oracleId);
    if (!scryfallId || !oracleId || watchIds.has(scryfallId)) continue;
    watchIds.add(scryfallId);
    watchlist.push({ scryfallId, oracleId, createdAt: ts(r.createdAt) });
  }

  // Price history: unique on id and on the (scryfallId, day) dedupe key.
  const priceSnapshots: PriceSnapshot[] = [];
  const snapIds = new Set<string>();
  const snapKeys = new Set<string>();
  for (const r of rows(p.priceSnapshots, CAPS.priceSnapshots)) {
    const snapId = id(r.id);
    const scryfallId = id(r.scryfallId);
    const day = typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) ? r.day : null;
    if (!snapId || !scryfallId || !day || snapIds.has(snapId) || snapKeys.has(`${scryfallId}|${day}`)) continue;
    snapIds.add(snapId);
    snapKeys.add(`${scryfallId}|${day}`);
    priceSnapshots.push({
      id: snapId,
      scryfallId,
      at: ts(r.at),
      day,
      eur: Number.isFinite(Number(r.eur)) && r.eur !== null ? Number(r.eur) : null,
      usd: Number.isFinite(Number(r.usd)) && r.usd !== null ? Number(r.usd) : null,
    });
  }

  return { version: PAYLOAD_VERSION, collection, wishlist, decks, deckCards, trades, watchlist, priceSnapshots };
}
