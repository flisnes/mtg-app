import type { CollectionEntry, Condition, Finish, WishlistEntry } from '@mtg/shared';
import { db } from './schema.js';

// The single mutation path for user data (beta plan §4). All invariants live
// here, never in UI code, so that trade completion (Phase 4) reuses the exact
// same functions:
//   - tradelist IS quantityForTrade on a CollectionEntry (0..quantity)
//   - collection entries unique on (scryfallId, condition, finish, lang)
//   - "owned" = sum of quantity over all entries with a matching oracleId

function newId(): string {
  return crypto.randomUUID();
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
    const keyOf = (e: { scryfallId: string; condition: string; finish: string; lang: string }) =>
      `${e.scryfallId}|${e.condition}|${e.finish}|${e.lang}`;
    const map = new Map(existing.map((e) => [keyOf(e), e]));
    const now = Date.now();
    const writes: CollectionEntry[] = [];

    for (const l of lines) {
      const lang = l.lang || 'en';
      const k = keyOf({ ...l, lang });
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

/** Wipe every user-data table (About screen: "delete all my data"). Card DB is kept. */
export async function deleteAllUserData(): Promise<void> {
  await db.transaction('rw', [db.collection, db.wishlist, db.decks, db.deckCards, db.trades], async () => {
    await Promise.all([
      db.collection.clear(),
      db.wishlist.clear(),
      db.decks.clear(),
      db.deckCards.clear(),
      db.trades.clear(),
    ]);
  });
}
