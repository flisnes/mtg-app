import { normalizeCardTags, prefsCompatible, sameCardTags } from '@mtg/shared';
import type {
  CollectionEntry,
  Condition,
  ContainerKind,
  CopyPrefs,
  Deck,
  DeckBoard,
  DeckCard,
  DeckFolder,
  DeckFormat,
  EventSource,
  Finish,
  RemovalReason,
  Trade,
  TradeLine,
  UserEvent,
  SealedItem,
  WishlistEntry,
} from '@mtg/shared';
import { db, USER_DATA_TABLES } from './schema.js';
import { getSetting } from './settings.js';
import { getPricesByIds, priceForFinish } from '../cardDb/prices.js';
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
async function priceCents(scryfallId: string, finish: Finish): Promise<number | null> {
  const prices = await getPricesByIds([scryfallId]);
  return toCents(priceForFinish(prices.get(scryfallId), finish).eur);
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
      priceEurCents: await priceCents(input.scryfallId, input.finish),
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
        priceEurCents: await priceCents(next.scryfallId, next.finish),
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
      priceEurCents: await priceCents(entry.scryfallId, entry.finish),
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

export interface MarkForTradeRequest {
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity: number;
}

/**
 * Flag already-owned copies for trade without adding new ones — the tradelist
 * scan of cards you already have. For each request, up to `quantity` copies of
 * that card are marked for trade, preferring the scanned printing/finish/
 * condition, then looser matches (any printing of the same card). Every copy
 * flagged in one call shares a batchId, so the whole operation shows up as a
 * single "Marked for trade" entry in the edit history (and undoes as one).
 * Returns how many copies were newly flagged.
 */
export async function markOwnedForTrade(
  requests: MarkForTradeRequest[],
  meta: { source?: EventSource } = {},
): Promise<number> {
  if (requests.length === 0) return 0;
  let flagged = 0;
  const batchId = newId();
  await db.transaction('rw', [db.collection, db.events, db.outbox], async () => {
    const now = Date.now();
    const oracleIds = [...new Set(requests.map((r) => r.oracleId))];
    const owned = await db.collection.where('oracleId').anyOf(oracleIds).toArray();
    const byOracle = new Map<string, CollectionEntry[]>();
    for (const e of owned) {
      const arr = byOracle.get(e.oracleId);
      if (arr) arr.push(e);
      else byOracle.set(e.oracleId, [e]);
    }
    // How many copies each entry gained (accumulated across requests so a
    // second request touching the same entry adds one event line, not two).
    const gained = new Map<CollectionEntry, number>();
    for (const req of requests) {
      const entries = byOracle.get(req.oracleId);
      if (!entries) continue;
      // Best match first: exact printing, then finish, then condition.
      const score = (e: CollectionEntry) =>
        (e.scryfallId === req.scryfallId ? 4 : 0) + (e.finish === req.finish ? 2 : 0) + (e.condition === req.condition ? 1 : 0);
      const ranked = [...entries].sort((a, b) => score(b) - score(a));
      let remaining = req.quantity;
      for (const e of ranked) {
        if (remaining <= 0) break;
        const room = e.quantity - e.quantityForTrade;
        if (room <= 0) continue;
        const take = Math.min(room, remaining);
        e.quantityForTrade += take;
        e.updatedAt = now;
        remaining -= take;
        flagged += take;
        gained.set(e, (gained.get(e) ?? 0) + take);
      }
    }
    const writes = [...gained.keys()];
    if (writes.length > 0) {
      await db.collection.bulkPut(writes);
      await stagePutMany('collection', writes);
      await emitMany(
        writes.map((e) => ({
          ts: now,
          kind: 'tradelist.mark' as const,
          oracleId: e.oracleId,
          scryfallId: e.scryfallId,
          qty: gained.get(e)!,
          condition: e.condition,
          finish: e.finish,
          lang: e.lang,
          source: meta.source ?? 'manual',
          batchId,
        })),
      );
    }
  });
  return flagged;
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
        priceEurCents: toCents(priceForFinish(prices.get(e.scryfallId), e.finish).eur),
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
  /** Desired condition/finish/lang; undefined = "any". */
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  quantity?: number;
  /** How the add was made (edit-history provenance). Defaults to 'manual'. */
  source?: EventSource;
}

/** Identity of a wish line: printing + desired condition/finish/lang (undefined
 *  = "any"). Two wishes that differ on any of these are distinct lines, exactly
 *  as collection entries are unique on (scryfallId, condition, finish, lang). */
export function wishKey(w: { scryfallId: string | null; condition?: Condition; finish?: Finish; lang?: string }): string {
  return `${w.scryfallId ?? ''}|${w.condition ?? ''}|${w.finish ?? ''}|${w.lang ?? ''}`;
}

/** Add to the wishlist, merging by (oracleId, scryfallId, condition, finish, lang). */
export async function addToWishlist(input: AddToWishlistInput): Promise<string> {
  const qty = input.quantity ?? 1;
  const scryfallId = input.scryfallId ?? null;
  const { condition, finish, lang } = input;

  return db.transaction('rw', WISHLIST_TABLES, async () => {
    const now = Date.now();
    const key = wishKey({ scryfallId, condition, finish, lang });
    const candidates = await db.wishlist.where('oracleId').equals(input.oracleId).toArray();
    const existing = candidates.find((w) => wishKey(w) === key);
    let entry: WishlistEntry;
    if (existing) {
      entry = { ...existing, quantity: existing.quantity + qty, updatedAt: now };
    } else {
      entry = { id: newId(), oracleId: input.oracleId, scryfallId, condition, finish, lang, quantity: qty, createdAt: now, updatedAt: now };
    }
    await db.wishlist.put(entry);
    await stagePut('wishlist', entry);
    await emit({ ts: now, kind: 'wish.add', oracleId: input.oracleId, scryfallId, condition, finish, lang, qty, source: input.source ?? 'manual' });
    return entry.id;
  });
}

export interface WishlistBulkLine {
  oracleId: string;
  /** null = "any printing". */
  scryfallId: string | null;
  quantity: number;
  /** Desired condition/finish/language; undefined = "any" (what an import gives). */
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

/**
 * Bulk-add to the wishlist (import), merging by (oracleId, scryfallId). Mirrors
 * applyImport: every line shares a batchId so the edit-history view collapses
 * the whole import into a single entry.
 */
export async function addToWishlistBulk(
  lines: WishlistBulkLine[],
  meta: { label?: string; source?: EventSource } = {},
): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  const batchId = newId();
  const batchExtra = { source: meta.source ?? 'import', batchId, ...(meta.label ? { batchLabel: meta.label } : {}) };
  await db.transaction('rw', WISHLIST_TABLES, async () => {
    const now = Date.now();
    const existing = await db.wishlist.toArray();
    const keyOf = (l: { oracleId: string; scryfallId: string | null; condition?: Condition; finish?: Finish; lang?: string }) =>
      `${l.oracleId}|${wishKey(l)}`;
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
          ...(l.condition ? { condition: l.condition } : {}),
          ...(l.finish ? { finish: l.finish } : {}),
          ...(l.lang ? { lang: l.lang } : {}),
          quantity: l.quantity,
          createdAt: now,
          updatedAt: now,
        };
        map.set(keyOf(l), entry);
        touched.add(entry);
      }
      events.push({
        ts: now,
        kind: 'wish.add',
        oracleId: l.oracleId,
        scryfallId: l.scryfallId,
        ...(l.condition ? { condition: l.condition } : {}),
        ...(l.finish ? { finish: l.finish } : {}),
        ...(l.lang ? { lang: l.lang } : {}),
        qty: l.quantity,
        ...batchExtra,
      });
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
  patch: { scryfallId?: string | null; condition?: Condition; finish?: Finish; lang?: string; quantity?: number },
): Promise<void> {
  await db.transaction('rw', WISHLIST_TABLES, async () => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const now = Date.now();
    // The card sheet is a full editor: an omitted key means "leave as is", but a
    // key present with undefined means "any" (and must overwrite the old value).
    const scryfallId = 'scryfallId' in patch ? patch.scryfallId ?? null : entry.scryfallId;
    const condition = 'condition' in patch ? patch.condition : entry.condition;
    const finish = 'finish' in patch ? patch.finish : entry.finish;
    const lang = 'lang' in patch ? patch.lang : entry.lang;
    const quantity = Math.max(1, patch.quantity ?? entry.quantity);
    const key = wishKey({ scryfallId, condition, finish, lang });
    const candidates = await db.wishlist.where('oracleId').equals(entry.oracleId).toArray();
    const dup = candidates.find((w) => w.id !== id && wishKey(w) === key);
    if (dup) {
      const merged: WishlistEntry = { ...dup, quantity: dup.quantity + quantity, updatedAt: now };
      await db.wishlist.put(merged);
      await db.wishlist.delete(id);
      await stagePut('wishlist', merged);
      await stageDelete('wishlist', id);
    } else {
      const next: WishlistEntry = { ...entry, scryfallId, condition, finish, lang, quantity, updatedAt: now };
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
    await emit({
      ts: now,
      kind: 'wish.remove',
      oracleId: entry.oracleId,
      scryfallId: entry.scryfallId,
      condition: entry.condition,
      finish: entry.finish,
      lang: entry.lang,
      qty: removed,
      source: 'manual',
    });
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
 * `removals` is how "Update" is applied (import and scan alike): remove exactly
 * N copies from specific existing entries (by id) before adding the new lines,
 * so an incoming printing swaps in for a chosen owned copy without wiping the
 * rest. It happens in the same batch as the adds — one undo restores all.
 */
export async function applyImport(
  lines: ImportLine[],
  meta: {
    source?: 'import' | 'sealed' | 'scan';
    label?: string;
    removals?: { id: string; qty: number }[];
  } = {},
): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  // Every line of one import/sealed add shares a batchId, so the edit-history
  // view can collapse the whole operation into a single entry.
  const source = meta.source ?? 'import';
  const batchId = newId();
  const batchExtra = { source, batchId, ...(meta.label ? { batchLabel: meta.label } : {}) };
  // One bulk price lookup for the acquisition price on every line's event.
  const prices = await getPricesByIds(lines.map((l) => l.scryfallId));
  const removals = meta.removals ?? [];
  await db.transaction('rw', COLLECTION_TABLES, async () => {
    const existing = await db.collection.toArray();
    const map = new Map(existing.map((e) => [collectionKey(e), e]));
    const now = Date.now();
    // A Set (not `writes.includes`) so re-touching an entry is O(1), not O(n);
    // events are accumulated and flushed once instead of two IDB ops per line.
    const touched = new Set<CollectionEntry>();
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    const wishesByOracle = groupByOracle(await db.wishlist.toArray());

    if (removals.length > 0) {
      const byId = new Map(existing.map((e) => [e.id, e]));
      const exitPrices = await getPricesByIds(
        removals.map((r) => byId.get(r.id)?.scryfallId).filter((s): s is string => !!s),
      );
      for (const r of removals) {
        const e = byId.get(r.id);
        if (!e) continue;
        const take = Math.min(r.qty, e.quantity);
        if (take <= 0) continue;
        const remaining = e.quantity - take;
        if (remaining <= 0) {
          map.delete(collectionKey(e));
          await db.collection.delete(e.id);
          await stageDelete('collection', e.id);
        } else {
          e.quantity = remaining;
          e.quantityForTrade = clamp(e.quantityForTrade, 0, remaining);
          e.updatedAt = now;
          await db.collection.put(e);
          await stagePut('collection', e);
        }
        events.push({
          ts: now,
          kind: 'collection.remove',
          oracleId: e.oracleId,
          scryfallId: e.scryfallId,
          qty: take,
          condition: e.condition,
          finish: e.finish,
          lang: e.lang,
          priceEurCents: toCents(priceForFinish(exitPrices.get(e.scryfallId), e.finish).eur),
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
        priceEurCents: toCents(priceForFinish(prices.get(l.scryfallId), l.finish).eur),
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
//
// Binders and boxes are the same rows with `kind` set: storage instead of a
// brewed list. Every function below works on all three — a binder just never
// gets a format, a sideboard or a commander — so there is one code path for
// adds, scans, imports, re-scans and deletion, not three.
// ---------------------------------------------------------------------------

/**
 * The event fields that name where a slot change happened. `deckKind` is only
 * written for storage, so a deck event looks exactly as it always did.
 */
function containerRef(deck: Deck | undefined): { deckName?: string; deckKind?: ContainerKind } {
  if (!deck) return {};
  const kind = deck.kind ?? 'deck';
  return { deckName: deck.name, ...(kind === 'deck' ? {} : { deckKind: kind }) };
}

/** Fallback name per kind when the user creates one without typing a name. */
const UNTITLED: Record<ContainerKind, string> = {
  deck: 'Untitled deck',
  binder: 'Untitled binder',
  box: 'Untitled box',
};

/** Bump the deck's updatedAt and stage it; returns the deck (for its name). */
async function touchDeck(deckId: string, now: number): Promise<Deck | undefined> {
  const deck = await db.decks.get(deckId);
  if (!deck) return undefined;
  deck.updatedAt = now;
  await db.decks.put(deck);
  await stagePut('decks', deck);
  return deck;
}

/** Create a deck, binder or box. Only decks carry a format or a folder. */
export async function createContainer(
  name: string,
  kind: ContainerKind = 'deck',
  format: DeckFormat = 'casual',
  folderId?: string,
): Promise<string> {
  const now = Date.now();
  const deck: Deck = {
    id: newId(),
    name: name.trim() || UNTITLED[kind],
    kind,
    ...(kind === 'deck' ? { format, ...(folderId ? { folderId } : {}) } : {}),
    createdAt: now,
    updatedAt: now,
  };
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
    deck.name = name.trim() || UNTITLED[deck.kind ?? 'deck'];
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
        ...containerRef(deck),
        board: c.board,
      });
    }
    await db.deckCards.where('deckId').equals(id).delete();
    await db.decks.delete(id);
    await stageDelete('decks', id);
  });
}

// ---------------------------------------------------------------------------
// Deck folders. A flat grouping of decks (deck-only — binders/boxes don't use
// these), synced as their own table like decks themselves.
// ---------------------------------------------------------------------------

const DECK_FOLDER_TABLES = [db.deckFolders, db.decks, db.outbox];

const UNTITLED_FOLDER = 'Untitled folder';

export async function createDeckFolder(name: string): Promise<string> {
  const now = Date.now();
  const folder: DeckFolder = { id: newId(), name: name.trim() || UNTITLED_FOLDER, createdAt: now, updatedAt: now };
  await db.transaction('rw', [db.deckFolders, db.outbox], async () => {
    await db.deckFolders.add(folder);
    await stagePut('deckFolders', folder);
  });
  return folder.id;
}

export async function renameDeckFolder(id: string, name: string): Promise<void> {
  await db.transaction('rw', [db.deckFolders, db.outbox], async () => {
    const folder = await db.deckFolders.get(id);
    if (!folder) return;
    folder.name = name.trim() || UNTITLED_FOLDER;
    folder.updatedAt = Date.now();
    await db.deckFolders.put(folder);
    await stagePut('deckFolders', folder);
  });
}

/** Delete a folder; the decks inside it become unorganized, not deleted. */
export async function deleteDeckFolder(id: string): Promise<void> {
  await db.transaction('rw', DECK_FOLDER_TABLES, async () => {
    const now = Date.now();
    const members = await db.decks.where('folderId').equals(id).toArray();
    for (const deck of members) {
      delete deck.folderId;
      deck.updatedAt = now;
      await db.decks.put(deck);
      await stagePut('decks', deck);
    }
    await db.deckFolders.delete(id);
    await stageDelete('deckFolders', id);
  });
}

/** Move a deck into a folder, or out of any folder when folderId is undefined. */
export async function setDeckFolder(deckId: string, folderId: string | undefined): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], async () => {
    const deck = await db.decks.get(deckId);
    if (!deck) return;
    if (folderId) deck.folderId = folderId;
    else delete deck.folderId;
    deck.updatedAt = Date.now();
    await db.decks.put(deck);
    await stagePut('decks', deck);
  });
}

/**
 * What makes a container slot unique: the card, the board, and whether it's an
 * "any printing" basic. The last part keeps the lands-box Islands out of the
 * slot holding the Islands you actually own.
 */
const slotKey = (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean }) =>
  `${c.oracleId}|${c.board}|${c.anyBasic ? 'any' : ''}`;

/** What a slot asks of the copy filling it; every field undefined = "any". */
export interface SlotWants {
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

/**
 * The stricter identity, for filing copies you physically own: printing, finish,
 * condition and language all count. A decklist line is happy to fold "Wrath of
 * God" into one slot however many editions you feed it; a box of cards is not,
 * because the Alpha one and the beat-up Portal one are different pieces of
 * cardboard sitting in there. "Any printing" basics stay their own slot as ever.
 */
const exactSlotKey = (
  c: { oracleId: string; board: DeckBoard; anyBasic?: boolean; scryfallId?: string },
  wants: SlotWants | undefined,
) =>
  c.anyBasic
    ? slotKey(c)
    : `${c.oracleId}|${c.board}|${c.scryfallId ?? ''}|${wants?.condition ?? ''}|${wants?.finish ?? ''}|${wants?.lang ?? ''}`;

/** The wants worth storing — drops the "any" (undefined) ones. */
function wantFields(wants: SlotWants | undefined): SlotWants {
  if (!wants) return {};
  return {
    ...(wants.condition ? { condition: wants.condition } : {}),
    ...(wants.finish ? { finish: wants.finish } : {}),
    ...(wants.lang ? { lang: wants.lang } : {}),
  };
}

export interface AddDeckCardInput {
  deckId: string;
  oracleId: string;
  /** Preferred printing for the slot; falls back to the card's default. */
  scryfallId?: string;
  quantity?: number;
  board?: DeckBoard;
  /** "Any printing" basic land — see DeckCard.anyBasic. Pins no printing. */
  anyBasic?: boolean;
  /** Finish/condition/language the slot wants (e.g. copied off a collection copy). */
  wants?: SlotWants;
}

/** Add a slot, merging into an existing (deckId, oracleId, board, anyBasic) slot. */
export async function addDeckCard(input: AddDeckCardInput): Promise<void> {
  const board = input.board ?? 'main';
  const quantity = input.quantity ?? 1;
  const anyBasic = !!input.anyBasic;
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    // "Any printing" basics are their own slot: four Islands from the lands box
    // shouldn't fold into the four foil Islands you actually own.
    const existing = await db.deckCards
      .where('[deckId+board]')
      .equals([input.deckId, board])
      .and((c) => c.oracleId === input.oracleId && !!c.anyBasic === anyBasic)
      .first();
    let slot: DeckCard;
    if (existing) {
      slot = { ...existing, quantity: existing.quantity + quantity, updatedAt: now };
    } else {
      slot = {
        id: newId(),
        deckId: input.deckId,
        oracleId: input.oracleId,
        ...(anyBasic ? { anyBasic: true } : { ...(input.scryfallId ? { scryfallId: input.scryfallId } : {}), ...wantFields(input.wants) }),
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
      ...(!anyBasic && input.scryfallId ? { scryfallId: input.scryfallId } : {}),
      qty: quantity,
      deckId: input.deckId,
      ...containerRef(deck),
      board,
    });
  });
}

