import type {
  CollectionEntry,
  Condition,
  Deck,
  DeckBoard,
  DeckCard,
  DeckFormat,
  EventSource,
  Finish,
  RemovalReason,
  Trade,
  TradeLine,
  UserEvent,
  WishlistEntry,
} from '@mtg/shared';
import { db, USER_DATA_TABLES } from './schema.js';
import { getSetting } from './settings.js';
import { getPricesByIds } from '../cardDb/prices.js';
import { toCents } from '../price/history.js';
import { stagePut, stagePutMany, stageDelete } from '../sync/outbox.js';
import type { TransferPayload } from '../transfer/payload.js';

// The single mutation path for user data (beta plan §4). All invariants live
// here, never in UI code, so that trade completion (Phase 4) reuses the exact
// same functions:
//   - tradelist IS quantityForTrade on a CollectionEntry (0..quantity)
//   - collection entries unique on (scryfallId, condition, finish, lang)
//   - "owned" = sum of quantity over all entries with a matching oracleId
//
// Since the sync + history plan, every mutation here also does two more
// things, in the same transaction:
//   - stages the touched rows in the sync outbox (sync/outbox.ts), and
//   - emits UserEvents (the card history: adds/removes with the market price
//    at that moment, deck ins/outs, wishlist journey).
// Changes received FROM sync are applied directly to the tables, never through
// these functions, so they are not re-staged or re-evented.

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

// ---------------------------------------------------------------------------
// Event emission. Events are immutable apart from the user-editable fields
// (priceEurCents, reason) — updatedAt is bumped only by editUserEvent.
// ---------------------------------------------------------------------------

async function emit(e: Omit<UserEvent, 'id' | 'updatedAt'>): Promise<void> {
  const ev: UserEvent = { id: newId(), updatedAt: e.ts, ...e };
  await db.events.add(ev);
  await stagePut('events', ev);
}

/** Emit many events in two bulk writes instead of two per event (bulk imports). */
async function emitMany(events: Omit<UserEvent, 'id' | 'updatedAt'>[]): Promise<void> {
  if (events.length === 0) return;
  const full: UserEvent[] = events.map((e) => ({ id: newId(), updatedAt: e.ts, ...e }));
  await db.events.bulkAdd(full);
  await stagePutMany('events', full);
}

function groupByOracle(wishes: WishlistEntry[]): Map<string, WishlistEntry[]> {
  const m = new Map<string, WishlistEntry[]>();
  for (const w of wishes) {
    const arr = m.get(w.oracleId);
    if (arr) arr.push(w);
    else m.set(w.oracleId, [w]);
  }
  return m;
}

/**
 * Bulk equivalent of emitWishFulfilled: given a preloaded wishlist grouped by
 * oracleId, return the wish.fulfilled event for one add (or null). Keeps bulk
 * imports off the per-line wishlist query that emitWishFulfilled does.
 */
function wishFulfilledEvent(
  wishesByOracle: Map<string, WishlistEntry[]>,
  oracleId: string,
  scryfallId: string,
  qty: number,
  ts: number,
  extra: Partial<Pick<UserEvent, 'source' | 'batchId' | 'tradeId'>>,
): Omit<UserEvent, 'id' | 'updatedAt'> | null {
  const match = wishesByOracle.get(oracleId)?.find((w) => w.scryfallId === null || w.scryfallId === scryfallId);
  if (!match) return null;
  return { ts, kind: 'wish.fulfilled', oracleId, scryfallId, qty: Math.min(qty, match.quantity), ...extra };
}

/**
 * Current market price per copy in EUR cents (null = unknown). Reads the
 * price shards, so db.priceShards must be in the transaction scope when this
 * is called inside one.
 */
async function priceCents(scryfallId: string): Promise<number | null> {
  const prices = await getPricesByIds([scryfallId]);
  return toCents(prices.get(scryfallId)?.eur ?? null);
}

/**
 * If an added printing matches a wishlist line (null scryfallId = any
 * printing), record the wish as fulfilled. The wishlist itself is not
 * changed — only trades prune it (existing behavior).
 */
async function emitWishFulfilled(
  oracleId: string,
  scryfallId: string,
  qty: number,
  ts: number,
  extra: Partial<Pick<UserEvent, 'source' | 'batchId' | 'tradeId'>> = {},
): Promise<void> {
  const wishes = await db.wishlist.where('oracleId').equals(oracleId).toArray();
  const match = wishes.find((w) => w.scryfallId === null || w.scryfallId === scryfallId);
  if (!match) return;
  await emit({
    ts,
    kind: 'wish.fulfilled',
    oracleId,
    scryfallId,
    qty: Math.min(qty, match.quantity),
    ...extra,
  });
}

/** Edit the user-editable fields of a history event (History tab). */
export async function editUserEvent(
  id: string,
  patch: { priceEurCents?: number | null; reason?: RemovalReason },
): Promise<void> {
  await db.transaction('rw', [db.events, db.outbox], async () => {
    const ev = await db.events.get(id);
    if (!ev) return;
    const next: UserEvent = { ...ev, ...patch, updatedAt: Date.now() };
    await db.events.put(next);
    await stagePut('events', next);
  });
}

// Transaction scopes. Collection mutations read priceShards (for the price
// stamped on events) and wishlist (for wish.fulfilled), so both are in scope.
const COLLECTION_TABLES = [db.collection, db.wishlist, db.events, db.outbox, db.priceShards];
const WISHLIST_TABLES = [db.wishlist, db.events, db.outbox];
const DECK_TABLES = [db.decks, db.deckCards, db.events, db.outbox];

