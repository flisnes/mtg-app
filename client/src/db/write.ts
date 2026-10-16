import type { CollectionEntry, Deck, DeckBehavior, DeckCard, DeckFolder, SealedItem, SlotCopyFields, SyncTable, Trade, UserEvent, WishlistEntry } from '@mtg/shared';
import { db } from './schema.js';
import type { Table } from 'dexie';
import { stageDelete, stagePut, stagePutMany } from '../sync/outbox.js';
import type { NewEvent } from './events.js';
import { clamp, collectionKey, namedCopy, newId } from './keys.js';
import type { CopyRef } from './keys.js';

// ---------------------------------------------------------------------------
// Synced writes. Every mutation in the write modules must pair its Dexie write with
// staging the row in the sync outbox, inside the same transaction — a written
// row that was never staged is an edit that silently never leaves this device.
// These helpers make the pair a single call so the safe thing is also the
// short thing. db.outbox must be in the transaction scope, as ever.
// ---------------------------------------------------------------------------

/** The row type each synced table stores (SyncTable names ARE Dexie table names). */
interface SyncRow {
  collection: CollectionEntry;
  sealedItems: SealedItem;
  wishlist: WishlistEntry;
  decks: Deck;
  deckCards: DeckCard;
  deckFolders: DeckFolder;
  deckBehaviors: DeckBehavior;
  trades: Trade;
  events: UserEvent;
}

const syncedTable = <T extends SyncTable>(tbl: T) => db[tbl] as Table<SyncRow[T], string>;

/** Upsert a row and stage it for sync. */
export async function putSynced<T extends SyncTable>(tbl: T, row: SyncRow[T]): Promise<void> {
  await syncedTable(tbl).put(row);
  await stagePut(tbl, row);
}

/** Bulk upsert + stage; no-op on an empty list. */
export async function putSyncedMany<T extends SyncTable>(tbl: T, rows: SyncRow[T][]): Promise<void> {
  if (rows.length === 0) return;
  await syncedTable(tbl).bulkPut(rows);
  await stagePutMany(tbl, rows);
}

/** Delete a row and stage its tombstone (stamped now unless told later). */
export async function deleteSynced(tbl: SyncTable, id: string, updatedAt?: number): Promise<void> {
  await syncedTable(tbl).delete(id);
  await stageDelete(tbl, id, updatedAt);
}

/** Bulk delete + tombstones; no-op on an empty list. */
export async function deleteSyncedMany(tbl: SyncTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await syncedTable(tbl).bulkDelete(ids);
  for (const id of ids) await stageDelete(tbl, id);
}

/**
 * One write transaction and the bookkeeping every writer used to spell out by
 * hand: one `now`, one batchId, events collected and flushed in one bulk write,
 * each touched deck stamped once, and the copies filing touched stamped once.
 * Raw helpers that run inside a writer take the ctx instead of `(now, events)`.
 */
export interface WriteCtx {
  now: number;
  batchId: string;
  /** `updatedAt` defaults to the event's ts; pass it for an event dated in the past. */
  emit(e: NewEvent & { updatedAt?: number }, id?: string): void;
  /** The deck, read once per transaction (and not stamped). */
  getDeck(id: string): Promise<Deck | undefined>;
  /** The deck, stamped as edited when the transaction ends. */
  touchDeck(id: string): Promise<Deck | undefined>;
  /** Stamp the copies these slots name (see touchNamedCopies) when it ends. */
  touchCopies(slots: Iterable<SlotCopyFields>): void;
}

export async function write<R>(
  tables: Table[],
  fn: (ctx: WriteCtx) => Promise<R>,
  meta: BatchMeta = {},
): Promise<R> {
  return db.transaction('rw', tables, async () => {
    const now = Date.now();
    const events: UserEvent[] = [];
    const decks = new Map<string, Deck | undefined>();
    const touched = new Set<string>();
    const copies: SlotCopyFields[] = [];
    const getDeck = async (id: string) => {
      if (!decks.has(id)) decks.set(id, await db.decks.get(id));
      return decks.get(id);
    };
    const ctx: WriteCtx = {
      now,
      batchId: meta.batchId ?? newId(),
      emit: (e, id = newId()) => void events.push({ id, updatedAt: e.ts, ...e }),
      getDeck,
      touchDeck: async (id) => {
        const deck = await getDeck(id);
        if (deck) touched.add(id);
        return deck;
      },
      touchCopies: (slots) => void copies.push(...slots),
    };
    const result = await fn(ctx);
    for (const id of touched) {
      const deck = decks.get(id)!;
      deck.updatedAt = now;
      await putSynced('decks', deck);
    }
    await putSyncedMany('events', events);
    await touchNamedCopies(copies, now);
    return result;
  });
}