/**
 * Bulk-add (deck import / scan / multi-select), merging by (oracleId, board) —
 * or, with `exact`, by the full copy identity (printing + finish + condition +
 * language), which is what filing cards you own out of the collection wants.
 * Every line shares a batchId so the edit-history view collapses the whole
 * operation into one entry (labelled with the deck name).
 */
export async function addDeckCardsBulk(
  deckId: string,
  cards: Array<{
    oracleId: string;
    quantity: number;
    board: DeckBoard;
    scryfallId?: string;
    anyBasic?: boolean;
    wants?: SlotWants;
  }>,
  meta: { source?: EventSource; exact?: boolean } = {},
): Promise<void> {
  const batchId = newId();
  const keyOf = meta.exact
    ? (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean; scryfallId?: string }, w?: SlotWants) =>
        exactSlotKey(c, w)
    : (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean }) => slotKey(c);
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    // A stored slot carries its wants as plain fields, so it is its own wants.
    const map = new Map(existing.map((c) => [keyOf(c, c), c]));
    const touched = new Set<DeckCard>();
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    const deck = await touchDeck(deckId, now);
    // Default 'manual' (not 'import') so deck adds don't land in the collection
    // "Imports" filter; the batchId still collapses them into one history entry.
    const batchExtra = {
      source: meta.source ?? 'manual',
      batchId,
      ...(deck ? { batchLabel: deck.name } : {}),
    };
    for (const c of cards) {
      const ex = map.get(keyOf(c, c.wants));
      if (ex) {
        ex.quantity += c.quantity;
        // Adopt the incoming printing and wants if the slot named none of its own
        // (an "any printing" basic never takes any on).
        if (!ex.anyBasic) {
          if (!ex.scryfallId && c.scryfallId) ex.scryfallId = c.scryfallId;
          if (!ex.condition && !ex.finish && !ex.lang) Object.assign(ex, wantFields(c.wants));
        }
        ex.updatedAt = now;
        touched.add(ex);
      } else {
        const dc: DeckCard = {
          id: newId(),
          deckId,
          oracleId: c.oracleId,
          quantity: c.quantity,
          board: c.board,
          ...(c.anyBasic ? { anyBasic: true } : { scryfallId: c.scryfallId, ...wantFields(c.wants) }),
          updatedAt: now,
        };
        map.set(keyOf(c, c.wants), dc);
        touched.add(dc);
      }
      events.push({
        ts: now,
        kind: 'deck.add',
        oracleId: c.oracleId,
        ...(!c.anyBasic && c.scryfallId ? { scryfallId: c.scryfallId } : {}),
        qty: c.quantity,
        deckId,
        ...containerRef(deck),
        board: c.board,
        ...batchExtra,
      });
    }
    const writes = [...touched];
    await db.deckCards.bulkPut(writes);
    await stagePutMany('deckCards', writes);
    await emitMany(events);
  });
}

