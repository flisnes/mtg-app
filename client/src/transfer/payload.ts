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
  type PriceHistory,
  type Trade,
  type WishlistEntry,
} from '@mtg/shared';
import { collectionKey } from '../db/dataAccess.js';
import { db, USER_DATA_TABLES } from '../db/schema.js';
import { recordDay, toCents } from '../price/history.js';
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
  priceHistories: PriceHistory[];
}

/** What a received payload contains, for the receiver's confirm screen. */
export interface TransferCounts {
  cards: number;
  collectionEntries: number;
  wishlist: number;
  decks: number;
  trades: number;
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
      priceHistories: await db.priceHistories.toArray(),
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
  priceHistories: 100_000,
  priceSnapshots: 500_000, // legacy row-per-day senders only
} as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ~11 years of daily readings per card. */
const MAX_HISTORY_DAYS = 4000;

/** Stored price value: integer cents, bounded; anything unparseable → null. */
function cents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(10_000_000, Math.max(0, Math.round(n))) : null;
}

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

  // Price history: one compact row per card, unique on scryfallId. Arrays are
  // length-capped, forced to equal length, and every element re-bounded.
  const priceHistories: PriceHistory[] = [];
  const histIds = new Set<string>();
  for (const r of rows(p.priceHistories, CAPS.priceHistories)) {
    const scryfallId = id(r.scryfallId);
    const startDay = typeof r.startDay === 'string' && DAY_RE.test(r.startDay) ? r.startDay : null;
    if (!scryfallId || !startDay || histIds.has(scryfallId)) continue;
    const eurRaw = Array.isArray(r.eur) ? r.eur.slice(0, MAX_HISTORY_DAYS) : [];
    const usdRaw = Array.isArray(r.usd) ? r.usd.slice(0, MAX_HISTORY_DAYS) : [];
    const len = Math.max(eurRaw.length, usdRaw.length);
    if (!len) continue;
    histIds.add(scryfallId);
    priceHistories.push({
      scryfallId,
      startDay,
      eur: Array.from({ length: len }, (_, i) => cents(eurRaw[i])),
      usd: Array.from({ length: len }, (_, i) => cents(usdRaw[i])),
    });
  }

  // Legacy senders (pre-compact history) ship row-per-day priceSnapshots
  // instead; fold them into histories so upgrading via transfer loses nothing.
  if (!priceHistories.length && Array.isArray(p.priceSnapshots)) {
    const byCard = new Map<string, { day: string; eur: number | null; usd: number | null }[]>();
    for (const r of rows(p.priceSnapshots, CAPS.priceSnapshots)) {
      const scryfallId = id(r.scryfallId);
      const day = typeof r.day === 'string' && DAY_RE.test(r.day) ? r.day : null;
      if (!scryfallId || !day) continue;
      const snap = {
        day,
        eur: toCents(typeof r.eur === 'number' ? r.eur : null),
        usd: toCents(typeof r.usd === 'number' ? r.usd : null),
      };
      const arr = byCard.get(scryfallId);
      if (arr) arr.push(snap);
      else byCard.set(scryfallId, [snap]);
    }
    byCard.forEach((list, scryfallId) => {
      if (priceHistories.length >= CAPS.priceHistories) return;
      list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      const first = list[0]!;
      const h: PriceHistory = { scryfallId, startDay: first.day, eur: [first.eur], usd: [first.usd] };
      for (let i = 1; i < list.length; i++) recordDay(h, list[i]!.day, list[i]!.eur, list[i]!.usd);
      priceHistories.push(h);
    });
  }

  // Legacy senders also include a `watchlist` table; it's obsolete (the whole
  // collection is tracked automatically) and simply ignored.

  return { version: PAYLOAD_VERSION, collection, wishlist, decks, deckCards, trades, priceHistories };
}