/**
 * Read a row, change it, stamp it and stage it. `mutate` returns false to say
 * there was nothing to change, and nothing is written.
 */
export async function patchSynced<T extends 'decks' | 'deckFolders' | 'deckCards'>(
  tbl: T,
  id: string,
  mutate: (row: SyncRow[T]) => boolean | void,
  now = Date.now(),
): Promise<SyncRow[T] | undefined> {
  const row = await syncedTable(tbl).get(id);
  if (!row || mutate(row) === false) return undefined;
  row.updatedAt = now;
  await putSynced(tbl, row);
  return row;
}

/**
 * Change a row's quantity by `delta`: grow it, shrink it, delete it at zero,
 * or (when there is no row and the delta is positive) create one with `make`.
 * A row with a tradelist count keeps it within [0, quantity]. Returns the row
 * as written, or undefined when it was deleted or never existed.
 */
export async function adjustRow<T extends 'collection' | 'wishlist' | 'deckCards'>(
  tbl: T,
  existing: SyncRow[T] | undefined,
  delta: number,
  now: number,
  make?: (qty: number) => SyncRow[T],
): Promise<SyncRow[T] | undefined> {
  if (!existing) {
    if (delta <= 0 || !make) return undefined;
    const row = make(delta);
    await putSynced(tbl, row);
    return row;
  }
  const quantity = existing.quantity + delta;
  if (quantity <= 0) {
    await deleteSynced(tbl, existing.id);
    return undefined;
  }
  const next = { ...existing, quantity, updatedAt: now };
  if ('quantityForTrade' in next) next.quantityForTrade = clamp(next.quantityForTrade, 0, quantity);
  await putSynced(tbl, next);
  return next;
}

// Transaction scopes. Collection mutations read priceShards (for the price
// stamped on events) and wishlist (for wish.fulfilled), so both are in scope.
export const COLLECTION_TABLES = [db.collection, db.wishlist, db.events, db.outbox, db.priceShards];

export const WISHLIST_TABLES = [db.wishlist, db.events, db.outbox];

// db.collection is in scope because filing a copy stamps the copy (see
// touchNamedCopies): moving cardboard into or out of a container is an edit to
// that piece of cardboard, and "Last edited" sorts on the row's own updatedAt.
export const DECK_TABLES = [db.decks, db.deckCards, db.deckBehaviors, db.collection, db.events, db.outbox];

/**
 * Lets one user action that runs through several writers (a filing that moves
 * copies out of two boxes and into a deck) land as a single history entry:
 * every writer takes the id and label instead of minting its own.
 */
export interface BatchMeta {
  batchId?: string;
  batchLabel?: string;
}

/**
 * Stamp the collection rows these slots name as edited, now.
 *
 * Filing is the one thing you can do to a piece of cardboard that leaves the
 * copy's own row untouched: it writes a deckCards row, not a collection one.
 * Everything else — quantities, tradelist marks, condition, finish, language,
 * special conditions — writes the row and stamps updatedAt on the way past.
 * "Last edited" sorts on that stamp (see components/useEntrySort.ts), so
 * without this, putting a card into a deck or pulling it out would be the only
 * edit that failed to bubble the card to the top.
 *
 * A slot names its copy by collectionKey, which since special conditions
 * arrived can match more than one row — your plain copy and your signed one
 * are both "that printing in that grade", and the slot cannot tell them apart.
 * Both get stamped, because either could be the one you just filed.
 *
 * Cheap on purpose: one indexed lookup per distinct copy, and nothing at all
 * for slots that name no cardboard, which is every brew line and every
 * lands-box basic.
 */
async function touchNamedCopies(slots: Iterable<SlotCopyFields>, now: number): Promise<void> {
  const refs = new Map<string, CopyRef>();
  for (const s of slots) {
    const ref = namedCopy(s);
    if (ref) refs.set(collectionKey(ref), ref);
  }
  if (refs.size === 0) return;
  const writes: CollectionEntry[] = [];
  for (const r of refs.values()) {
    const rows = await db.collection
      .where('[scryfallId+condition+finish+lang]')
      .equals([r.scryfallId, r.condition, r.finish, r.lang])
      .toArray();
    for (const e of rows) writes.push({ ...e, updatedAt: now });
  }
  if (writes.length === 0) return;
  await putSyncedMany('collection', writes);
}

export const DECK_FOLDER_TABLES = [db.deckFolders, db.decks, db.outbox];

// Undo can reverse any kind of event, so it needs every table they touch.
export const UNDO_TABLES = [...DECK_TABLES, db.wishlist, db.trades];