export interface AddToCollectionInput {
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity?: number;
  /** If set, ensures at least this many are marked for trade after the add. */
  quantityForTrade?: number;
  /** How the add was made (edit-history provenance). Defaults to 'manual'. */
  source?: EventSource;
}

/**
 * Add copies to the collection, merging into an existing entry that matches on
 * (scryfallId, condition, finish, lang). Returns the resulting entry id.
 */
export async function addToCollection(input: AddToCollectionInput): Promise<string> {
  const qty = input.quantity ?? 1;
  const lang = input.lang || 'en';

  return db.transaction('rw', COLLECTION_TABLES, async () => {
    const existing = await db.collection
      .where('[scryfallId+condition+finish+lang]')
      .equals([input.scryfallId, input.condition, input.finish, lang])
      .first();

    const now = Date.now();
    let entry: CollectionEntry;
    if (existing) {
      const quantity = existing.quantity + qty;
      const quantityForTrade = Math.max(
        existing.quantityForTrade,
        input.quantityForTrade ?? 0,
      );
      entry = {
        ...existing,
        quantity,
        quantityForTrade: clamp(quantityForTrade, 0, quantity),
        updatedAt: now,
      };
    } else {
      entry = {
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
    }
    await db.collection.put(entry);
    await stagePut('collection', entry);
    const source = input.source ?? 'manual';
    await emit({
      ts: now,
      kind: 'collection.add',
      oracleId: input.oracleId,
      scryfallId: input.scryfallId,
      qty,
      condition: input.condition,
      finish: input.finish,
      lang,
      priceEurCents: await priceCents(input.scryfallId),
      source,
    });
    await emitWishFulfilled(input.oracleId, input.scryfallId, qty, now, { source });
    return entry.id;
  });
}

/** Patch an entry. quantityForTrade is always clamped to [0, quantity]. */
export async function updateCollectionEntry(
  id: string,
  patch: Partial<Pick<CollectionEntry, 'quantity' | 'quantityForTrade' | 'condition' | 'finish' | 'lang' | 'scryfallId'>>,
): Promise<void> {
  await db.transaction('rw', COLLECTION_TABLES, async () => {
    const entry = await db.collection.get(id);
    if (!entry) return;
    const now = Date.now();
    const quantity = patch.quantity ?? entry.quantity;
    const rawForTrade = patch.quantityForTrade ?? entry.quantityForTrade;
    const next: CollectionEntry = {
      ...entry,
      ...patch,
      quantity,
      quantityForTrade: clamp(rawForTrade, 0, quantity),
      updatedAt: now,
    };

    // Editing condition/finish/lang/printing can re-key the entry onto another
    // existing one. The (scryfallId, condition, finish, lang) index is NOT
    // unique in Dexie, so a naive put would leave two rows sharing a key and
    // every later .first() lookup would pick one at random. Merge instead, the
    // same way updateWishlistEntry does on a printing collision.
    let dup: CollectionEntry | undefined;
    if (collectionKey(next) !== collectionKey(entry)) {
      dup = await db.collection
        .where('[scryfallId+condition+finish+lang]')
        .equals([next.scryfallId, next.condition, next.finish, next.lang])
        .first();
      if (dup?.id === id) dup = undefined;
    }
    if (dup) {
      const mergedQty = dup.quantity + quantity;
      const merged: CollectionEntry = {
        ...dup,
        quantity: mergedQty,
        quantityForTrade: clamp(dup.quantityForTrade + next.quantityForTrade, 0, mergedQty),
        updatedAt: now,
      };
      await db.collection.put(merged);
      await db.collection.delete(id);
      await stagePut('collection', merged);
      await stageDelete('collection', id);
    } else {
      await db.collection.put(next);
      await stagePut('collection', next);
    }

    // A quantity edit is a real add/remove for history purposes. Removals
    // default to 'sold' (interview decision); the History tab can re-label.
    const delta = quantity - entry.quantity;
    if (delta !== 0) {
      await emit({
        ts: now,
        kind: delta > 0 ? 'collection.add' : 'collection.remove',
        oracleId: next.oracleId,
        scryfallId: next.scryfallId,
        qty: Math.abs(delta),
        condition: next.condition,
        finish: next.finish,
        lang: next.lang,
        priceEurCents: await priceCents(next.scryfallId),
        source: 'manual',
        ...(delta < 0 ? { reason: 'sold' as RemovalReason } : {}),
      });
      if (delta > 0) await emitWishFulfilled(next.oracleId, next.scryfallId, delta, now, { source: 'manual' });
    }
  });
}

/** Remove copies; deletes the entry when quantity hits zero. */
export async function removeFromCollection(
  id: string,
  quantity = Infinity,
  reason: RemovalReason = 'sold',
): Promise<void> {
  await db.transaction('rw', COLLECTION_TABLES, async () => {
    const entry = await db.collection.get(id);
    if (!entry) return;
    const now = Date.now();
    const removed = Math.min(entry.quantity, quantity);
    const remaining = entry.quantity - removed;
    if (remaining <= 0) {
      await db.collection.delete(id);
      await stageDelete('collection', id);
    } else {
      const next: CollectionEntry = {
        ...entry,
        quantity: remaining,
        quantityForTrade: clamp(entry.quantityForTrade, 0, remaining),
        updatedAt: now,
      };
      await db.collection.put(next);
      await stagePut('collection', next);
    }
    await emit({
      ts: now,
      kind: 'collection.remove',
      oracleId: entry.oracleId,
      scryfallId: entry.scryfallId,
      qty: removed,
      condition: entry.condition,
      finish: entry.finish,
      lang: entry.lang,
      priceEurCents: await priceCents(entry.scryfallId),
      source: 'manual',
      reason,
    });
  });
}

/** Set how many of an entry are offered for trade (the tradelist). */
export async function setQuantityForTrade(id: string, quantityForTrade: number): Promise<void> {
  await updateCollectionEntry(id, { quantityForTrade });
}

/**
 * Bulk-set quantityForTrade on many entries in ONE transaction — the bulk
 * tradelist actions used to call setQuantityForTrade per row, i.e. one IDB
 * transaction (and one live-query refire) per selected card. Changing the
 * tradelist flag is not a card-history event, so nothing is emitted.
 */
export async function setQuantityForTradeBulk(updates: { id: string; quantityForTrade: number }[]): Promise<void> {
  if (updates.length === 0) return;
  await db.transaction('rw', [db.collection, db.outbox], async () => {
    const now = Date.now();
    const entries = await db.collection.bulkGet(updates.map((u) => u.id));
    const writes: CollectionEntry[] = [];
    for (let i = 0; i < updates.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      writes.push({ ...entry, quantityForTrade: clamp(updates[i]!.quantityForTrade, 0, entry.quantity), updatedAt: now });
    }
    await db.collection.bulkPut(writes);
    await stagePutMany('collection', writes);
  });
}

/** Delete many collection entries outright in one transaction (bulk delete). */
export async function removeCollectionEntriesBulk(ids: string[], reason: RemovalReason = 'sold'): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  await db.transaction('rw', COLLECTION_TABLES, async () => {
    const entries = (await db.collection.bulkGet(ids)).filter((e): e is CollectionEntry => !!e);
    const prices = await getPricesByIds(entries.map((e) => e.scryfallId));
    await db.collection.bulkDelete(entries.map((e) => e.id));
    for (const id of entries.map((e) => e.id)) await stageDelete('collection', id);
    await emitMany(
      entries.map((e) => ({
        ts: now,
        kind: 'collection.remove' as const,
        oracleId: e.oracleId,
        scryfallId: e.scryfallId,
        qty: e.quantity,
        condition: e.condition,
        finish: e.finish,
        lang: e.lang,
        priceEurCents: toCents(prices.get(e.scryfallId)?.eur ?? null),
        source: 'manual' as const,
        reason,
      })),
    );
  });
}