/**
 * Reconcile a deck to *exactly* the given slots (deck re-scan): matching slots
 * have their quantity set to the target, brand-new (oracleId, board) slots are
 * added, and any current slot missing from `target` is removed. Everything
 * shares one batchId — the whole re-scan collapses to a single undoable history
 * entry, labelled with the deck name. A slot whose quantity is unchanged emits
 * no event (a bare preferred-printing adoption stages silently, like
 * patchDeckCard). The user's hand-picked printing is kept; a scanned printing is
 * only adopted when the slot had none. "Any printing" basic slots sit this out
 * entirely — no camera can see a card you never sleeved. Returns the change counts.
 */
export async function reconcileDeck(
  deckId: string,
  target: Array<{ oracleId: string; board: DeckBoard; quantity: number; scryfallId?: string }>,
  meta: { source?: EventSource } = {},
): Promise<{ added: number; removed: number; changed: number }> {
  const batchId = newId();
  let added = 0;
  let removed = 0;
  let changed = 0;
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    const curMap = new Map(existing.map((c) => [slotKey(c), c]));
    const seen = new Set<string>();
    const puts: DeckCard[] = [];
    const deletes: string[] = [];
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    const deck = await touchDeck(deckId, now);
    const batchExtra = {
      source: meta.source ?? 'manual',
      batchId,
      ...(deck ? { batchLabel: deck.name } : {}),
    };
    const nameExtra = containerRef(deck);

    for (const t of target) {
      if (t.quantity <= 0) continue;
      const key = slotKey(t);
      seen.add(key);
      const cur = curMap.get(key);
      if (!cur) {
        puts.push({
          id: newId(),
          deckId,
          oracleId: t.oracleId,
          ...(t.scryfallId ? { scryfallId: t.scryfallId } : {}),
          quantity: t.quantity,
          board: t.board,
          updatedAt: now,
        });
        added++;
        events.push({
          ts: now,
          kind: 'deck.add',
          oracleId: t.oracleId,
          ...(t.scryfallId ? { scryfallId: t.scryfallId } : {}),
          qty: t.quantity,
          deckId,
          ...nameExtra,
          board: t.board,
          ...batchExtra,
        });
        continue;
      }
      const delta = t.quantity - cur.quantity;
      const scryfallId = cur.scryfallId ?? t.scryfallId;
      // Write when the quantity moved OR we're adopting a printing the slot lacked.
      if (delta !== 0 || scryfallId !== cur.scryfallId) {
        puts.push({ ...cur, quantity: t.quantity, ...(scryfallId ? { scryfallId } : {}), updatedAt: now });
      }
      if (delta !== 0) {
        changed++;
        events.push({
          ts: now,
          kind: delta > 0 ? 'deck.add' : 'deck.remove',
          oracleId: cur.oracleId,
          ...(cur.scryfallId ? { scryfallId: cur.scryfallId } : {}),
          qty: Math.abs(delta),
          deckId,
          ...nameExtra,
          board: cur.board,
          ...batchExtra,
        });
      }
    }

    for (const [key, cur] of curMap) {
      if (seen.has(key)) continue;
      // An "any printing" basic isn't a piece of cardboard the camera could have
      // seen, so a re-scan neither matches nor sweeps it away.
      if (cur.anyBasic) continue;
      deletes.push(cur.id);
      removed++;
      events.push({
        ts: now,
        kind: 'deck.remove',
        oracleId: cur.oracleId,
        ...(cur.scryfallId ? { scryfallId: cur.scryfallId } : {}),
        qty: cur.quantity,
        deckId,
        ...nameExtra,
        board: cur.board,
        ...batchExtra,
      });
    }

    if (puts.length) {
      await db.deckCards.bulkPut(puts);
      await stagePutMany('deckCards', puts);
    }
    if (deletes.length) {
      await db.deckCards.bulkDelete(deletes);
      for (const id of deletes) await stageDelete('deckCards', id);
    }
    await emitMany(events);
  });
  return { added, removed, changed };
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
      .and((c) => c.oracleId === card.oracleId && !!c.anyBasic === !!card.anyBasic)
      .first();
    if (existing) {
      // Two slots becoming one: the tags of both come along, or moving a tagged
      // card to the sideboard would quietly strip what you labelled it.
      const merged: DeckCard = {
        ...existing,
        quantity: existing.quantity + card.quantity,
        tags: normalizeCardTags([...(existing.tags ?? []), ...(card.tags ?? [])]),
        updatedAt: now,
      };
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
      ...containerRef(deck),
    };
    await emit({ ts: now, kind: 'deck.remove', ...base, board: card.board });
    await emit({ ts: now, kind: 'deck.add', ...base, board });
  });
}

