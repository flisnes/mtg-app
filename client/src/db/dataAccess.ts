import type {
  CollectionEntry,
  Condition,
  Deck,
  DeckBoard,
  DeckCard,
  DeckFormat,
  Finish,
  Trade,
  TradeLine,
  WishlistEntry,
} from '@mtg/shared';
import { db, USER_DATA_TABLES } from './schema.js';
import type { TransferPayload } from '../transfer/payload.js';

// The single mutation path for user data (beta plan §4). All invariants live
// here, never in UI code, so that trade completion (Phase 4) reuses the exact
// same functions:
//   - tradelist IS quantityForTrade on a CollectionEntry (0..quantity)
//   - collection entries unique on (scryfallId, condition, finish, lang)
//   - "owned" = sum of quantity over all entries with a matching oracleId

function newId(): string {
  return crypto.randomUUID();
}

/** The uniqueness key for a collection entry (or trade line merging into one). */
export function collectionKey(e: { scryfallId: string; condition: string; finish: string; lang?: string }): string {
  return `${e.scryfallId}|${e.condition}|${e.finish}|${e.lang || 'en'}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface AddToCollectionInput {
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity?: number;
  /** If set, ensures at least this many are marked for trade after the add. */
  quantityForTrade?: number;
}

/**
 * Add copies to the collection, merging into an existing entry that matches on
 * (scryfallId, condition, finish, lang). Returns the resulting entry id.
 */
export async function addToCollection(input: AddToCollectionInput): Promise<string> {
  const qty = input.quantity ?? 1;
  const lang = input.lang || 'en';

  return db.transaction('rw', db.collection, async () => {
    const existing = await db.collection
      .where('[scryfallId+condition+finish+lang]')
      .equals([input.scryfallId, input.condition, input.finish, lang])
      .first();

    const now = Date.now();
    if (existing) {
      const quantity = existing.quantity + qty;
      const quantityForTrade = Math.max(
        existing.quantityForTrade,
        input.quantityForTrade ?? 0,
      );
      await db.collection.update(existing.id, {
        quantity,
        quantityForTrade: clamp(quantityForTrade, 0, quantity),
        updatedAt: now,
      });
      return existing.id;
    }

    const entry: CollectionEntry = {
      id: newId(),
      oracleId: input.oracleId,
      scryfallId: input.scryfallId,
      condition: input.condition,
      finish: input.finish,
      lang,
      quantity: qty,
      quantityForTrade: clamp(input.quantityForTrade ?? 0, 0, qty),
      createdAt: now,
      updatedAt: now,
    };
    await db.collection.add(entry);
    return entry.id;
  });
}

/** Patch an entry. quantityForTrade is always clamped to [0, quantity]. */
export async function updateCollectionEntry(
  id: string,
  patch: Partial<Pick<CollectionEntry, 'quantity' | 'quantityForTrade' | 'condition' | 'finish' | 'lang' | 'scryfallId'>>,
): Promise<void> {
  await db.transaction('rw', db.collection, async () => {
    const entry = await db.collection.get(id);
    if (!entry) return;
    const quantity = patch.quantity ?? entry.quantity;
    const rawForTrade = patch.quantityForTrade ?? entry.quantityForTrade;
    await db.collection.update(id, {
      ...patch,
      quantity,
      quantityForTrade: clamp(rawForTrade, 0, quantity),
      updatedAt: Date.now(),
    });
  });
}

/** Remove copies; deletes the entry when quantity hits zero. */
export async function removeFromCollection(id: string, quantity = Infinity): Promise<void> {
  await db.transaction('rw', db.collection, async () => {
    const entry = await db.collection.get(id);
    if (!entry) return;
    const remaining = entry.quantity - quantity;
    if (remaining <= 0) {
      await db.collection.delete(id);
      return;
    }
    await db.collection.update(id, {
      quantity: remaining,
      quantityForTrade: clamp(entry.quantityForTrade, 0, remaining),
      updatedAt: Date.now(),
    });
  });
}

/** Set how many of an entry are offered for trade (the tradelist). */
export async function setQuantityForTrade(id: string, quantityForTrade: number): Promise<void> {
  await updateCollectionEntry(id, { quantityForTrade });
}

/** Total copies owned of a functional card, across all printings/conditions. */
export async function getOwnedCount(oracleId: string): Promise<number> {
  const entries = await db.collection.where('oracleId').equals(oracleId).toArray();
  return entries.reduce((sum, e) => sum + e.quantity, 0);
}

export interface AddToWishlistInput {
  oracleId: string;
  /** null = "any printing". */
  scryfallId?: string | null;
  quantity?: number;
}

/** Add to the wishlist, merging by (oracleId, scryfallId). */
export async function addToWishlist(input: AddToWishlistInput): Promise<string> {
  const qty = input.quantity ?? 1;
  const scryfallId = input.scryfallId ?? null;

  return db.transaction('rw', db.wishlist, async () => {
    const candidates = await db.wishlist.where('oracleId').equals(input.oracleId).toArray();
    const existing = candidates.find((w) => w.scryfallId === scryfallId);
    if (existing) {
      await db.wishlist.update(existing.id, { quantity: existing.quantity + qty });
      return existing.id;
    }
    const entry: WishlistEntry = {
      id: newId(),
      oracleId: input.oracleId,
      scryfallId,
      quantity: qty,
      createdAt: Date.now(),
    };
    await db.wishlist.add(entry);
    return entry.id;
  });
}

/**
 * Update a wishlist line's printing and/or quantity. If the new printing
 * collides with another line for the same card, the two lines merge.
 */
export async function updateWishlistEntry(
  id: string,
  patch: { scryfallId?: string | null; quantity?: number },
): Promise<void> {
  await db.transaction('rw', db.wishlist, async () => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const scryfallId = patch.scryfallId !== undefined ? patch.scryfallId : entry.scryfallId;
    const quantity = Math.max(1, patch.quantity ?? entry.quantity);
    const candidates = await db.wishlist.where('oracleId').equals(entry.oracleId).toArray();
    const dup = candidates.find((w) => w.id !== id && w.scryfallId === scryfallId);
    if (dup) {
      await db.wishlist.update(dup.id, { quantity: dup.quantity + quantity });
      await db.wishlist.delete(id);
    } else {
      await db.wishlist.update(id, { scryfallId, quantity });
    }
  });
}

/** Decrement a wishlist entry by quantity; deletes it at zero. */
export async function removeFromWishlist(id: string, quantity = Infinity): Promise<void> {
  await db.transaction('rw', db.wishlist, async () => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const remaining = entry.quantity - quantity;
    if (remaining <= 0) {
      await db.wishlist.delete(id);
      return;
    }
    await db.wishlist.update(id, { quantity: remaining });
  });
}

export interface ImportLine {
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity: number;
  quantityForTrade: number;
}

/**
 * Apply a resolved import in a single transaction, merging into existing
 * entries on (scryfallId, condition, finish, lang). Same invariants as
 * addToCollection, but bulk (fast enough for a 1000+ card import).
 */
export async function applyImport(lines: ImportLine[]): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  await db.transaction('rw', db.collection, async () => {
    const existing = await db.collection.toArray();
    const map = new Map(existing.map((e) => [collectionKey(e), e]));
    const now = Date.now();
    const writes: CollectionEntry[] = [];

    for (const l of lines) {
      const lang = l.lang || 'en';
      const k = collectionKey({ ...l, lang });
      cards += l.quantity;
      const ex = map.get(k);
      if (ex) {
        ex.quantity += l.quantity;
        ex.quantityForTrade = clamp(Math.max(ex.quantityForTrade, l.quantityForTrade), 0, ex.quantity);
        ex.updatedAt = now;
        if (!writes.includes(ex)) writes.push(ex);
      } else {
        const entry: CollectionEntry = {
          id: newId(),
          oracleId: l.oracleId,
          scryfallId: l.scryfallId,
          condition: l.condition,
          finish: l.finish,
          lang,
          quantity: l.quantity,
          quantityForTrade: clamp(l.quantityForTrade, 0, l.quantity),
          createdAt: now,
          updatedAt: now,
        };
        map.set(k, entry);
        writes.push(entry);
      }
    }
    await db.collection.bulkPut(writes);
  });
  return { entries: lines.length, cards };
}

/** Take every card off the tradelist (quantityForTrade → 0). Returns entries changed. */
export async function clearTradelist(): Promise<number> {
  return db.collection
    .where('quantityForTrade')
    .above(0)
    .modify({ quantityForTrade: 0, updatedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Decks (beta plan §4). Deck slots reference oracle cards ("4x Lightning Bolt");
// legality checking lives in deck/legality.ts.
// ---------------------------------------------------------------------------

export async function createDeck(name: string, format: DeckFormat = 'casual'): Promise<string> {
  const now = Date.now();
  const deck: Deck = { id: newId(), name: name.trim() || 'Untitled deck', format, createdAt: now, updatedAt: now };
  await db.decks.add(deck);
  return deck.id;
}

export async function renameDeck(id: string, name: string): Promise<void> {
  await db.decks.update(id, { name: name.trim() || 'Untitled deck', updatedAt: Date.now() });
}

export async function setDeckFormat(id: string, format: DeckFormat): Promise<void> {
  await db.decks.update(id, { format, updatedAt: Date.now() });
}

export async function deleteDeck(id: string): Promise<void> {
  await db.transaction('rw', db.decks, db.deckCards, async () => {
    await db.deckCards.where('deckId').equals(id).delete();
    await db.decks.delete(id);
  });
}

export interface AddDeckCardInput {
  deckId: string;
  oracleId: string;
  /** Preferred printing for the slot; falls back to the card's default. */
  scryfallId?: string;
  quantity?: number;
  board?: DeckBoard;
}

/** Add a slot, merging into an existing (deckId, oracleId, board) slot. */
export async function addDeckCard(input: AddDeckCardInput): Promise<void> {
  const board = input.board ?? 'main';
  const quantity = input.quantity ?? 1;
  await db.transaction('rw', db.deckCards, db.decks, async () => {
    const existing = await db.deckCards
      .where('[deckId+board]')
      .equals([input.deckId, board])
      .and((c) => c.oracleId === input.oracleId)
      .first();
    if (existing) await db.deckCards.update(existing.id, { quantity: existing.quantity + quantity });
    else
      await db.deckCards.add({
        id: newId(),
        deckId: input.deckId,
        oracleId: input.oracleId,
        ...(input.scryfallId ? { scryfallId: input.scryfallId } : {}),
        quantity,
        board,
      });
    await db.decks.update(input.deckId, { updatedAt: Date.now() });
  });
}

/** Bulk-add (deck import), merging by (oracleId, board). */
export async function addDeckCardsBulk(
  deckId: string,
  cards: Array<{ oracleId: string; quantity: number; board: DeckBoard; scryfallId?: string }>,
): Promise<void> {
  await db.transaction('rw', db.deckCards, db.decks, async () => {
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    const keyOf = (c: { oracleId: string; board: DeckBoard }) => `${c.oracleId}|${c.board}`;
    const map = new Map(existing.map((c) => [keyOf(c), c]));
    const writes: DeckCard[] = [];
    for (const c of cards) {
      const ex = map.get(keyOf(c));
      if (ex) {
        ex.quantity += c.quantity;
        // Adopt the imported printing if the slot didn't already have one.
        if (!ex.scryfallId && c.scryfallId) ex.scryfallId = c.scryfallId;
        if (!writes.includes(ex)) writes.push(ex);
      } else {
        const dc: DeckCard = { id: newId(), deckId, oracleId: c.oracleId, quantity: c.quantity, board: c.board, scryfallId: c.scryfallId };
        map.set(keyOf(c), dc);
        writes.push(dc);
      }
    }
    await db.deckCards.bulkPut(writes);
    await db.decks.update(deckId, { updatedAt: Date.now() });
  });
}

/** Move a slot to another board, merging into an existing slot for the same card there. */
export async function moveDeckCard(id: string, board: DeckBoard): Promise<void> {
  await db.transaction('rw', db.deckCards, db.decks, async () => {
    const card = await db.deckCards.get(id);
    if (!card || card.board === board) return;
    const existing = await db.deckCards
      .where('[deckId+board]')
      .equals([card.deckId, board])
      .and((c) => c.oracleId === card.oracleId)
      .first();
    if (existing) {
      await db.deckCards.update(existing.id, { quantity: existing.quantity + card.quantity });
      await db.deckCards.delete(id);
    } else {
      await db.deckCards.update(id, { board });
    }
    await db.decks.update(card.deckId, { updatedAt: Date.now() });
  });
}

/** Set a slot's quantity; deletes the slot at zero. */
export async function setDeckCardQuantity(id: string, quantity: number): Promise<void> {
  if (quantity <= 0) {
    await db.deckCards.delete(id);
    return;
  }
  await db.deckCards.update(id, { quantity });
}

/** Update a slot's quantity and preferred printing (deck edit sheet). */
export async function updateDeckCard(id: string, patch: { quantity: number; scryfallId: string }): Promise<void> {
  if (patch.quantity <= 0) {
    await db.deckCards.delete(id);
    return;
  }
  await db.deckCards.update(id, { quantity: patch.quantity, scryfallId: patch.scryfallId });
}

export async function removeDeckCard(id: string): Promise<void> {
  await db.deckCards.delete(id);
}

// ---------------------------------------------------------------------------
// Trade completion (beta plan §7). The heart of the app: on `completed`, each
// client atomically updates its own collection/wishlist and writes a Trade
// record. Keyed on the server's sessionId so a re-delivered `completed` is a
// no-op (idempotent).
// ---------------------------------------------------------------------------

export async function applyCompletedTrade(
  sessionId: string,
  given: TradeLine[],
  receivedRaw: TradeLine[],
): Promise<{ applied: boolean }> {
  // Verify received cards are real (defence against a malicious peer sending
  // fabricated ids). Lines whose oracle card isn't in our card DB are dropped.
  const oracleKnown = await db.oracleCards.bulkGet([...new Set(receivedRaw.map((l) => l.oracleId))]);
  const knownOracles = new Set(oracleKnown.filter(Boolean).map((c) => c!.oracleId));
  const received = receivedRaw.filter((l) => knownOracles.has(l.oracleId));

  return db.transaction('rw', db.collection, db.wishlist, db.trades, async () => {
    if (await db.trades.get(sessionId)) return { applied: false }; // already applied

    const entries = await db.collection.toArray();
    const byKey = new Map(entries.map((e) => [collectionKey(e), e]));
    const now = Date.now();

    // Remove given cards (decrement matching entries; reduce trade qty with them).
    for (const line of given) {
      const ex = byKey.get(collectionKey(line));
      if (!ex) continue;
      const remaining = ex.quantity - line.quantity;
      if (remaining <= 0) {
        await db.collection.delete(ex.id);
        byKey.delete(collectionKey(line));
      } else {
        ex.quantity = remaining;
        ex.quantityForTrade = clamp(ex.quantityForTrade, 0, remaining);
        ex.updatedAt = now;
        await db.collection.put(ex);
      }
    }

    // Add received cards (merge on the same compound key).
    for (const line of received) {
      const lang = line.lang || 'en';
      const ex = byKey.get(collectionKey(line));
      if (ex) {
        ex.quantity += line.quantity;
        ex.updatedAt = now;
        await db.collection.put(ex);
      } else {
        const entry: CollectionEntry = {
          id: newId(),
          oracleId: line.oracleId,
          scryfallId: line.scryfallId,
          condition: line.condition,
          finish: line.finish,
          lang,
          quantity: line.quantity,
          quantityForTrade: 0,
          createdAt: now,
          updatedAt: now,
        };
        byKey.set(collectionKey(entry), entry);
        await db.collection.add(entry);
      }
    }

    // Prune wishlist by received cards (any printing of the oracle card).
    for (const line of received) {
      let toRemove = line.quantity;
      const wl = await db.wishlist.where('oracleId').equals(line.oracleId).toArray();
      for (const w of wl) {
        if (toRemove <= 0) break;
        const dec = Math.min(w.quantity, toRemove);
        toRemove -= dec;
        if (w.quantity - dec <= 0) await db.wishlist.delete(w.id);
        else await db.wishlist.update(w.id, { quantity: w.quantity - dec });
      }
    }

    const trade: Trade = { id: sessionId, completedAt: now, partner: null, given, received };
    await db.trades.add(trade);
    return { applied: true };
  });
}

async function clearUserDataTables(): Promise<void> {
  await Promise.all(USER_DATA_TABLES.map((t) => t.clear()));
}

/**
 * Replace every user-data table with a device transfer's (already sanitized)
 * contents, atomically. Card DB and settings are kept — transferred rows
 * reference cards by id only, resolved against this device's card DB.
 */
export async function replaceAllUserData(data: Omit<TransferPayload, 'version'>): Promise<void> {
  await db.transaction('rw', USER_DATA_TABLES, async () => {
    await clearUserDataTables();
    await Promise.all([
      db.collection.bulkAdd(data.collection),
      db.wishlist.bulkAdd(data.wishlist),
      db.decks.bulkAdd(data.decks),
      db.deckCards.bulkAdd(data.deckCards),
      db.trades.bulkAdd(data.trades),
      db.priceHistories.bulkAdd(data.priceHistories),
    ]);
  });
}

/** Wipe every user-data table (About screen: "delete all my data"). Card DB is kept. */
export async function deleteAllUserData(): Promise<void> {
  await db.transaction('rw', USER_DATA_TABLES, () => clearUserDataTables());
}