export interface AddToWishlistInput {
  oracleId: string;
  /** null = "any printing". */
  scryfallId?: string | null;
  quantity?: number;
  /** How the add was made (edit-history provenance). Defaults to 'manual'. */
  source?: EventSource;
}

/** Add to the wishlist, merging by (oracleId, scryfallId). */
export async function addToWishlist(input: AddToWishlistInput): Promise<string> {
  const qty = input.quantity ?? 1;
  const scryfallId = input.scryfallId ?? null;

  return db.transaction('rw', WISHLIST_TABLES, async () => {
    const now = Date.now();
    const candidates = await db.wishlist.where('oracleId').equals(input.oracleId).toArray();
    const existing = candidates.find((w) => w.scryfallId === scryfallId);
    let entry: WishlistEntry;
    if (existing) {
      entry = { ...existing, quantity: existing.quantity + qty, updatedAt: now };
    } else {
      entry = { id: newId(), oracleId: input.oracleId, scryfallId, quantity: qty, createdAt: now, updatedAt: now };
    }
    await db.wishlist.put(entry);
    await stagePut('wishlist', entry);
    await emit({ ts: now, kind: 'wish.add', oracleId: input.oracleId, scryfallId, qty, source: input.source ?? 'manual' });
    return entry.id;
  });
}

export interface WishlistBulkLine {
  oracleId: string;
  /** null = "any printing". */
  scryfallId: string | null;
  quantity: number;
}

/**
 * Bulk-add to the wishlist (import), merging by (oracleId, scryfallId). Mirrors
 * applyImport: every line shares a batchId so the edit-history view collapses
 * the whole import into a single entry.
 */
export async function addToWishlistBulk(
  lines: WishlistBulkLine[],
  meta: { label?: string } = {},
): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  const batchId = newId();
  const batchExtra = { source: 'import' as const, batchId, ...(meta.label ? { batchLabel: meta.label } : {}) };
  await db.transaction('rw', WISHLIST_TABLES, async () => {
    const now = Date.now();
    const existing = await db.wishlist.toArray();
    const keyOf = (l: { oracleId: string; scryfallId: string | null }) => `${l.oracleId}|${l.scryfallId ?? ''}`;
    const map = new Map(existing.map((e) => [keyOf(e), e]));
    const touched = new Set<WishlistEntry>();
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    for (const l of lines) {
      cards += l.quantity;
      const ex = map.get(keyOf(l));
      if (ex) {
        ex.quantity += l.quantity;
        ex.updatedAt = now;
        touched.add(ex);
      } else {
        const entry: WishlistEntry = {
          id: newId(),
          oracleId: l.oracleId,
          scryfallId: l.scryfallId,
          quantity: l.quantity,
          createdAt: now,
          updatedAt: now,
        };
        map.set(keyOf(l), entry);
        touched.add(entry);
      }
      events.push({ ts: now, kind: 'wish.add', oracleId: l.oracleId, scryfallId: l.scryfallId, qty: l.quantity, ...batchExtra });
    }
    const writes = [...touched];
    await db.wishlist.bulkPut(writes);
    await stagePutMany('wishlist', writes);
    await emitMany(events);
  });
  return { entries: lines.length, cards };
}

/**
 * Update a wishlist line's printing and/or quantity. If the new printing
 * collides with another line for the same card, the two lines merge.
 */