/**
 * Change a slot's quantity/printing/wants; quantity ≤ 0 deletes the slot.
 * `scryfallId` and `wants` are only touched when the patch names them, and an
 * empty string / an all-undefined `wants` clears them back to "any" — so the
 * edit sheet can move a slot from a pinned foil to "any edition, any finish".
 */
async function patchDeckCard(
  id: string,
  patch: { quantity?: number; scryfallId?: string; anyBasic?: boolean; wants?: SlotWants; tags?: string[] },
): Promise<void> {
  await db.transaction('rw', DECK_TABLES, async () => {
    const card = await db.deckCards.get(id);
    if (!card) return;
    const now = Date.now();
    const quantity = patch.quantity ?? card.quantity;
    const delta = quantity - card.quantity;
    const anyBasic = patch.anyBasic ?? !!card.anyBasic;
    // A cleared want has to be written as undefined, not left off the object.
    const clearedWants: SlotWants = { condition: undefined, finish: undefined, lang: undefined };
    const wants = patch.wants ? { ...clearedWants, ...wantFields(patch.wants) } : {};

    if (quantity <= 0) {
      await db.deckCards.delete(id);
      await stageDelete('deckCards', id);
    } else {
      // The two are exclusive: a lands-box basic pins no edition (and asks
      // nothing of your copies), and pinning one turns the slot back into a copy
      // you're counting on owning.
      const next: DeckCard = {
        ...card,
        quantity,
        ...(anyBasic
          ? { anyBasic: true, scryfallId: undefined, ...clearedWants }
          : {
              anyBasic: undefined,
              ...('scryfallId' in patch ? { scryfallId: patch.scryfallId || undefined } : {}),
              ...wants,
            }),
        // Tags survive every other kind of edit; only a patch that names them
        // rewrites them (an empty list clears the slot back to untagged).
        ...('tags' in patch ? { tags: normalizeCardTags(patch.tags) } : {}),
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
        ...containerRef(deck),
        board: card.board,
      });
    }
  });
}

/** Set a slot's quantity; deletes the slot at zero. */
export async function setDeckCardQuantity(id: string, quantity: number): Promise<void> {
  await patchDeckCard(id, { quantity });
}

/** Update a slot's quantity, preferred printing and wants (deck edit sheet).
 *  An empty `scryfallId` means "any edition"; omitted wants mean "any". */
export async function updateDeckCard(
  id: string,
  patch: { quantity: number; scryfallId: string; anyBasic?: boolean; wants?: SlotWants; tags?: string[] },
): Promise<void> {
  await patchDeckCard(id, patch);
}

// ---- Card tags -------------------------------------------------------------
// A container's tags are derived: they exist because slots carry them, so there
// is no registry to keep in step, no orphan rows, and nothing extra to sync —
// a tag rides along in the slot's own row like its quantity or its finish.
// Tag edits deliberately emit no history event: nothing was added or removed
// from the container, so there is nothing to undo a card into.

/**
 * Add and/or remove tags across a set of slots — the multi-select "Tag…" action
 * lands here. Slots already in the wanted state aren't rewritten, so re-applying
 * a tag doesn't churn the sync outbox. Returns how many slots changed.
 */
export async function tagDeckCards(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<number> {
  const add = normalizeCardTags(change.add ?? []) ?? [];
  const remove = new Set((normalizeCardTags(change.remove ?? []) ?? []).map((t) => t.toLocaleLowerCase()));
  if (ids.length === 0 || (add.length === 0 && remove.size === 0)) return 0;
  let changed = 0;
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const slots = (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c);
    const writes: DeckCard[] = [];
    for (const s of slots) {
      const kept = (s.tags ?? []).filter((t) => !remove.has(t.toLocaleLowerCase()));
      const next = normalizeCardTags([...kept, ...add]);
      if (sameCardTags(s.tags, next)) continue;
      writes.push({ ...s, tags: next, updatedAt: now });
    }
    if (writes.length === 0) return;
    changed = writes.length;
    await db.deckCards.bulkPut(writes);
    await stagePutMany('deckCards', writes);
    // Selection lives on one screen, but touch each named container anyway.
    for (const deckId of new Set(writes.map((w) => w.deckId))) await touchDeck(deckId, now);
  });
  return changed;
}

/** Replace one slot's tags outright (the card sheet's tag field). */
export async function setDeckCardTags(id: string, tags: string[]): Promise<void> {
  await patchDeckCard(id, { tags });
}

/**
 * Rename a tag everywhere it appears in one container. Because tags are derived
 * from the slots carrying them, renaming *is* rewriting those slots; renaming
 * onto a tag that already exists merges the two.
 */