export async function updateWishlistEntry(
  id: string,
  patch: { scryfallId?: string | null; quantity?: number },
): Promise<void> {
  await db.transaction('rw', WISHLIST_TABLES, async () => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const now = Date.now();
    const scryfallId = patch.scryfallId !== undefined ? patch.scryfallId : entry.scryfallId;
    const quantity = Math.max(1, patch.quantity ?? entry.quantity);
    const candidates = await db.wishlist.where('oracleId').equals(entry.oracleId).toArray();
    const dup = candidates.find((w) => w.id !== id && w.scryfallId === scryfallId);
    if (dup) {
      const merged: WishlistEntry = { ...dup, quantity: dup.quantity + quantity, updatedAt: now };
      await db.wishlist.put(merged);
      await db.wishlist.delete(id);
      await stagePut('wishlist', merged);
      await stageDelete('wishlist', id);
    } else {
      const next: WishlistEntry = { ...entry, scryfallId, quantity, updatedAt: now };
      await db.wishlist.put(next);
      await stagePut('wishlist', next);
    }
  });
}

/** Decrement a wishlist entry by quantity; deletes it at zero. */
export async function removeFromWishlist(id: string, quantity = Infinity): Promise<void> {
  await db.transaction('rw', WISHLIST_TABLES, async () => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const now = Date.now();
    const removed = Math.min(entry.quantity, quantity);
    const remaining = entry.quantity - removed;
    if (remaining <= 0) {
      await db.wishlist.delete(id);
      await stageDelete('wishlist', id);
    } else {
      const next: WishlistEntry = { ...entry, quantity: remaining, updatedAt: now };
      await db.wishlist.put(next);
      await stagePut('wishlist', next);
    }
    await emit({ ts: now, kind: 'wish.remove', oracleId: entry.oracleId, scryfallId: entry.scryfallId, qty: removed, source: 'manual' });
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
 *
 * `replaceOracleIds` lists cards whose import conflict was resolved as
 * "replace": every owned entry of those cards (any printing) is removed
 * before the lines are added, in the same batch, so one undo restores them.
 */
export async function applyImport(
  lines: ImportLine[],
  meta: { source?: 'import' | 'sealed'; label?: string; replaceOracleIds?: string[] } = {},
): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  // Every line of one import/sealed add shares a batchId, so the edit-history
  // view can collapse the whole operation into a single entry.
  const source = meta.source ?? 'import';
  const batchId = newId();
  const batchExtra = { source, batchId, ...(meta.label ? { batchLabel: meta.label } : {}) };
  // One bulk price lookup for the acquisition price on every line's event.
  const prices = await getPricesByIds(lines.map((l) => l.scryfallId));
  const replace = new Set(meta.replaceOracleIds ?? []);
  await db.transaction('rw', COLLECTION_TABLES, async () => {
    const existing = await db.collection.toArray();
    const map = new Map(existing.map((e) => [collectionKey(e), e]));
    const now = Date.now();
    // A Set (not `writes.includes`) so re-touching an entry is O(1), not O(n);
    // events are accumulated and flushed once instead of two IDB ops per line.
    const touched = new Set<CollectionEntry>();
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    const wishesByOracle = groupByOracle(await db.wishlist.toArray());

    if (replace.size > 0) {
      const doomed = existing.filter((e) => replace.has(e.oracleId));
      const exitPrices = await getPricesByIds(doomed.map((e) => e.scryfallId));
      for (const e of doomed) {
        map.delete(collectionKey(e));
        await db.collection.delete(e.id);
        await stageDelete('collection', e.id);
        events.push({
          ts: now,
          kind: 'collection.remove',
          oracleId: e.oracleId,
          scryfallId: e.scryfallId,
          qty: e.quantity,
          condition: e.condition,
          finish: e.finish,
          lang: e.lang,
          priceEurCents: toCents(exitPrices.get(e.scryfallId)?.eur ?? null),
          reason: 'other',
          ...batchExtra,
        });
      }
    }

    for (const l of lines) {
      const lang = l.lang || 'en';
      const k = collectionKey({ ...l, lang });
      cards += l.quantity;
      const ex = map.get(k);
      if (ex) {
        ex.quantity += l.quantity;
        ex.quantityForTrade = clamp(Math.max(ex.quantityForTrade, l.quantityForTrade), 0, ex.quantity);
        ex.updatedAt = now;
        touched.add(ex);
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
        touched.add(entry);
      }
      events.push({
        ts: now,
        kind: 'collection.add',
        oracleId: l.oracleId,
        scryfallId: l.scryfallId,
        qty: l.quantity,
        condition: l.condition,
        finish: l.finish,
        lang,
        priceEurCents: toCents(prices.get(l.scryfallId)?.eur ?? null),
        ...batchExtra,
      });
      const wf = wishFulfilledEvent(wishesByOracle, l.oracleId, l.scryfallId, l.quantity, now, { source, batchId });
      if (wf) events.push(wf);
    }
    const writes = [...touched];
    await db.collection.bulkPut(writes);
    await stagePutMany('collection', writes);
    await emitMany(events);
  });
  return { entries: lines.length, cards };
}

/** Take every card off the tradelist (quantityForTrade → 0). Returns entries changed. */
export async function clearTradelist(): Promise<number> {
  return db.transaction('rw', [db.collection, db.outbox], async () => {
    const entries = await db.collection.where('quantityForTrade').above(0).toArray();
    const now = Date.now();
    for (const e of entries) {
      e.quantityForTrade = 0;
      e.updatedAt = now;
      await stagePut('collection', e);
    }
    await db.collection.bulkPut(entries);
    return entries.length;
  });
}

// ---------------------------------------------------------------------------
// Decks (beta plan §4). Deck slots reference oracle cards ("4x Lightning Bolt");
// legality checking lives in deck/legality.ts.
// ---------------------------------------------------------------------------

/** Bump the deck's updatedAt and stage it; returns the deck (for its name). */
async function touchDeck(deckId: string, now: number): Promise<Deck | undefined> {
  const deck = await db.decks.get(deckId);
  if (!deck) return undefined;
  deck.updatedAt = now;
  await db.decks.put(deck);
  await stagePut('decks', deck);
  return deck;
}

export async function createDeck(name: string, format: DeckFormat = 'casual'): Promise<string> {
  const now = Date.now();
  const deck: Deck = { id: newId(), name: name.trim() || 'Untitled deck', format, createdAt: now, updatedAt: now };
  await db.transaction('rw', [db.decks, db.outbox], async () => {
    await db.decks.add(deck);
    await stagePut('decks', deck);
  });
  return deck.id;
}

export async function renameDeck(id: string, name: string): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], async () => {
    const deck = await db.decks.get(id);
    if (!deck) return;
    deck.name = name.trim() || 'Untitled deck';
    deck.updatedAt = Date.now();
    await db.decks.put(deck);
    await stagePut('decks', deck);
  });
}