export async function renameDeckCardTag(deckId: string, from: string, to: string): Promise<number> {
  const target = normalizeCardTags([to])?.[0];
  const key = from.toLocaleLowerCase();
  if (!target || key === target.toLocaleLowerCase()) return 0;
  let changed = 0;
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const slots = await db.deckCards.where('deckId').equals(deckId).toArray();
    const writes: DeckCard[] = [];
    for (const s of slots) {
      if (!s.tags?.some((t) => t.toLocaleLowerCase() === key)) continue;
      const next = normalizeCardTags(s.tags.map((t) => (t.toLocaleLowerCase() === key ? target : t)));
      if (sameCardTags(s.tags, next)) continue;
      writes.push({ ...s, tags: next, updatedAt: now });
    }
    if (writes.length === 0) return;
    changed = writes.length;
    await db.deckCards.bulkPut(writes);
    await stagePutMany('deckCards', writes);
    await touchDeck(deckId, now);
  });
  return changed;
}

/** Drop a tag from every slot in one container — the tag then stops existing. */
export async function deleteDeckCardTag(deckId: string, tag: string): Promise<number> {
  const key = tag.toLocaleLowerCase();
  const slots = await db.deckCards.where('deckId').equals(deckId).toArray();
  const ids = slots.filter((s) => s.tags?.some((t) => t.toLocaleLowerCase() === key)).map((s) => s.id);
  return tagDeckCards(ids, { remove: [tag] });
}

export async function removeDeckCard(id: string): Promise<void> {
  await patchDeckCard(id, { quantity: 0 });
}

/**
 * Delete whole slots in one go (the multi-select "remove these from this deck /
 * binder / box"). Every line shares a batchId labelled with the container, so
 * the edit history shows one entry the user can undo in a single tap. Returns
 * how many copies were removed.
 */
export async function removeDeckCardsBulk(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let removed = 0;
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const batchId = newId();
    const slots = (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c);
    if (slots.length === 0) return;
    // Selection lives on one screen, so these are all one container's slots —
    // but touch each named deck anyway rather than assume it.
    const decks = new Map<string, Deck | undefined>();
    for (const deckId of new Set(slots.map((s) => s.deckId))) {
      decks.set(deckId, await touchDeck(deckId, now));
    }
    await db.deckCards.bulkDelete(slots.map((s) => s.id));
    for (const s of slots) await stageDelete('deckCards', s.id);
    for (const s of slots) removed += s.quantity;
    await emitMany(
      slots.map((s) => {
        const deck = decks.get(s.deckId);
        return {
          ts: now,
          kind: 'deck.remove' as const,
          oracleId: s.oracleId,
          ...(s.scryfallId ? { scryfallId: s.scryfallId } : {}),
          qty: s.quantity,
          deckId: s.deckId,
          ...containerRef(deck),
          board: s.board,
          source: 'manual' as const,
          batchId,
          ...(deck ? { batchLabel: deck.name } : {}),
        };
      }),
    );
  });
  return removed;
}

/**
 * Take copies of the given cards out of *another* container — the multi-select
 * fix for a card promised to two places at once. A slot matches on the card and,
 * where both sides say so, on the printing and on the finish/condition/language
 * the slot wants: the same rule the placement badges use, so what the picker
 * offered is what comes off. Up to `quantity` copies are taken per card, exact
 * printing first; a slot emptied that way is deleted. Returns how many copies
 * were removed.
 */
export async function removeDeckCardsMatching(
  containerId: string,
  cards: Array<{ oracleId: string; scryfallId?: string; quantity: number; wants?: CopyPrefs }>,
): Promise<number> {
  if (cards.length === 0) return 0;
  let removed = 0;
  await db.transaction('rw', DECK_TABLES, async () => {
    const now = Date.now();
    const batchId = newId();
    const slots = await db.deckCards.where('deckId').equals(containerId).toArray();
    const byOracle = new Map<string, DeckCard[]>();
    for (const s of slots) {
      const arr = byOracle.get(s.oracleId);
      if (arr) arr.push(s);
      else byOracle.set(s.oracleId, [s]);
    }
    // Copies taken off each slot, accumulated so two selected printings of one
    // card don't each write their own event line for the same slot.
    const taken = new Map<DeckCard, number>();
    for (const card of cards) {
      const candidates = (byOracle.get(card.oracleId) ?? []).filter(
        // A lands-box basic never claimed one of your copies, so taking it out
        // resolves nothing — it isn't a placement the picker offered either.
        (s) =>
          !s.anyBasic &&
          (!s.scryfallId || !card.scryfallId || s.scryfallId === card.scryfallId) &&
          (!card.wants || prefsCompatible(s, card.wants)),
      );
      // Exact printing first, then the edition-less slots (a pasted decklist).
      const ranked = [...candidates].sort(
        (a, b) => Number(b.scryfallId === card.scryfallId) - Number(a.scryfallId === card.scryfallId),
      );
      let remaining = card.quantity;
      for (const s of ranked) {
        if (remaining <= 0) break;
        const room = s.quantity - (taken.get(s) ?? 0);
        if (room <= 0) continue;
        const take = Math.min(room, remaining);
        taken.set(s, (taken.get(s) ?? 0) + take);
        remaining -= take;
        removed += take;
      }
    }
    if (taken.size === 0) return;
    const deck = await touchDeck(containerId, now);
    const puts: DeckCard[] = [];
    const deletes: string[] = [];
    const events: Omit<UserEvent, 'id' | 'updatedAt'>[] = [];
    taken.forEach((qty, slot) => {
      if (qty >= slot.quantity) deletes.push(slot.id);
      else puts.push({ ...slot, quantity: slot.quantity - qty, updatedAt: now });
      events.push({
        ts: now,
        kind: 'deck.remove',
        oracleId: slot.oracleId,
        ...(slot.scryfallId ? { scryfallId: slot.scryfallId } : {}),
        qty,
        deckId: containerId,
        ...containerRef(deck),
        board: slot.board,
        source: 'manual',
        batchId,
        ...(deck ? { batchLabel: deck.name } : {}),
      });
    });
    if (puts.length > 0) {
      await db.deckCards.bulkPut(puts);
      await stagePutMany('deckCards', puts);
    }
    if (deletes.length > 0) {
      await db.deckCards.bulkDelete(deletes);
      for (const id of deletes) await stageDelete('deckCards', id);
    }
    await emitMany(events);
  });
  return removed;
}

/**
 * Mark every card in a container for trade (or clear the flag), the bulk
 * "this whole box is up for grabs" action. Container slots name an oracle card
 * and (usually) a preferred printing, so each slot is matched against the
 * copies actually owned — the slot's printing first, then any other edition of
 * the same card — for up to the slot's quantity. Cards you don't own are
 * skipped, as are "any printing" basics (that slot never claimed a copy of
 * yours, so it has none to offer). Returns how many copies changed.
 */
export async function setContainerForTrade(containerId: string, forTrade: boolean): Promise<number> {
  return setSlotsForTrade(await db.deckCards.where('deckId').equals(containerId).toArray(), forTrade);
}

/**
 * The same thing for a hand-picked set of slots (multi-select in a deck, binder
 * or box). Returns how many copies changed.
 */
export async function setDeckCardsForTrade(ids: string[], forTrade: boolean): Promise<number> {
  const slots = (await db.deckCards.bulkGet(ids)).filter((s): s is DeckCard => !!s);
  return setSlotsForTrade(slots, forTrade);
}

async function setSlotsForTrade(slots: DeckCard[], forTrade: boolean): Promise<number> {
  const requests: MarkForTradeRequest[] = slots.filter((s) => !s.anyBasic).map((s) => ({
    oracleId: s.oracleId,
    scryfallId: s.scryfallId ?? '',
    // A slot that names a finish/condition/language points at the copy it means;
    // where it says "any", fall back to the usual defaults so the printing
    // decides the match and ties go to whatever's first.
    condition: s.condition ?? 'NM',
    finish: s.finish ?? 'nonfoil',
    lang: s.lang ?? 'en',
    quantity: s.quantity,
  }));
  return forTrade ? markOwnedForTrade(requests) : unmarkOwnedForTrade(requests);
}

/**
 * The inverse of markOwnedForTrade: take copies back off the tradelist,
 * preferring the requested printing. Unmarking isn't an event (nothing entered
 * or left the collection) — the same as clearing the flag from the tradelist
 * screen. Returns how many copies were unflagged.
 */
async function unmarkOwnedForTrade(requests: MarkForTradeRequest[]): Promise<number> {
  if (requests.length === 0) return 0;
  let unflagged = 0;
  await db.transaction('rw', [db.collection, db.outbox], async () => {
    const now = Date.now();
    const oracleIds = [...new Set(requests.map((r) => r.oracleId))];
    const owned = await db.collection.where('oracleId').anyOf(oracleIds).toArray();
    const byOracle = new Map<string, CollectionEntry[]>();
    for (const e of owned) {
      const arr = byOracle.get(e.oracleId);
      if (arr) arr.push(e);
      else byOracle.set(e.oracleId, [e]);
    }
    const touched = new Set<CollectionEntry>();
    for (const req of requests) {
      const entries = byOracle.get(req.oracleId);
      if (!entries) continue;
      const ranked = [...entries].sort(
        (a, b) => Number(b.scryfallId === req.scryfallId) - Number(a.scryfallId === req.scryfallId),
      );
      let remaining = req.quantity;
      for (const e of ranked) {
        if (remaining <= 0) break;
        if (e.quantityForTrade <= 0) continue;
        const take = Math.min(e.quantityForTrade, remaining);
        e.quantityForTrade -= take;
        e.updatedAt = now;
        remaining -= take;
        unflagged += take;
        touched.add(e);
      }
    }
    const writes = [...touched];
    if (writes.length > 0) {
      await db.collection.bulkPut(writes);
      await stagePutMany('collection', writes);
    }
  });
  return unflagged;
}

// ---------------------------------------------------------------------------
// Trade completion (beta plan §7). The heart of the app: on `completed`, each
// client atomically updates its own collection/wishlist and writes a Trade
// record. Keyed on the server's sessionId so a re-delivered `completed` is a
// no-op (idempotent).
// ---------------------------------------------------------------------------

/**
 * After a trade removes copies from the collection, take the shortfall out of
 * filing too — but only when there's exactly one place it could have come
 * from. Two identical copies filed in two different containers are
 * deliberately indistinguishable (see usePlacements.ts), so that case is left
 * for the filing-conflict resolver instead of guessing which one is gone.
 */