export async function setDeckFormat(id: string, format: DeckFormat): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], async () => {
    const deck = await db.decks.get(id);
    if (!deck) return;
    deck.format = format;
    deck.updatedAt = Date.now();
    await db.decks.put(deck);
    await stagePut('decks', deck);
  });
}

export async function deleteDeck(id: string): Promise<void> {
  await db.transaction('rw', DECK_TABLES, async () => {
    const deck = await db.decks.get(id);
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    const now = Date.now();
    for (const c of cards) {
      await stageDelete('deckCards', c.id);
      await emit({
        ts: now,
        kind: 'deck.remove',
        oracleId: c.oracleId,
        ...(c.scryfallId ? { scryfallId: c.scryfallId } : {}),
        qty: c.quantity,
        deckId: id,
        ...(deck ? { deckName: deck.name } : {}),
        board: c.board,
      });
    }
    await db.deckCards.where('deckId').equals(id).delete();
    await db.decks.delete(id);
    await stageDelete('decks', id);
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
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const existing = await db.deckCards
      .where('[deckId+board]')
      .equals([input.deckId, board])
      .and((c) => c.oracleId === input.oracleId)
      .first();
    let slot: DeckCard;
    if (existing) {
      slot = { ...existing, quantity: existing.quantity + quantity, updatedAt: now };
    } else {
      slot = {
        id: newId(),
        deckId: input.deckId,
        oracleId: input.oracleId,
        ...(input.scryfallId ? { scryfallId: input.scryfallId } : {}),
        quantity,
        board,
        updatedAt: now,
      };
    }
    await db.deckCards.put(slot);
    await stagePut('deckCards', slot);
    const deck = await touchDeck(input.deckId, now);
    await emit({
      ts: now,
      kind: 'deck.add',
      oracleId: input.oracleId,
      ...(input.scryfallId ? { scryfallId: input.scryfallId } : {}),
      qty: quantity,
      deckId: input.deckId,
      ...(deck ? { deckName: deck.name } : {}),
      board,
    });
  });
}

/** Bulk-add (deck import), merging by (oracleId, board). */
export async function addDeckCardsBulk(
  deckId: string,
  cards: Array<{ oracleId: string; quantity: number; board: DeckBoard; scryfallId?: string }>,
): Promise<void> {
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    const keyOf = (c: { oracleId: string; board: DeckBoard }) => `${c.oracleId}|${c.board}`;
    const map = new Map(existing.map((c) => [keyOf(c), c]));
    const touched = new Set<DeckCard>();
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    const deck = await touchDeck(deckId, now);
    for (const c of cards) {
      const ex = map.get(keyOf(c));
      if (ex) {
        ex.quantity += c.quantity;
        // Adopt the imported printing if the slot didn't already have one.
        if (!ex.scryfallId && c.scryfallId) ex.scryfallId = c.scryfallId;
        ex.updatedAt = now;
        touched.add(ex);
      } else {
        const dc: DeckCard = {
          id: newId(),
          deckId,
          oracleId: c.oracleId,
          quantity: c.quantity,
          board: c.board,
          scryfallId: c.scryfallId,
          updatedAt: now,
        };
        map.set(keyOf(c), dc);
        touched.add(dc);
      }
      events.push({
        ts: now,
        kind: 'deck.add',
        oracleId: c.oracleId,
        ...(c.scryfallId ? { scryfallId: c.scryfallId } : {}),
        qty: c.quantity,
        deckId,
        ...(deck ? { deckName: deck.name } : {}),
        board: c.board,
      });
    }
    const writes = [...touched];
    await db.deckCards.bulkPut(writes);
    await stagePutMany('deckCards', writes);
    await emitMany(events);
  });
}

/** Move a slot to another board, merging into an existing slot for the same card there. */
export async function moveDeckCard(id: string, board: DeckBoard): Promise<void> {
  await db.transaction('rw', DECK_TABLES, async () => {
    const card = await db.deckCards.get(id);
    if (!card || card.board === board) return;
    const now = Date.now();
    const existing = await db.deckCards
      .where('[deckId+board]')
      .equals([card.deckId, board])
      .and((c) => c.oracleId === card.oracleId)
      .first();
    if (existing) {
      const merged: DeckCard = { ...existing, quantity: existing.quantity + card.quantity, updatedAt: now };
      await db.deckCards.put(merged);
      await db.deckCards.delete(id);
      await stagePut('deckCards', merged);
      await stageDelete('deckCards', id);
    } else {
      const moved: DeckCard = { ...card, board, updatedAt: now };
      await db.deckCards.put(moved);
      await stagePut('deckCards', moved);
    }
    const deck = await touchDeck(card.deckId, now);
    const base = {
      oracleId: card.oracleId,
      ...(card.scryfallId ? { scryfallId: card.scryfallId } : {}),
      qty: card.quantity,
      deckId: card.deckId,
      ...(deck ? { deckName: deck.name } : {}),
    };
    await emit({ ts: now, kind: 'deck.remove', ...base, board: card.board });
    await emit({ ts: now, kind: 'deck.add', ...base, board });
  });
}

/** Change a slot's quantity/printing; quantity ≤ 0 deletes the slot. */
async function patchDeckCard(
  id: string,
  patch: { quantity?: number; scryfallId?: string },
): Promise<void> {
  await db.transaction('rw', DECK_TABLES, async () => {
    const card = await db.deckCards.get(id);
    if (!card) return;
    const now = Date.now();
    const quantity = patch.quantity ?? card.quantity;
    const delta = quantity - card.quantity;

    if (quantity <= 0) {
      await db.deckCards.delete(id);
      await stageDelete('deckCards', id);
    } else {
      const next: DeckCard = {
        ...card,
        quantity,
        ...(patch.scryfallId ? { scryfallId: patch.scryfallId } : {}),
        updatedAt: now,
      };
      await db.deckCards.put(next);
      await stagePut('deckCards', next);
    }

    const removedAll = quantity <= 0;
    if (delta !== 0 || removedAll) {
      const deck = await db.decks.get(card.deckId);
      await emit({
        ts: now,
        kind: removedAll || delta < 0 ? 'deck.remove' : 'deck.add',
        oracleId: card.oracleId,
        ...(card.scryfallId ? { scryfallId: card.scryfallId } : {}),
        qty: removedAll ? card.quantity : Math.abs(delta),
        deckId: card.deckId,
        ...(deck ? { deckName: deck.name } : {}),
        board: card.board,
      });
    }
  });
}

/** Set a slot's quantity; deletes the slot at zero. */
export async function setDeckCardQuantity(id: string, quantity: number): Promise<void> {
  await patchDeckCard(id, { quantity });
}

/** Update a slot's quantity and preferred printing (deck edit sheet). */
export async function updateDeckCard(id: string, patch: { quantity: number; scryfallId: string }): Promise<void> {
  await patchDeckCard(id, patch);
}

export async function removeDeckCard(id: string): Promise<void> {
  await patchDeckCard(id, { quantity: 0 });
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
  partner: string | null = null,
): Promise<{ applied: boolean }> {
  // Verify received cards are real (defence against a malicious peer sending
  // fabricated ids). Lines whose oracle card isn't in our card DB are dropped.
  const oracleKnown = await db.oracleCards.bulkGet([...new Set(receivedRaw.map((l) => l.oracleId))]);
  const knownOracles = new Set(oracleKnown.filter(Boolean).map((c) => c!.oracleId));
  const received = receivedRaw.filter((l) => knownOracles.has(l.oracleId));

  // Exit/acquisition prices for the trade's history events, one bulk lookup.
  const prices = await getPricesByIds([...given, ...received].map((l) => l.scryfallId));
  const centsOf = (scryfallId: string) => toCents(prices.get(scryfallId)?.eur ?? null);

  return db.transaction('rw', [db.collection, db.wishlist, db.trades, db.events, db.outbox], async () => {
    if (await db.trades.get(sessionId)) return { applied: false }; // already applied

    const entries = await db.collection.toArray();
    const byKey = new Map(entries.map((e) => [collectionKey(e), e]));
    const now = Date.now();

    // Remove given cards (decrement matching entries; reduce trade qty with them).
    for (const line of given) {
      const ex = byKey.get(collectionKey(line));
      if (ex) {
        const remaining = ex.quantity - line.quantity;
        if (remaining <= 0) {
          await db.collection.delete(ex.id);
          await stageDelete('collection', ex.id);
          byKey.delete(collectionKey(line));
        } else {
          ex.quantity = remaining;
          ex.quantityForTrade = clamp(ex.quantityForTrade, 0, remaining);
          ex.updatedAt = now;
          await db.collection.put(ex);
          await stagePut('collection', ex);
        }
      }
      // The event records the full traded quantity even when the card was
      // never registered (or under-registered) in the collection — the trade
      // happened either way, and the card history should say so.
      await emit({
        ts: now,
        kind: 'collection.remove',
        oracleId: line.oracleId,
        scryfallId: line.scryfallId,
        qty: line.quantity,
        condition: line.condition,
        finish: line.finish,
        lang: line.lang,
        priceEurCents: centsOf(line.scryfallId),
        reason: 'traded',
        source: 'trade',
        tradeId: sessionId,
      });
    }

    // Add received cards (merge on the same compound key).
    for (const line of received) {
      const lang = line.lang || 'en';
      const ex = byKey.get(collectionKey(line));
      if (ex) {
        ex.quantity += line.quantity;
        ex.updatedAt = now;
        await db.collection.put(ex);
        await stagePut('collection', ex);
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
        await stagePut('collection', entry);
      }
      await emit({
        ts: now,
        kind: 'collection.add',
        oracleId: line.oracleId,
        scryfallId: line.scryfallId,
        qty: line.quantity,
        condition: line.condition,
        finish: line.finish,
        lang,
        priceEurCents: centsOf(line.scryfallId),
        source: 'trade',
        tradeId: sessionId,
      });
    }

    // Prune wishlist by received cards (any printing of the oracle card).
    for (const line of received) {
      let toRemove = line.quantity;
      const wl = await db.wishlist.where('oracleId').equals(line.oracleId).toArray();
      for (const w of wl) {
        if (toRemove <= 0) break;
        const dec = Math.min(w.quantity, toRemove);
        toRemove -= dec;
        if (w.quantity - dec <= 0) {
          await db.wishlist.delete(w.id);
          await stageDelete('wishlist', w.id);
        } else {
          const next: WishlistEntry = { ...w, quantity: w.quantity - dec, updatedAt: now };
          await db.wishlist.put(next);
          await stagePut('wishlist', next);
        }
        await emit({
          ts: now,
          kind: 'wish.fulfilled',
          oracleId: line.oracleId,
          scryfallId: line.scryfallId,
          qty: dec,
          source: 'trade',
          tradeId: sessionId,
        });
      }
    }

    const trade: Trade = { id: sessionId, completedAt: now, partner, given, received };
    await db.trades.add(trade);
    await stagePut('trades', trade);
    return { applied: true };
  });
}