async function reconcileFilingAfterTrade(line: TradeLine, ownedAfter: number): Promise<void> {
  const slots = await db.deckCards.where('oracleId').equals(line.oracleId).toArray();
  const claiming = slots.filter(
    (s) =>
      !s.anyBasic &&
      s.scryfallId === line.scryfallId &&
      s.condition === line.condition &&
      s.finish === line.finish &&
      s.lang === line.lang,
  );
  if (claiming.length === 0) return;
  const claimed = claiming.reduce((n, s) => n + s.quantity, 0);
  const deficit = claimed - ownedAfter;
  if (deficit <= 0) return; // still enough filed copies to back every claim
  const containerIds = new Set(claiming.map((s) => s.deckId));
  if (containerIds.size !== 1) return; // more than one equally-plausible place — leave for the resolver
  const containerId = claiming[0]!.deckId;
  await removeDeckCardsMatching(containerId, [
    {
      oracleId: line.oracleId,
      scryfallId: line.scryfallId,
      quantity: deficit,
      wants: { condition: line.condition, finish: line.finish, lang: line.lang },
    },
  ]);
}

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
  const centsOf = (scryfallId: string, finish: Finish) => toCents(priceForFinish(prices.get(scryfallId), finish).eur);

  return db.transaction('rw', [db.collection, db.wishlist, db.trades, db.events, db.outbox, db.decks, db.deckCards], async () => {
    if (await db.trades.get(sessionId)) return { applied: false }; // already applied

    const entries = await db.collection.toArray();
    const byKey = new Map(entries.map((e) => [collectionKey(e), e]));
    const now = Date.now();

    // Remove given cards (decrement matching entries; reduce trade qty with them).
    for (const line of given) {
      const ex = byKey.get(collectionKey(line));
      const ownedQty = ex?.quantity ?? 0;
      const finalOwned = ex ? Math.max(0, ex.quantity - line.quantity) : 0;
      if (ex) {
        if (finalOwned <= 0) {
          await db.collection.delete(ex.id);
          await stageDelete('collection', ex.id);
          byKey.delete(collectionKey(line));
        } else {
          ex.quantity = finalOwned;
          ex.quantityForTrade = clamp(ex.quantityForTrade, 0, finalOwned);
          ex.updatedAt = now;
          await db.collection.put(ex);
          await stagePut('collection', ex);
        }
      }
      await reconcileFilingAfterTrade(line, finalOwned);
      // You can't give away what the ledger never recorded you owning. If the
      // trade hands over more copies than the collection held, backfill the
      // shortfall as an acquisition first — a history-only add (no row written;
      // it nets against the removal below) so the card reads "added, then traded
      // away" instead of a lone, dangling "traded away". ts is a hair earlier so
      // it sorts before the removal in the timeline.
      const missing = line.quantity - ownedQty;
      if (missing > 0) {
        await emit({
          ts: now,
          kind: 'collection.add',
          oracleId: line.oracleId,
          scryfallId: line.scryfallId,
          qty: missing,
          condition: line.condition,
          finish: line.finish,
          lang: line.lang,
          priceEurCents: centsOf(line.scryfallId, line.finish),
          source: 'trade',
          tradeId: sessionId,
          reconcile: true,
        });
      }
      // The event records the full traded quantity even when the card was
      // never registered (or under-registered) in the collection — the trade
      // happened either way, and the card history should say so.
      await emit({
        ts: missing > 0 ? now + 1 : now,
        kind: 'collection.remove',
        oracleId: line.oracleId,
        scryfallId: line.scryfallId,
        qty: line.quantity,
        condition: line.condition,
        finish: line.finish,
        lang: line.lang,
        priceEurCents: centsOf(line.scryfallId, line.finish),
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
        priceEurCents: centsOf(line.scryfallId, line.finish),
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

/** Change an entry's quantityForTrade by delta (reverse of a tradelist mark). */
async function tradeMarkAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!e.scryfallId || !delta) return;
  const existing = await db.collection
    .where('[scryfallId+condition+finish+lang]')
    .equals([e.scryfallId, e.condition ?? 'NM', e.finish ?? 'nonfoil', e.lang ?? 'en'])
    .first();
  if (!existing) return;
  const next: CollectionEntry = {
    ...existing,
    quantityForTrade: clamp(existing.quantityForTrade + delta, 0, existing.quantity),
    updatedAt: now,
  };
  await db.collection.put(next);
  await stagePut('collection', next);
}

/** Change a wishlist line by delta (negative removes, positive re-adds). */
async function wishlistAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!delta) return;
  const list = await db.wishlist.where('oracleId').equals(e.oracleId).toArray();
  const key = wishKey({ scryfallId: e.scryfallId ?? null, condition: e.condition, finish: e.finish, lang: e.lang });
  const match =
    list.find((w) => wishKey(w) === key) ?? list.find((w) => w.scryfallId === (e.scryfallId ?? null)) ?? list[0];
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
      condition: e.condition,
      finish: e.finish,
      lang: e.lang,
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
    case 'tradelist.mark':
      await tradeMarkAdjustRaw(e, -(e.qty ?? 1), now);
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
    // Reverse removals (which add copies back) before adds (which remove copies)
    // so a trade's backfill add + its removal on the same printing net to what
    // was truly owned, instead of a clamped-at-zero op leaving phantom copies.
    const ordered = [...events].sort(
      (a, b) => (a.kind === 'collection.remove' ? 0 : 1) - (b.kind === 'collection.remove' ? 0 : 1),
    );
    for (const e of ordered) await reverseEvent(e, now);
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

// ---------------------------------------------------------------------------
// Unopened sealed products
// ---------------------------------------------------------------------------
// A booster box still in shrink. One row per product, quantity on the row —
// unlike a collection entry there's no condition/finish/language to split on,
// so productId alone is the identity. No UserEvent is emitted: the history log
// is card-shaped (every row needs an oracleId) and a box has no cards yet.

/** What the caller knows about a product when adding it; the rest is denormalized from it. */
export interface SealedItemInput {
  productId: string;
  name: string;
  set: string;
  setName?: string;
  tcgplayerId?: string;
}

/** Add copies of an unopened product, merging into the existing row if there is one. */
export async function addSealedItem(input: SealedItemInput, copies = 1): Promise<SealedItem> {
  const add = clamp(Math.floor(copies), 1, 9999);
  return db.transaction('rw', [db.sealedItems, db.outbox], async () => {
    const now = Date.now();
    const existing = await db.sealedItems.where('productId').equals(input.productId).first();
    const row: SealedItem = existing
      ? // Refresh the denormalized display fields too: a later card-DB build may
        // have filled in a set name or a tcgplayer id the first add didn't have.
        {
          ...existing,
          name: input.name || existing.name,
          set: input.set || existing.set,
          ...(input.setName ? { setName: input.setName } : {}),
          ...(input.tcgplayerId ? { tcgplayerId: input.tcgplayerId } : {}),
          quantity: clamp(existing.quantity + add, 1, 9999),
          updatedAt: now,
        }
      : {
          id: newId(),
          productId: input.productId,
          name: input.name,
          set: input.set,
          ...(input.setName ? { setName: input.setName } : {}),
          ...(input.tcgplayerId ? { tcgplayerId: input.tcgplayerId } : {}),
          quantity: add,
          createdAt: now,
          updatedAt: now,
        };
    await db.sealedItems.put(row);
    await stagePut('sealedItems', row);
    return row;
  });
}

/** Set the owned count; a quantity of 0 or less removes the row entirely. */
export async function setSealedItemQuantity(id: string, quantity: number): Promise<void> {
  await db.transaction('rw', [db.sealedItems, db.outbox], async () => {
    const existing = await db.sealedItems.get(id);
    if (!existing) return;
    const next = Math.floor(quantity);
    if (next <= 0) {
      await db.sealedItems.delete(id);
      await stageDelete('sealedItems', id);
      return;
    }
    const row: SealedItem = { ...existing, quantity: clamp(next, 1, 9999), updatedAt: Date.now() };
    await db.sealedItems.put(row);
    await stagePut('sealedItems', row);
  });
}

export async function removeSealedItem(id: string): Promise<void> {
  await setSealedItemQuantity(id, 0);
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
      db.sealedItems.bulkAdd(data.sealedItems),
      db.wishlist.bulkAdd(data.wishlist),
      db.decks.bulkAdd(data.decks),
      db.deckCards.bulkAdd(data.deckCards),
      // deckFolders was serialized and sanitized but never restored, so a
      // transfer silently unfiled every deck on the receiving device.
      db.deckFolders.bulkAdd(data.deckFolders),
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