// ---------------------------------------------------------------------------
// Undo the most recent edit-history entry (edit-history feature). Reverses the
// recorded mutation and deletes the event(s) WITHOUT emitting new events — the
// log returns to its prior state, exactly like a sync-applied change. The UI
// only offers this on the single newest entry, so reversing the last change is
// safe and needs no cascade handling ("no domino effect").
// ---------------------------------------------------------------------------

export type UndoRef =
  | { type: 'single'; id: string }
  | { type: 'batch'; batchId: string }
  | { type: 'trade'; tradeId: string };

const UNDO_TABLES = [db.collection, db.wishlist, db.decks, db.deckCards, db.trades, db.events, db.outbox];

/** Add e.qty copies back to the collection (reverse of a removal). */
async function addCopiesRaw(e: UserEvent, now: number): Promise<void> {
  if (!e.scryfallId || !e.qty) return;
  const condition = e.condition ?? 'NM';
  const finish = e.finish ?? 'nonfoil';
  const lang = e.lang ?? 'en';
  const existing = await db.collection
    .where('[scryfallId+condition+finish+lang]')
    .equals([e.scryfallId, condition, finish, lang])
    .first();
  if (existing) {
    const next: CollectionEntry = { ...existing, quantity: existing.quantity + e.qty, updatedAt: now };
    await db.collection.put(next);
    await stagePut('collection', next);
  } else {
    const entry: CollectionEntry = {
      id: newId(),
      oracleId: e.oracleId,
      scryfallId: e.scryfallId,
      condition,
      finish,
      lang,
      quantity: e.qty,
      quantityForTrade: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection.add(entry);
    await stagePut('collection', entry);
  }
}

/** Remove e.qty copies from the collection (reverse of an add). */
async function removeCopiesRaw(e: UserEvent, now: number): Promise<void> {
  if (!e.scryfallId || !e.qty) return;
  const existing = await db.collection
    .where('[scryfallId+condition+finish+lang]')
    .equals([e.scryfallId, e.condition ?? 'NM', e.finish ?? 'nonfoil', e.lang ?? 'en'])
    .first();
  if (!existing) return;
  const remaining = existing.quantity - e.qty;
  if (remaining <= 0) {
    await db.collection.delete(existing.id);
    await stageDelete('collection', existing.id);
  } else {
    const next: CollectionEntry = {
      ...existing,
      quantity: remaining,
      quantityForTrade: clamp(existing.quantityForTrade, 0, remaining),
      updatedAt: now,
    };
    await db.collection.put(next);
    await stagePut('collection', next);
  }
}

/** Change a wishlist line by delta (negative removes, positive re-adds). */
async function wishlistAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!delta) return;
  const list = await db.wishlist.where('oracleId').equals(e.oracleId).toArray();
  const match =
    list.find((w) => w.scryfallId === (e.scryfallId ?? null)) ?? list.find((w) => w.scryfallId === null) ?? list[0];
  if (delta < 0) {
    if (!match) return;
    const remaining = match.quantity + delta;
    if (remaining <= 0) {
      await db.wishlist.delete(match.id);
      await stageDelete('wishlist', match.id);
    } else {
      const next: WishlistEntry = { ...match, quantity: remaining, updatedAt: now };
      await db.wishlist.put(next);
      await stagePut('wishlist', next);
    }
  } else if (match) {
    const next: WishlistEntry = { ...match, quantity: match.quantity + delta, updatedAt: now };
    await db.wishlist.put(next);
    await stagePut('wishlist', next);
  } else {
    const entry: WishlistEntry = {
      id: newId(),
      oracleId: e.oracleId,
      scryfallId: e.scryfallId ?? null,
      quantity: delta,
      createdAt: now,
      updatedAt: now,
    };
    await db.wishlist.put(entry);
    await stagePut('wishlist', entry);
  }
}

/** Change a deck slot by delta (negative removes, positive re-adds). No-op if the deck is gone. */
async function deckAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!e.deckId || !delta) return;
  const deck = await db.decks.get(e.deckId);
  if (!deck) return;
  const board = e.board ?? 'main';
  const cards = await db.deckCards.where('[deckId+board]').equals([e.deckId, board]).toArray();
  const dc = cards.find((c) => c.oracleId === e.oracleId);
  if (delta < 0) {
    if (!dc) return;
    const remaining = dc.quantity + delta;
    if (remaining <= 0) {
      await db.deckCards.delete(dc.id);
      await stageDelete('deckCards', dc.id);
    } else {
      const next: DeckCard = { ...dc, quantity: remaining, updatedAt: now };
      await db.deckCards.put(next);
      await stagePut('deckCards', next);
    }
  } else if (dc) {
    const next: DeckCard = { ...dc, quantity: dc.quantity + delta, updatedAt: now };
    await db.deckCards.put(next);
    await stagePut('deckCards', next);
  } else {
    const slot: DeckCard = {
      id: newId(),
      deckId: e.deckId,
      oracleId: e.oracleId,
      ...(e.scryfallId ? { scryfallId: e.scryfallId } : {}),
      quantity: delta,
      board,
      updatedAt: now,
    };
    await db.deckCards.put(slot);
    await stagePut('deckCards', slot);
  }
  const touched: Deck = { ...deck, updatedAt: now };
  await db.decks.put(touched);
  await stagePut('decks', touched);
}

/** Reverse the effect of a single event (used only by undoEntry). */
async function reverseEvent(e: UserEvent, now: number): Promise<void> {
  const fromTrade = e.source === 'trade' || e.tradeId != null;
  switch (e.kind) {
    case 'collection.add':
      await removeCopiesRaw(e, now);
      break;
    case 'collection.remove':
      await addCopiesRaw(e, now);
      break;
    case 'wish.add':
      await wishlistAdjustRaw(e, -(e.qty ?? 1), now);
      break;
    case 'wish.remove':
      await wishlistAdjustRaw(e, e.qty ?? 1, now);
      break;
    case 'wish.fulfilled':
      // A trade prunes the wishlist; restore it. A manual add's wish.fulfilled
      // never touched the wishlist, so there's nothing to reverse.
      if (fromTrade) await wishlistAdjustRaw(e, e.qty ?? 1, now);
      break;
    case 'deck.add':
      await deckAdjustRaw(e, -(e.qty ?? 1), now);
      break;
    case 'deck.remove':
      await deckAdjustRaw(e, e.qty ?? 1, now);
      break;
  }
}

/**
 * Undo the given (newest) history entry: reverse every event it groups and
 * delete them. No-op with a reason if the entry is gone or is no longer the
 * newest (a concurrent change slipped in), so the caller can tell the user.
 */
export async function undoEntry(ref: UndoRef): Promise<{ undone: boolean; reason?: 'gone' | 'not-latest' }> {
  return db.transaction('rw', UNDO_TABLES, async () => {
    // Gather every event the entry comprises (batchId/tradeId are indexed as of
    // schema v10, so this doesn't scan the whole events table).
    let events: UserEvent[];
    if (ref.type === 'batch') {
      events = await db.events.where('batchId').equals(ref.batchId).toArray();
    } else if (ref.type === 'trade') {
      events = await db.events.where('tradeId').equals(ref.tradeId).toArray();
    } else {
      const one = await db.events.get(ref.id);
      if (!one) return { undone: false, reason: 'gone' as const };
      // A manual add can also have emitted a paired wish.fulfilled at the same
      // instant; fold it in so it's cleaned up too.
      const paired = await db.events
        .filter(
          (e) =>
            e.kind === 'wish.fulfilled' &&
            e.ts === one.ts &&
            e.oracleId === one.oracleId &&
            (e.scryfallId ?? null) === (one.scryfallId ?? null) &&
            e.batchId == null &&
            e.tradeId == null,
        )
        .toArray();
      events = [one, ...paired];
    }
    if (events.length === 0) return { undone: false, reason: 'gone' as const };

    // Guard: only the newest entry may be undone. Comparing by max ts (not by
    // the single id .last() happens to return) means two events sharing the
    // same millisecond don't make the guard reject the genuinely-newest entry.
    const newest = await db.events.orderBy('ts').last();
    if (newest && !events.some((e) => e.ts === newest.ts)) {
      return { undone: false, reason: 'not-latest' as const };
    }

    const now = Date.now();
    for (const e of events) await reverseEvent(e, now);
    for (const e of events) {
      await db.events.delete(e.id);
      await stageDelete('events', e.id);
    }
    if (ref.type === 'trade') {
      await db.trades.delete(ref.tradeId);
      await stageDelete('trades', ref.tradeId);
    }
    return { undone: true };
  });
}

async function clearUserDataTables(): Promise<void> {
  await Promise.all([...USER_DATA_TABLES, db.outbox].map((t) => t.clear()));
}

/**
 * Replace every user-data table with a device transfer's (already sanitized)
 * contents, atomically. Card DB and settings are kept — transferred rows
 * reference cards by id only, resolved against this device's card DB. The
 * sync outbox is cleared: the replaced rows no longer exist to push.
 */
export async function replaceAllUserData(data: Omit<TransferPayload, 'version'>): Promise<void> {
  // Wipe-and-replace stages no tombstones, so doing it while signed in would
  // silently diverge from the synced account. The UI hides the receive option
  // when signed in; guard here too, in case a user signs in while a received
  // payload is waiting at the review step. (Key read directly, like the sync
  // engine, to avoid an import cycle with account/session.ts.)
  if (await getSetting('accountSession')) {
    throw new Error('Sign out before replacing this device’s data from another device.');
  }
  await db.transaction('rw', [...USER_DATA_TABLES, db.outbox], async () => {
    await clearUserDataTables();
    await Promise.all([
      db.collection.bulkAdd(data.collection),
      db.wishlist.bulkAdd(data.wishlist),
      db.decks.bulkAdd(data.decks),
      db.deckCards.bulkAdd(data.deckCards),
      db.trades.bulkAdd(data.trades),
      db.priceHistories.bulkAdd(data.priceHistories),
      db.events.bulkAdd(data.events),
    ]);
  });
}

/** Wipe every user-data table (About screen: "delete all my data"). Card DB is kept. */
export async function deleteAllUserData(): Promise<void> {
  await db.transaction('rw', [...USER_DATA_TABLES, db.outbox], () => clearUserDataTables());
}
