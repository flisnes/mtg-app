import {
  deckBehaviorId,
  normalizeCardTags,
  normalizeSpecialConditions,
  prefsCompatible,
  sameCardTags,
  sanitizeContainerEmblem,
  specialKey,
} from '@mtg/shared';
import type {
  CardBehavior,
  CollectionEntry,
  Color,
  Condition,
  ContainerEmblem,
  ContainerKind,
  CopyPrefs,
  Deck,
  DeckBehavior,
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
  SpecialCondition,
  SyncTable,
  WishlistEntry,
} from '@mtg/shared';
import type { Table } from 'dexie';
import { db, USER_DATA_TABLES } from './schema.js';
import { getSetting } from './settings.js';
import { getPricesByIds } from '../cardDb/prices.js';
import { acquisitionCents } from '../price/acquisition.js';
import { stagePut, stagePutMany, stageDelete } from '../sync/outbox.js';
import { rowKeysOf } from './undoScope.js';
import { boardForFormat } from '../deck/boards.js';
import type { TransferPayload } from '../transfer/payload.js';

// The single mutation path for user data (beta plan §4). All invariants live
// here, never in UI code, so that trade completion (Phase 4) reuses the exact
// same functions:
//   - tradelist IS quantityForTrade on a CollectionEntry (0..quantity)
//   - collection entries unique on (scryfallId, condition, finish, lang) plus
//     their special conditions (collectionKey vs entryKey, below)
//   - "owned" = sum of quantity over all entries with a matching oracleId
//
// Since the sync + history plan, every mutation here also does two more
// things, in the same transaction:
//   - stages the touched rows in the sync outbox (sync/outbox.ts), and
//   - emits UserEvents (the card history: adds/removes with the market price
//    at that moment, deck ins/outs, wishlist journey).
// Changes received FROM sync are applied directly to the tables, never through
// these functions, so they are not re-staged or re-evented.

export function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Synced writes. Every mutation in this file must pair its Dexie write with
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
async function putSynced<T extends SyncTable>(tbl: T, row: SyncRow[T]): Promise<void> {
  await syncedTable(tbl).put(row);
  await stagePut(tbl, row);
}

/** Bulk upsert + stage; no-op on an empty list. */
async function putSyncedMany<T extends SyncTable>(tbl: T, rows: SyncRow[T][]): Promise<void> {
  if (rows.length === 0) return;
  await syncedTable(tbl).bulkPut(rows);
  await stagePutMany(tbl, rows);
}

/** Delete a row and stage its tombstone (stamped now unless told later). */
async function deleteSynced(tbl: SyncTable, id: string, updatedAt?: number): Promise<void> {
  await syncedTable(tbl).delete(id);
  await stageDelete(tbl, id, updatedAt);
}

/** Bulk delete + tombstones; no-op on an empty list. */
async function deleteSyncedMany(tbl: SyncTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await syncedTable(tbl).bulkDelete(ids);
  for (const id of ids) await stageDelete(tbl, id);
}

/**
 * What one piece of cardboard IS, for matching purposes: printing, condition,
 * finish, language. This is the key a deck slot claims a copy with, the key the
 * placement index counts owned copies by, and the key a trade or import line
 * spells out. Special conditions are deliberately absent — nothing about
 * matching a card cares whether it's signed.
 *
 * Not the same as a collection ROW's identity: two rows can share this key and
 * differ in their special conditions. See entryKey.
 */
export function collectionKey(e: { scryfallId: string; condition: string; finish: string; lang?: string }): string {
  return `${e.scryfallId}|${e.condition}|${e.finish}|${e.lang || 'en'}`;
}

/**
 * The uniqueness key of a collection ROW: what the card is, plus what's
 * remarkable about this particular copy. Your altered Bolt and your plain one
 * are one printing in one grade, but two lines on the shelf — marking one
 * altered must not mark the other, and adding a plain copy must not land on the
 * altered row.
 *
 * The Dexie index only covers collectionKey's four fields (a row's specials are
 * an array, which an index can't spell), so a lookup by this key queries the
 * index and then picks the row whose specials match — see findCollectionRow.
 */
export function entryKey(e: {
  scryfallId: string;
  condition: string;
  finish: string;
  lang?: string;
  special?: readonly SpecialCondition[];
}): string {
  return `${collectionKey(e)}|${specialKey(e.special)}`;
}

/**
 * The one row for a copy identity + special conditions, via the compound index.
 * Callers with no specials to name (an import line, a received trade card, an
 * undo of an add) get the ordinary copy, which is what they mean.
 */
async function findCollectionRow(
  e: { scryfallId: string; condition: Condition; finish: Finish; lang: string; special?: readonly SpecialCondition[] },
): Promise<CollectionEntry | undefined> {
  const rows = await db.collection
    .where('[scryfallId+condition+finish+lang]')
    .equals([e.scryfallId, e.condition, e.finish, e.lang])
    .toArray();
  const want = specialKey(e.special);
  return rows.find((r) => specialKey(r.special) === want);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Event emission. Events are immutable apart from the user-editable fields
// (priceEurCents, reason) — updatedAt is bumped only by editUserEvent.
// ---------------------------------------------------------------------------

type NewEvent = Omit<UserEvent, 'id' | 'updatedAt'>;

/** What an event says about how and why, beyond the card and the count. */
type EventExtra = Partial<
  Pick<UserEvent, 'source' | 'batchId' | 'batchLabel' | 'tradeId' | 'reason' | 'priceEurCents' | 'reconcile'>
>;

/** The one copy a collection-shaped event is about. */
type CopyFields = Pick<CollectionEntry, 'oracleId' | 'scryfallId' | 'condition' | 'finish' | 'lang' | 'special'>;

/** A collection.add / collection.remove / tradelist.mark event for one copy. */
function copyEvent(
  kind: 'collection.add' | 'collection.remove' | 'tradelist.mark',
  c: CopyFields,
  qty: number,
  ts: number,
  extra: EventExtra = {},
): NewEvent {
  return {
    ts,
    kind,
    oracleId: c.oracleId,
    scryfallId: c.scryfallId,
    qty,
    condition: c.condition,
    finish: c.finish,
    lang: c.lang,
    ...(c.special ? { special: c.special } : {}),
    ...extra,
  };
}

/** A wish.add / wish.remove event. Wants left as "any" are left off. */
function wishEvent(
  kind: 'wish.add' | 'wish.remove',
  w: Pick<WishlistEntry, 'oracleId' | 'scryfallId' | 'condition' | 'finish' | 'lang'>,
  qty: number,
  ts: number,
  extra: EventExtra = {},
): NewEvent {
  return {
    ts,
    kind,
    oracleId: w.oracleId,
    scryfallId: w.scryfallId,
    ...(w.condition ? { condition: w.condition } : {}),
    ...(w.finish ? { finish: w.finish } : {}),
    ...(w.lang ? { lang: w.lang } : {}),
    qty,
    ...extra,
  };
}

/** A deck.add / deck.remove event for one slot of `deck`. */
function slotEvent(
  kind: 'deck.add' | 'deck.remove',
  s: { oracleId: string; scryfallId?: string; deckId: string; board: DeckBoard },
  qty: number,
  ts: number,
  deck: Deck | undefined,
  extra: EventExtra = {},
): NewEvent {
  return {
    ts,
    kind,
    oracleId: s.oracleId,
    ...(s.scryfallId ? { scryfallId: s.scryfallId } : {}),
    qty,
    deckId: s.deckId,
    ...containerRef(deck),
    board: s.board,
    ...extra,
  };
}

/** The source/batch fields every line of one bulk operation shares. */
function batchFields(source: EventSource, batchId: string, label?: string): EventExtra {
  return { source, batchId, ...(label ? { batchLabel: label } : {}) };
}

/**
 * One write transaction and the bookkeeping every writer used to spell out by
 * hand: one `now`, one batchId, events collected and flushed in one bulk write,
 * each touched deck stamped once, and the copies filing touched stamped once.
 * Raw helpers that run inside a writer take the ctx instead of `(now, events)`.
 */
interface WriteCtx {
  now: number;
  batchId: string;
  emit(e: NewEvent, id?: string): void;
  /** The deck, read once per transaction (and not stamped). */
  getDeck(id: string): Promise<Deck | undefined>;
  /** The deck, stamped as edited when the transaction ends. */
  touchDeck(id: string): Promise<Deck | undefined>;
  /** Stamp the copies these slots name (see touchNamedCopies) when it ends. */
  touchCopies(slots: Iterable<SlotCopyFields>): void;
}

async function write<R>(
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
async function patchSynced<T extends 'decks' | 'deckFolders' | 'deckCards'>(
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
async function adjustRow<T extends 'collection' | 'wishlist' | 'deckCards'>(
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

function groupByOracle<T extends { oracleId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) push(m, r.oracleId, r);
  return m;
}

/**
 * Given a preloaded wishlist grouped by oracleId, the wish.fulfilled event for
 * one add (or null). If an added printing matches a wishlist line (null
 * scryfallId = any printing), the wish is recorded as fulfilled. The wishlist
 * itself is not changed; only trades prune it.
 */
function wishFulfilledEvent(
  wishesByOracle: Map<string, WishlistEntry[]>,
  oracleId: string,
  scryfallId: string,
  qty: number,
  ts: number,
  extra: EventExtra,
): NewEvent | null {
  const match = wishesByOracle.get(oracleId)?.find((w) => w.scryfallId === null || w.scryfallId === scryfallId);
  if (!match) return null;
  return { ts, kind: 'wish.fulfilled', oracleId, scryfallId, qty: Math.min(qty, match.quantity), ...extra };
}

/**
 * Current market price per copy of this finish in EUR cents (null = unknown).
 * Reads the price shards, so db.priceShards must be in the transaction scope
 * when this is called inside one.
 */
async function priceCents(scryfallId: string, finish: Finish): Promise<number | null> {
  const prices = await getPricesByIds([scryfallId]);
  return acquisitionCents(prices.get(scryfallId), finish);
}

/** wishFulfilledEvent for a single add, reading just that card's wishes. */
async function emitWishFulfilled(
  ctx: WriteCtx,
  oracleId: string,
  scryfallId: string,
  qty: number,
  extra: EventExtra,
): Promise<void> {
  const wishes = groupByOracle(await db.wishlist.where('oracleId').equals(oracleId).toArray());
  const ev = wishFulfilledEvent(wishes, oracleId, scryfallId, qty, ctx.now, extra);
  if (ev) ctx.emit(ev);
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
    await putSynced('events', next);
  });
}

// Transaction scopes. Collection mutations read priceShards (for the price
// stamped on events) and wishlist (for wish.fulfilled), so both are in scope.
const COLLECTION_TABLES = [db.collection, db.wishlist, db.events, db.outbox, db.priceShards];
const WISHLIST_TABLES = [db.wishlist, db.events, db.outbox];
// db.collection is in scope because filing a copy stamps the copy (see
// touchNamedCopies): moving cardboard into or out of a container is an edit to
// that piece of cardboard, and "Last edited" sorts on the row's own updatedAt.
const DECK_TABLES = [db.decks, db.deckCards, db.deckBehaviors, db.collection, db.events, db.outbox];

export interface AddToCollectionInput {
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity?: number;
  /** If set, ensures at least this many are marked for trade after the add. */
  quantityForTrade?: number;
  /** Altered / signed / misprint / … ; absent = an ordinary copy. Splits the row
   *  it lands on, so an altered copy never merges into the plain one. */
  special?: readonly SpecialCondition[];
  /** How the add was made (edit-history provenance). Defaults to 'manual'. */
  source?: EventSource;
  /** Mint the add's event id yourself to undo exactly this add afterwards
   *  (undoEntry with { type: 'single', id }). */
  eventId?: string;
}

/**
 * Add copies to the collection, merging into an existing entry that matches on
 * (scryfallId, condition, finish, lang) and the same special conditions.
 * Returns the resulting entry id.
 */
export async function addToCollection(input: AddToCollectionInput): Promise<string> {
  const qty = input.quantity ?? 1;
  const lang = input.lang || 'en';
  const special = normalizeSpecialConditions(input.special);

  return write(COLLECTION_TABLES, async (ctx) => {
    const copy = { ...input, lang, special };
    const existing = await findCollectionRow(copy);
    const forTrade = Math.max(existing?.quantityForTrade ?? 0, input.quantityForTrade ?? 0);
    const entry = existing
      ? { ...existing, quantity: existing.quantity + qty, updatedAt: ctx.now }
      : newEntry(copy, qty, forTrade, ctx.now);
    // An add only ever raises the tradelist count, to at least what it asked for.
    entry.quantityForTrade = clamp(forTrade, 0, entry.quantity);
    await putSynced('collection', entry);
    const source = input.source ?? 'manual';
    ctx.emit(
      copyEvent('collection.add', copy, qty, ctx.now, {
        priceEurCents: await priceCents(input.scryfallId, input.finish),
        source,
      }),
      input.eventId,
    );
    await emitWishFulfilled(ctx, input.oracleId, input.scryfallId, qty, { source });
    return entry.id;
  });
}

/** A fresh collection row for `qty` copies of `c`, `forTrade` of them on the tradelist. */
function newEntry(c: CopyFields, qty: number, forTrade: number, now: number): CollectionEntry {
  return {
    id: newId(),
    oracleId: c.oracleId,
    scryfallId: c.scryfallId,
    condition: c.condition,
    finish: c.finish,
    lang: c.lang,
    quantity: qty,
    quantityForTrade: clamp(forTrade, 0, qty),
    ...(c.special ? { special: c.special } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Everything a slot says about the copy it names — what it takes to find that
 *  copy's rows. A lands-box basic and a vague brew line name nothing.
 *
 *  Deliberately ignores `unfiled`, unlike claimKeyOf in deck/filing.ts: an
 *  emptied slot still names its copy, and flipping that flag is precisely the
 *  filing change worth stamping on it. */
function namedCopy(s: SlotCopyFields): CopyRef | undefined {
  if (s.anyBasic || !s.scryfallId || !s.condition || !s.finish || !s.lang) return undefined;
  return { scryfallId: s.scryfallId, condition: s.condition, finish: s.finish, lang: s.lang };
}

type SlotCopyFields = Pick<DeckCard, 'scryfallId' | 'condition' | 'finish' | 'lang' | 'anyBasic'>;
export type CopyRef = { scryfallId: string; condition: Condition; finish: Finish; lang: string };

/**
 * Lets one user action that runs through several writers (a filing that moves
 * copies out of two boxes and into a deck) land as a single history entry:
 * every writer takes the id and label instead of minting its own.
 */
export interface BatchMeta {
  batchId?: string;
  batchLabel?: string;
}

/** The one physical copy a slot names, when it names one at all — the collection
 *  key its own fields spell out. The same rule as claimKeyOf in deck/filing.ts,
 *  restated here so the mutation layer needn't import from the deck layer. */
function slotClaimKey(s: DeckCard): string | undefined {
  const ref = namedCopy(s);
  return ref && collectionKey(ref);
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

/**
 * Editing a copy's printing, condition, finish or language is a correction of
 * how it was filed in the first place, not a new card walking in: "it's the
 * Spanish one", "that's LP, not NM". So the deck, binder and box slots holding
 * this exact copy follow it to its corrected identity. Left behind they would
 * keep claiming a copy that no longer exists (an amber filing conflict) while
 * the corrected copy looked like it had never been filed at all.
 *
 * A corrected slot can land on one the container already has — fix a NM copy to
 * LP in a deck that already holds the LP one — and those merge, exactly as
 * filing the same copy there twice does. No history event either way: nothing
 * entered or left the container, the label on the sleeve just changed.
 */
async function refileEditedCopy(before: CollectionEntry, after: CollectionEntry, now: number): Promise<void> {
  const from = collectionKey(before);
  if (from === collectionKey(after)) return;
  await refileSlots(before.oracleId, from, after, Infinity, now);
}

/**
 * Re-point up to `limit` copies' worth of the slots naming copy `from` at copy
 * `to` — the mechanism behind refileEditedCopy, also used when an import's
 * "Update" swaps a copy out: the deck holding the old one is holding the new
 * one now. Oldest claim first, so a slot that outlived its copy is the first to
 * be corrected; a slot only partly covered splits, the corrected part merging
 * into any slot of the container that already names the new copy.
 */
async function refileSlots(oracleId: string, from: string, to: CopyRef, limit: number, now: number): Promise<void> {
  if (limit <= 0) return;
  const all = await db.deckCards.where('oracleId').equals(oracleId).toArray();
  const moving = all.filter((s) => slotClaimKey(s) === from).sort((a, b) => a.updatedAt - b.updatedAt);
  if (moving.length === 0) return;

  const wants: SlotWants = { condition: to.condition, finish: to.finish, lang: to.lang };
  const identity = (s: DeckCard, scryfallId = s.scryfallId, w: SlotWants = s) =>
    `${s.deckId}|${exactSlotKey({ ...s, scryfallId }, w)}`;
  const movingIds = new Set(moving.map((s) => s.id));
  // Where a corrected slot could land: every other slot of this card, keyed by
  // the copy it names, so a merge target is found the way a bulk file finds one.
  const byIdentity = new Map(all.filter((s) => !movingIds.has(s.id)).map((s) => [identity(s), s]));

  const writes = new Map<string, DeckCard>();
  const merged: string[] = [];
  let left = limit;
  for (const slot of moving) {
    if (left <= 0) break;
    const take = Math.min(left, slot.quantity);
    left -= take;
    const key = identity(slot, to.scryfallId, wants);
    const target = byIdentity.get(key);
    const rest = slot.quantity - take;
    if (target) {
      const grown: DeckCard = { ...target, quantity: target.quantity + take, updatedAt: now };
      byIdentity.set(key, grown);
      writes.set(grown.id, grown);
      if (rest > 0) writes.set(slot.id, { ...slot, quantity: rest, updatedAt: now });
      else merged.push(slot.id);
    } else if (rest > 0) {
      const split: DeckCard = { ...slot, id: newId(), quantity: take, scryfallId: to.scryfallId, ...wants, updatedAt: now };
      byIdentity.set(key, split);
      writes.set(split.id, split);
      writes.set(slot.id, { ...slot, quantity: rest, updatedAt: now });
    } else {
      const next: DeckCard = { ...slot, scryfallId: to.scryfallId, ...wants, updatedAt: now };
      byIdentity.set(key, next);
      writes.set(next.id, next);
    }
  }

  const rows = [...writes.values()];
  await putSyncedMany('deckCards', rows);
  await deleteSyncedMany('deckCards', merged);
}

/** Patch an entry. quantityForTrade is always clamped to [0, quantity]. */
export async function updateCollectionEntry(
  id: string,
  patch: Partial<
    Pick<
      CollectionEntry,
      'quantity' | 'quantityForTrade' | 'condition' | 'finish' | 'lang' | 'scryfallId' | 'special'
    >
  >,
): Promise<void> {
  // deckCards is in scope because a re-keying edit takes the copy's filing with
  // it (refileEditedCopy).
  await write([...COLLECTION_TABLES, db.deckCards], async (ctx) => {
    const entry = await db.collection.get(id);
    if (!entry) return;
    const { now } = ctx;
    const quantity = patch.quantity ?? entry.quantity;
    const rawForTrade = patch.quantityForTrade ?? entry.quantityForTrade;
    const special = 'special' in patch ? normalizeSpecialConditions(patch.special) : entry.special;
    const next: CollectionEntry = {
      ...entry,
      ...patch,
      quantity,
      quantityForTrade: clamp(rawForTrade, 0, quantity),
      updatedAt: now,
    };
    // An ordinary copy carries no field at all, so a cleared list is deleted
    // rather than stored as [] (which would sync as a different row than the
    // same copy on another device).
    if (special) next.special = special;
    else delete next.special;

    // Editing condition/finish/lang/printing — or ticking a special condition —
    // can re-key the entry onto another existing one. Row identity is not a
    // unique index in Dexie (the compound index can't cover the specials array),
    // so a naive put would leave two rows sharing a key and every later lookup
    // would pick one at random. Merge instead, the same way updateWishlistEntry
    // does on a printing collision.
    let dup: CollectionEntry | undefined;
    if (entryKey(next) !== entryKey(entry)) {
      dup = await findCollectionRow(next);
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
      await putSynced('collection', merged);
      await deleteSynced('collection', id);
    } else {
      await putSynced('collection', next);
    }

    // The copy's filing is part of the copy: a corrected printing, condition,
    // finish or language takes its deck/binder/box slots along.
    await refileEditedCopy(entry, next, now);

    // A quantity edit is a real add/remove for history purposes. Removals
    // default to 'sold' (interview decision); the History tab can re-label.
    const delta = quantity - entry.quantity;
    if (delta !== 0) {
      ctx.emit(
        copyEvent(delta > 0 ? 'collection.add' : 'collection.remove', next, Math.abs(delta), now, {
          priceEurCents: await priceCents(next.scryfallId, next.finish),
          source: 'manual',
          ...(delta < 0 ? { reason: 'sold' as RemovalReason } : {}),
        }),
      );
      if (delta > 0) await emitWishFulfilled(ctx, next.oracleId, next.scryfallId, delta, { source: 'manual' });
    }
  });
}

/** Remove copies; deletes the entry when quantity hits zero. */
export async function removeFromCollection(
  id: string,
  quantity = Infinity,
  reason: RemovalReason = 'sold',
): Promise<void> {
  await write(COLLECTION_TABLES, async (ctx) => {
    const entry = await db.collection.get(id);
    if (!entry) return;
    const removed = Math.min(entry.quantity, quantity);
    await adjustRow('collection', entry, -removed, ctx.now);
    ctx.emit(
      copyEvent('collection.remove', entry, removed, ctx.now, {
        priceEurCents: await priceCents(entry.scryfallId, entry.finish),
        source: 'manual',
        reason,
      }),
    );
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
    await putSyncedMany('collection', writes);
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
  meta: { source?: EventSource } & BatchMeta = {},
): Promise<number> {
  if (requests.length === 0) return 0;
  let flagged = 0;
  await write([db.collection, db.events, db.outbox], async (ctx) => {
    const { now } = ctx;
    const byOracle = await ownedByOracle(requests);
    // How many copies each entry gained (accumulated across requests so a
    // second request touching the same entry adds one event line, not two).
    const gained = new Map<CollectionEntry, number>();
    for (const req of requests) {
      const entries = byOracle.get(req.oracleId);
      if (!entries) continue;
      // Best match first: exact printing, then finish, then condition, and last
      // an ordinary copy over an annotated one — a scan says nothing about
      // alterations, so don't offer up the signed card while a plain one is free.
      const score = (e: CollectionEntry) =>
        (e.scryfallId === req.scryfallId ? 8 : 0) +
        (e.finish === req.finish ? 4 : 0) +
        (e.condition === req.condition ? 2 : 0) +
        (e.special?.length ? 0 : 1);
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
    await putSyncedMany('collection', writes);
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel);
    for (const e of writes) ctx.emit(copyEvent('tradelist.mark', e, gained.get(e)!, now, extra));
  }, meta);
  return flagged;
}

/** The owned rows of every card the requests name, grouped by oracleId. */
async function ownedByOracle(requests: { oracleId: string }[]): Promise<Map<string, CollectionEntry[]>> {
  const oracleIds = [...new Set(requests.map((r) => r.oracleId))];
  return groupByOracle(await db.collection.where('oracleId').anyOf(oracleIds).toArray());
}

/** Delete many collection entries outright in one transaction (bulk delete). */
export async function removeCollectionEntriesBulk(ids: string[], reason: RemovalReason = 'sold'): Promise<void> {
  if (ids.length === 0) return;
  await write(COLLECTION_TABLES, async (ctx) => {
    const entries = (await db.collection.bulkGet(ids)).filter((e): e is CollectionEntry => !!e);
    const prices = await getPricesByIds(entries.map((e) => e.scryfallId));
    await deleteSyncedMany('collection', entries.map((e) => e.id));
    for (const e of entries) {
      ctx.emit(
        copyEvent('collection.remove', e, e.quantity, ctx.now, {
          priceEurCents: acquisitionCents(prices.get(e.scryfallId), e.finish),
          source: 'manual',
          reason,
        }),
      );
    }
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
  /** Mint the add's event id yourself to undo exactly this add afterwards
   *  (undoEntry with { type: 'single', id }). */
  eventId?: string;
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

  return write(WISHLIST_TABLES, async (ctx) => {
    const wish = { oracleId: input.oracleId, scryfallId, condition, finish, lang };
    const key = wishKey(wish);
    const candidates = await db.wishlist.where('oracleId').equals(input.oracleId).toArray();
    const existing = candidates.find((w) => wishKey(w) === key);
    const entry = await adjustRow('wishlist', existing, qty, ctx.now, (q) => newWish(wish, q, ctx.now));
    ctx.emit(wishEvent('wish.add', wish, qty, ctx.now, { source: input.source ?? 'manual' }), input.eventId);
    return entry!.id;
  });
}

/** A fresh wishlist line for `qty` copies. Wants left as "any" are left off. */
function newWish(
  w: Pick<WishlistEntry, 'oracleId' | 'scryfallId' | 'condition' | 'finish' | 'lang'>,
  qty: number,
  now: number,
): WishlistEntry {
  return {
    id: newId(),
    oracleId: w.oracleId,
    scryfallId: w.scryfallId,
    ...(w.condition ? { condition: w.condition } : {}),
    ...(w.finish ? { finish: w.finish } : {}),
    ...(w.lang ? { lang: w.lang } : {}),
    quantity: qty,
    createdAt: now,
    updatedAt: now,
  };
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
  meta: { label?: string; source?: EventSource } & BatchMeta = {},
): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  await write(WISHLIST_TABLES, async (ctx) => {
    const { now } = ctx;
    const extra = batchFields(meta.source ?? 'import', ctx.batchId, meta.label);
    const oracleIds = [...new Set(lines.map((l) => l.oracleId))];
    const existing = await db.wishlist.where('oracleId').anyOf(oracleIds).toArray();
    const keyOf = (l: { oracleId: string; scryfallId: string | null; condition?: Condition; finish?: Finish; lang?: string }) =>
      `${l.oracleId}|${wishKey(l)}`;
    const map = new Map(existing.map((e) => [keyOf(e), e]));
    const touched = new Set<WishlistEntry>();
    for (const l of lines) {
      cards += l.quantity;
      const ex = map.get(keyOf(l));
      if (ex) {
        ex.quantity += l.quantity;
        ex.updatedAt = now;
        touched.add(ex);
      } else {
        const entry = newWish(l, l.quantity, now);
        map.set(keyOf(l), entry);
        touched.add(entry);
      }
      ctx.emit(wishEvent('wish.add', l, l.quantity, now, extra));
    }
    await putSyncedMany('wishlist', [...touched]);
  }, meta);
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
  await write(WISHLIST_TABLES, async (ctx) => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const { now } = ctx;
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
      await putSynced('wishlist', merged);
      await deleteSynced('wishlist', id);
    } else {
      const next: WishlistEntry = { ...entry, scryfallId, condition, finish, lang, quantity, updatedAt: now };
      await putSynced('wishlist', next);
    }
    // A quantity edit is a wish add/remove for history and undo, same as the
    // collection's. Named for the line it lands on (the edited printing).
    const delta = quantity - entry.quantity;
    if (delta !== 0) {
      const wish = { oracleId: entry.oracleId, scryfallId, condition, finish, lang };
      ctx.emit(wishEvent(delta > 0 ? 'wish.add' : 'wish.remove', wish, Math.abs(delta), now, { source: 'manual' }));
    }
  });
}

/** Decrement a wishlist entry by quantity; deletes it at zero. */
export async function removeFromWishlist(id: string, quantity = Infinity): Promise<void> {
  await write(WISHLIST_TABLES, async (ctx) => {
    const entry = await db.wishlist.get(id);
    if (!entry) return;
    const removed = Math.min(entry.quantity, quantity);
    await adjustRow('wishlist', entry, -removed, ctx.now);
    ctx.emit(wishEvent('wish.remove', entry, removed, ctx.now, { source: 'manual' }));
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
 * entries on (scryfallId, condition, finish, lang). An import line says nothing
 * about special conditions, so it merges with the ordinary copy and leaves an
 * altered or signed row of the same printing alone. Same invariants as
 * addToCollection, but bulk (fast enough for a 1000+ card import).
 *
 * `removals` is how "Update" is applied (import and scan alike): remove exactly
 * N copies from specific existing entries (by id) before adding the new lines,
 * so an incoming printing swaps in for a chosen owned copy without wiping the
 * rest. It happens in the same batch as the adds — one undo restores all.
 * A removal that says what it swaps in for (`to`) is a correction of the copy,
 * so the slots holding the old copy follow it (see refileSlots); left behind
 * they'd claim a card that no longer exists and raise a filing conflict about
 * a swap the user just made on purpose. The slot relabel isn't undone with the
 * import, same as correcting a copy from its sheet.
 */
export async function applyImport(
  lines: ImportLine[],
  meta: {
    source?: 'import' | 'sealed' | 'scan';
    label?: string;
    removals?: { id: string; qty: number; to?: CopyRef }[];
  } & BatchMeta = {},
): Promise<{ entries: number; cards: number }> {
  let cards = 0;
  // Every line of one import/sealed add shares a batchId, so the edit-history
  // view can collapse the whole operation into a single entry.
  const source = meta.source ?? 'import';
  const removals = meta.removals ?? [];
  await write([...COLLECTION_TABLES, db.decks, db.deckCards], async (ctx) => {
    const { now } = ctx;
    const extra = batchFields(source, ctx.batchId, meta.batchLabel ?? meta.label);
    // Only the rows these lines can land on (same card) and the rows the
    // removals name, read once so a row both removed from and merged into is
    // one object. Not the whole collection: a one-card scan commit was reading
    // every row you own.
    const oracleIds = [...new Set(lines.map((l) => l.oracleId))];
    const byId = new Map<string, CollectionEntry>();
    for (const e of await db.collection.where('oracleId').anyOf(oracleIds).toArray()) byId.set(e.id, e);
    for (const e of await db.collection.bulkGet(removals.map((r) => r.id))) if (e && !byId.has(e.id)) byId.set(e.id, e);
    const map = new Map([...byId.values()].map((e) => [entryKey(e), e]));
    // A Set (not `writes.includes`) so re-touching an entry is O(1), not O(n);
    // events are accumulated and flushed once instead of two IDB ops per line.
    const touched = new Set<CollectionEntry>();
    const wishesByOracle = groupByOracle(await db.wishlist.where('oracleId').anyOf(oracleIds).toArray());
    // One bulk price lookup for the price on every line's and removal's event.
    const prices = await getPricesByIds([
      ...lines.map((l) => l.scryfallId),
      ...removals.map((r) => byId.get(r.id)?.scryfallId).filter((s): s is string => !!s),
    ]);

    if (removals.length > 0) {
      for (const r of removals) {
        const e = byId.get(r.id);
        if (!e) continue;
        const take = Math.min(r.qty, e.quantity);
        if (take <= 0) continue;
        const remaining = e.quantity - take;
        const next = await adjustRow('collection', e, -take, now);
        if (next) {
          // Later lines merging onto this row see what the removal left.
          Object.assign(e, next);
        } else {
          map.delete(entryKey(e));
        }
        if (r.to) {
          // Only the slots the remaining copies can no longer back move along;
          // a copy that stays on the shelf keeps its filing.
          const from = collectionKey(e);
          const claimed = (await db.deckCards.where('oracleId').equals(e.oracleId).toArray())
            .filter((s) => slotClaimKey(s) === from)
            .reduce((n, s) => n + s.quantity, 0);
          await refileSlots(e.oracleId, from, r.to, Math.min(take, Math.max(0, claimed - remaining)), now);
        }
        ctx.emit(
          copyEvent('collection.remove', e, take, now, {
            priceEurCents: acquisitionCents(prices.get(e.scryfallId), e.finish),
            reason: 'other',
            ...extra,
          }),
        );
      }
    }

    for (const l of lines) {
      const copy = { ...l, lang: l.lang || 'en', special: undefined };
      const k = entryKey(copy);
      cards += l.quantity;
      const ex = map.get(k);
      if (ex) {
        ex.quantity += l.quantity;
        ex.quantityForTrade = clamp(Math.max(ex.quantityForTrade, l.quantityForTrade), 0, ex.quantity);
        ex.updatedAt = now;
        touched.add(ex);
      } else {
        const entry = newEntry(copy, l.quantity, l.quantityForTrade, now);
        map.set(k, entry);
        touched.add(entry);
      }
      ctx.emit(
        copyEvent('collection.add', copy, l.quantity, now, {
          priceEurCents: acquisitionCents(prices.get(l.scryfallId), l.finish),
          ...extra,
        }),
      );
      const wf = wishFulfilledEvent(wishesByOracle, l.oracleId, l.scryfallId, l.quantity, now, {
        source,
        batchId: ctx.batchId,
      });
      if (wf) ctx.emit(wf);
    }
    await putSyncedMany('collection', [...touched]);
  }, meta);
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
    }
    await putSyncedMany('collection', entries);
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
    await putSynced('decks', deck);
  });
  return deck.id;
}

export async function renameDeck(id: string, name: string): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', id, (deck) => {
      deck.name = name.trim() || UNTITLED[deck.kind ?? 'deck'];
    }),
  );
}

export async function setDeckFormat(id: string, format: DeckFormat): Promise<void> {
  await write([...DECK_TABLES, db.oracleCards], async (ctx) => {
    const deck = await ctx.touchDeck(id);
    if (!deck) return;
    deck.format = format;
    await tidyBoardsRaw(ctx, id, format === 'commander');
  });
}

/**
 * Put every slot in a zone its deck's format has (see boardForFormat): a
 * Commander deck's sideboard goes to its Companion zone and Considering, and
 * a companion leaving Commander goes back to the sideboard. No history: this
 * is the app keeping its own shape, not something you did.
 */
async function tidyBoardsRaw(ctx: WriteCtx, deckId: string, commanderDeck: boolean): Promise<number> {
  const slots = await db.deckCards.where('deckId').equals(deckId).toArray();
  const strays = slots.filter((s) => s.board === (commanderDeck ? 'side' : 'companion'));
  if (strays.length === 0) return 0;
  const oracles = await db.oracleCards.bulkGet(strays.map((s) => s.oracleId));
  let taken = slots.some((s) => s.board === 'companion');
  let moved = 0;
  for (const [i, s] of strays.entries()) {
    const board = boardForFormat(s.board, oracles[i], commanderDeck, taken);
    if (!board) continue;
    if (board === 'companion') taken = true;
    // An MTGA list names its companion twice, once up top and once in the
    // sideboard. Folding the two would make it a playset of two.
    if (board === 'side' && slots.some((o) => o.board === 'side' && o.oracleId === s.oracleId)) {
      await deleteSynced('deckCards', s.id);
      continue;
    }
    moved += await moveSlotRaw(ctx, s.id, board, null);
  }
  return moved;
}

/** Tidy a deck's zones for its format (the deck page runs this on open, which
 *  catches decks from before the Companion zone and edits from older builds). */
export async function tidyDeckBoards(deckId: string): Promise<number> {
  let moved = 0;
  await write([...DECK_TABLES, db.oracleCards], async (ctx) => {
    const deck = await ctx.getDeck(deckId);
    if (!deck || (deck.kind ?? 'deck') !== 'deck') return;
    moved = await tidyBoardsRaw(ctx, deckId, (deck.format ?? 'casual') === 'commander');
  });
  return moved;
}

/**
 * Set (or clear, with undefined) the picture or symbol this container wears in
 * the list. Sanitized on the way in like a row off the wire — the picker is the
 * only caller today, but the emblem ends up in a CSS class name.
 */
export async function setDeckEmblem(id: string, emblem: ContainerEmblem | undefined): Promise<void> {
  const clean = emblem && sanitizeContainerEmblem(emblem);
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', id, (deck) => {
      if (clean) deck.emblem = clean;
      else delete deck.emblem;
    }),
  );
}

export async function deleteDeck(id: string): Promise<void> {
  await write(DECK_TABLES, async (ctx) => {
    const deck = await ctx.getDeck(id);
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    for (const c of cards) ctx.emit(slotEvent('deck.remove', c, c.quantity, ctx.now, deck));
    await deleteSyncedMany('deckCards', cards.map((c) => c.id));
    // Authored behavior belongs to the deck, so it goes with it. Tombstoned one
    // by one rather than dropped locally: a row nobody deletes on the server is
    // a row that comes back on the next pull.
    const behaviors = await db.deckBehaviors.where('deckId').equals(id).toArray();
    await deleteSyncedMany('deckBehaviors', behaviors.map((b) => b.id));
    await deleteSynced('decks', id);
    // Deleting the container unfiles everything that was in it.
    ctx.touchCopies(cards);
  });
}

// ---------------------------------------------------------------------------
// Card behavior. What the user says a card does in this deck, overriding the
// card database's reading of its oracle text. See shared/src/behavior.ts.
// The readers live in db/behaviors.ts so the sanitizer (and the 40 kB
// vocabulary it needs) stays out of the boot chunk.
// ---------------------------------------------------------------------------

/**
 * Write one card's behavior, or clear it with null.
 *
 * Clearing stores nothing rather than an empty rule list: "this card does
 * nothing" and "we never asked" are the same instruction to the sequencer, and
 * only one of them should count towards the authored number on the coverage
 * line.
 *
 * Stamped after the row it replaces, not just at Date.now(). The rule on
 * screen may have come from another device whose clock runs ahead, and sync
 * is last-writer-wins on those stamps: an edit stamped earlier than what it
 * edits loses on the server, which hands the old rule back a couple of
 * seconds after the toast said it saved.
 */
export async function setCardBehavior(deckId: string, oracleId: string, behavior: CardBehavior | null): Promise<void> {
  const rowId = deckBehaviorId(deckId, oracleId);
  await db.transaction('rw', [db.deckBehaviors, db.outbox], async () => {
    const existing = await db.deckBehaviors.get(rowId);
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    if (!behavior || (behavior.rules.length === 0 && !behavior.cast?.length)) {
      if (!existing) return;
      await deleteSynced('deckBehaviors', rowId, updatedAt);
      return;
    }
    const row: DeckBehavior = { id: rowId, deckId, oracleId, behavior, updatedAt };
    await putSynced('deckBehaviors', row);
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
    await putSynced('deckFolders', folder);
  });
  return folder.id;
}

export async function renameDeckFolder(id: string, name: string): Promise<void> {
  await db.transaction('rw', [db.deckFolders, db.outbox], () =>
    patchSynced('deckFolders', id, (folder) => {
      folder.name = name.trim() || UNTITLED_FOLDER;
    }),
  );
}

/** Delete a folder; the decks inside it become unorganized, not deleted. */
export async function deleteDeckFolder(id: string): Promise<void> {
  await db.transaction('rw', DECK_FOLDER_TABLES, async () => {
    const now = Date.now();
    const members = await db.decks.where('folderId').equals(id).toArray();
    for (const deck of members) {
      delete deck.folderId;
      deck.updatedAt = now;
      await putSynced('decks', deck);
    }
    await deleteSynced('deckFolders', id);
  });
}

/** Move a deck into a folder, or out of any folder when folderId is undefined. */
export async function setDeckFolder(deckId: string, folderId: string | undefined): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', deckId, (deck) => {
      if (folderId) deck.folderId = folderId;
      else delete deck.folderId;
    }),
  );
}

/**
 * Archive a deck, or bring it back. Nothing is deleted: the list, the slots and
 * the history all stay exactly as they were, the deck just moves out of the deck
 * list into the Archived folder. It keeps its `folderId` too, so restoring it
 * drops it back into the folder it came from.
 *
 * Taking the cardboard out is a separate question the caller asks (see
 * `unfileWholeContainer`) — a deck you archived because the season ended is
 * still assembled in its box.
 */
export async function setDeckArchived(deckId: string, archived: boolean): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', deckId, (deck) => {
      if (!!deck.archivedAt === archived) return false;
      if (archived) deck.archivedAt = Date.now();
      else delete deck.archivedAt;
    }),
  );
}

/**
 * Take every card out of a container in one go, leaving the list untouched —
 * disassembling a deck without losing what was in it. The multi-select "Unfile…"
 * with nothing left unselected; see setDeckCardsUnfiled for what a slot keeps.
 *
 * Returns the copies freed.
 */
export async function unfileWholeContainer(deckId: string): Promise<number> {
  return write(DECK_TABLES, async (ctx) =>
    setSlotsUnfiled(ctx, await db.deckCards.where('deckId').equals(deckId).toArray(), true),
  );
}

/** Copies a container is holding right now — what unfiling it would free. */
export async function countFiledCopies(deckId: string): Promise<number> {
  const slots = await db.deckCards.where('deckId').equals(deckId).toArray();
  return slots.reduce((n, s) => n + (filedCopy(s) ? s.quantity : 0), 0);
}

/** Does this slot hold one of your copies? The test setDeckCardsUnfiled applies:
 *  a brew line or an "any printing" basic never held cardboard. */
function filedCopy(s: DeckCard): boolean {
  return !s.anyBasic && !!s.scryfallId && !!s.condition && !!s.finish && !!s.lang && !s.unfiled;
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
  c: { oracleId: string; board: DeckBoard; anyBasic?: boolean; scryfallId?: string; unfiled?: boolean },
  wants: SlotWants | undefined,
) =>
  c.anyBasic
    ? slotKey(c)
    : // An emptied-out slot (DeckCard.unfiled) is its own line: filing the card
      // back in must land on cardboard that's actually here, not quietly bump
      // the line that says the deck is missing it.
      `${c.oracleId}|${c.board}|${c.scryfallId ?? ''}|${wants?.condition ?? ''}|${wants?.finish ?? ''}|${wants?.lang ?? ''}|${c.unfiled ? 'out' : ''}`;

/**
 * How little a slot says about the copy filling it: 2 = no printing, no traits
 * (a pasted decklist line), 1 = a printing only, 0 = a named physical copy. The
 * deck re-scan re-points the vaguest slot it can find before it describes a
 * copy it can't match.
 */
const vagueness = (s: DeckCard) => (s.condition || s.finish || s.lang ? 0 : s.scryfallId ? 1 : 2);

/** Append to a Map of buckets, creating the bucket on first use. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const cur = map.get(key);
  if (cur) cur.push(value);
  else map.set(key, [value]);
}

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

/**
 * Add a slot, merging into the one that already names the same copy — printing,
 * finish, condition and language, the same `exactSlotKey` a bulk filing uses. A
 * slot is identified by what it names, so the two Nazgûl arts you picked in the
 * edition picker stay two lines in the binder, and adding a third of the first
 * one lands on the line that's already there. A slot that names no printing is
 * the "any printing" line, and repeat adds pile onto it as ever.
 *
 * Folding editions together by name is a *decklist* thing (a pasted list wants
 * one "4 Lightning Bolt" line however many printings it mentions), and that
 * lives in `addDeckCardsBulk` without `exact` — not here, where every add came
 * from a person looking at one card.
 */
export async function addDeckCard(input: AddDeckCardInput): Promise<void> {
  const board = input.board ?? 'main';
  const quantity = input.quantity ?? 1;
  const anyBasic = !!input.anyBasic;
  const wants = wantFields(input.wants);
  // "Any printing" basics are their own slot: four Islands from the lands box
  // shouldn't fold into the four foil Islands you actually own.
  const key = exactSlotKey({ oracleId: input.oracleId, board, anyBasic, scryfallId: input.scryfallId || undefined }, wants);
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    if (board === 'companion') {
      // One companion a deck: setting a new one moves the old one to Considering,
      // and setting the same one again is not a second copy of it.
      const seated = await db.deckCards.where('[deckId+board]').equals([input.deckId, 'companion']).toArray();
      if (seated.some((s) => s.oracleId === input.oracleId)) return;
      for (const s of seated) await moveSlotRaw(ctx, s.id, 'maybe', { source: 'manual' });
    }
    const candidates = await db.deckCards
      .where('[deckId+board]')
      .equals([input.deckId, board])
      .and((c) => c.oracleId === input.oracleId)
      .toArray();
    // A stored slot carries its wants as plain fields, so it is its own wants.
    const existing = candidates.find((c) => exactSlotKey(c, c) === key);
    let slot: DeckCard;
    if (existing) {
      slot = { ...existing, quantity: existing.quantity + quantity, updatedAt: now };
    } else {
      slot = {
        id: newId(),
        deckId: input.deckId,
        oracleId: input.oracleId,
        ...(anyBasic ? { anyBasic: true } : { ...(input.scryfallId ? { scryfallId: input.scryfallId } : {}), ...wants }),
        quantity,
        board,
        updatedAt: now,
      };
    }
    await putSynced('deckCards', slot);
    const deck = await ctx.touchDeck(input.deckId);
    const named = { ...input, scryfallId: anyBasic ? undefined : input.scryfallId, board };
    ctx.emit(slotEvent('deck.add', named, quantity, now, deck));
    ctx.touchCopies([slot]);
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
  meta: { source?: EventSource; exact?: boolean } & BatchMeta = {},
): Promise<void> {
  const keyOf = meta.exact
    ? (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean; scryfallId?: string }, w?: SlotWants) =>
        exactSlotKey(c, w)
    : (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean }) => slotKey(c);
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    // A stored slot carries its wants as plain fields, so it is its own wants.
    const map = new Map(existing.map((c) => [keyOf(c, c), c]));
    const touched = new Set<DeckCard>();
    const deck = await ctx.touchDeck(deckId);
    // Default 'manual' (not 'import') so deck adds don't land in the collection
    // "Imports" filter; the batchId still collapses them into one history entry.
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel ?? deck?.name);
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
      const named = { ...c, scryfallId: c.anyBasic ? undefined : c.scryfallId, deckId };
      ctx.emit(slotEvent('deck.add', named, c.quantity, now, deck, extra));
    }
    const writes = [...touched];
    await putSyncedMany('deckCards', writes);
    ctx.touchCopies(writes);
  }, meta);
}

/**
 * Reconcile a deck to *exactly* the given slots (deck re-scan): matching slots
 * have their quantity set to the target, copies the deck didn't list get a new
 * slot, and any current slot the scan didn't see is removed. Everything shares
 * one batchId — the whole re-scan collapses to a single undoable history entry,
 * labelled with the deck name. A slot whose quantity is unchanged emits no event
 * (a bare re-pin stages silently, like patchDeckCard). "Any printing" basic slots
 * sit this out entirely — no camera can see a card you never sleeved. Returns the
 * change counts.
 *
 * Targets are *copies*, not decklist lines: each one names a printing and its
 * traits, so a re-scan files what it saw the same way every other route into a
 * container does (see deck/filing.ts). Matching is exact first — same printing,
 * same finish, condition and language — then falls back to the vaguest slot the
 * deck has for that card, which the scan re-points at the cardboard the camera
 * actually found. That keeps the slot (and its tags) instead of sweeping a
 * pasted decklist line away and adding a copy beside it.
 */
export async function reconcileDeck(
  deckId: string,
  target: Array<{ oracleId: string; board: DeckBoard; quantity: number; scryfallId?: string; wants?: SlotWants }>,
  meta: { source?: EventSource } & BatchMeta = {},
): Promise<{ added: number; removed: number; changed: number }> {
  let added = 0;
  let removed = 0;
  let changed = 0;
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    // An "any printing" basic isn't a piece of cardboard the camera could have
    // seen, so a re-scan neither matches nor sweeps it away.
    const slots = existing.filter((c) => !c.anyBasic);
    const byCopy = new Map<string, DeckCard[]>();
    const byCard = new Map<string, DeckCard[]>();
    for (const s of slots) {
      // Match an emptied-out slot (DeckCard.unfiled) as if it were filed: the
      // camera just saw the card, so it's holding its copy again.
      push(byCopy, exactSlotKey({ ...s, unfiled: false }, s), s);
      push(byCard, slotKey(s), s);
    }
    // Which slot each scanned copy lands on: exact first, then a re-point.
    const taken = new Set<string>();
    const pairs: Array<{ t: (typeof target)[number]; cur?: DeckCard }> = [];
    for (const t of target) {
      if (t.quantity <= 0) continue;
      const cur = (byCopy.get(exactSlotKey(t, t.wants)) ?? []).find((s) => !taken.has(s.id));
      if (cur) taken.add(cur.id);
      pairs.push({ t, cur });
    }
    for (const p of pairs) {
      if (p.cur) continue;
      // Vaguest slot first: a line naming no printing and no traits is a brew
      // line the scan can pin outright, ahead of one describing another copy.
      const free = (byCard.get(slotKey(p.t)) ?? []).filter((s) => !taken.has(s.id)).sort((a, b) => vagueness(b) - vagueness(a));
      if (free.length === 0) continue;
      p.cur = free[0];
      taken.add(free[0]!.id);
    }
    const puts: DeckCard[] = [];
    const deletes: string[] = [];
    // Slots the re-scan swept away, kept so the copies they held get stamped.
    const swept: DeckCard[] = [];
    const deck = await ctx.touchDeck(deckId);
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel ?? deck?.name);

    for (const { t, cur } of pairs) {
      if (!cur) {
        puts.push({
          id: newId(),
          deckId,
          oracleId: t.oracleId,
          ...(t.scryfallId ? { scryfallId: t.scryfallId } : {}),
          ...wantFields(t.wants),
          quantity: t.quantity,
          board: t.board,
          updatedAt: now,
        });
        added++;
        ctx.emit(slotEvent('deck.add', { ...t, deckId }, t.quantity, now, deck, extra));
        continue;
      }
      const delta = t.quantity - cur.quantity;
      // A scan is the ground truth about cardboard, so the slot takes on the
      // printing and the traits of the copy the camera saw. That's what makes it
      // hold that copy (claimKeyOf) and go green, instead of staying a brew line
      // claiming nothing.
      const scryfallId = t.scryfallId ?? cur.scryfallId;
      const wants = wantFields(t.wants);
      const repinned =
        scryfallId !== cur.scryfallId ||
        wants.condition !== cur.condition ||
        wants.finish !== cur.finish ||
        wants.lang !== cur.lang;
      // Write when the quantity moved OR the slot now names a different copy OR
      // it said the card wasn't here (DeckCard.unfiled).
      if (delta !== 0 || repinned || cur.unfiled) {
        puts.push({
          ...cur,
          quantity: t.quantity,
          ...(scryfallId ? { scryfallId } : {}),
          condition: undefined,
          finish: undefined,
          lang: undefined,
          ...wants,
          unfiled: undefined,
          updatedAt: now,
        });
      }
      if (delta !== 0) {
        changed++;
        ctx.emit(slotEvent(delta > 0 ? 'deck.add' : 'deck.remove', cur, Math.abs(delta), now, deck, extra));
      }
    }

    for (const cur of slots) {
      if (taken.has(cur.id)) continue;
      deletes.push(cur.id);
      swept.push(cur);
      removed++;
      ctx.emit(slotEvent('deck.remove', cur, cur.quantity, now, deck, extra));
    }

    await putSyncedMany('deckCards', puts);
    await deleteSyncedMany('deckCards', deletes);
    ctx.touchCopies([...puts, ...swept]);
  }, meta);
  return { added, removed, changed };
}

/**
 * Move one slot to another board inside an already-open transaction, merging
 * into the slot that card already has there. Returns the copies moved (0 when
 * the slot is gone or already on that board). Events carry `extra`, so a bulk
 * move can stamp them all with one batchId; a null `extra` records no history
 * (the app tidying its own zones).
 */
async function moveSlotRaw(ctx: WriteCtx, id: string, board: DeckBoard, extra: EventExtra | null): Promise<number> {
  const { now } = ctx;
  const card = await db.deckCards.get(id);
  if (!card || card.board === board) return 0;
  // A deck has one companion: setting a new one sends the old one to
  // Considering, in the same batch, so one undo swaps them back.
  if (board === 'companion') {
    const seated = await db.deckCards.where('[deckId+board]').equals([card.deckId, 'companion']).toArray();
    for (const s of seated) {
      if (s.oracleId !== card.oracleId) await moveSlotRaw(ctx, s.id, 'maybe', extra);
    }
  }
  if (await mergeIntoSlot(card, card.deckId, board, now)) await deleteSynced('deckCards', id);
  else await putSynced('deckCards', { ...card, board, updatedAt: now });
  const deck = await ctx.touchDeck(card.deckId);
  // A move is a leave and an arrival: the pair is what the history reads, and
  // what undo replays backwards to put the card back where it was.
  if (extra) {
    ctx.emit(slotEvent('deck.remove', card, card.quantity, now, deck, extra));
    ctx.emit(slotEvent('deck.add', { ...card, board }, card.quantity, now, deck, extra));
  }
  ctx.touchCopies([card]);
  return card.quantity;
}

/**
 * Fold `card` into the slot that card already has on `board` of `deckId`, when
 * there is one. Two slots becoming one: the tags of both come along, or moving
 * a tagged card to the sideboard would quietly strip what you labelled it.
 * Returns whether it merged; the caller deletes or re-homes `card` either way.
 */
async function mergeIntoSlot(card: DeckCard, deckId: string, board: DeckBoard, now: number): Promise<boolean> {
  const existing = await db.deckCards
    .where('[deckId+board]')
    .equals([deckId, board])
    .and((c) => c.oracleId === card.oracleId && !!c.anyBasic === !!card.anyBasic)
    .first();
  if (!existing) return false;
  await putSynced('deckCards', {
    ...existing,
    quantity: existing.quantity + card.quantity,
    tags: normalizeCardTags([...(existing.tags ?? []), ...(card.tags ?? [])]),
    updatedAt: now,
  });
  return true;
}

/** Move a slot to another board, merging into an existing slot for the same card there. */
export async function moveDeckCard(id: string, board: DeckBoard): Promise<void> {
  // The leave/arrive pair is one thing the user did, so it shares a batchId
  // and reads as a single "Moved to …" entry (which undoes in one tap).
  await write(DECK_TABLES, async (ctx) => {
    await moveSlotRaw(ctx, id, board, { source: 'manual', batchId: ctx.batchId });
  });
}

/**
 * Move slots out of one container and into another (cut here, paste there).
 *
 * The whole thing is one batch, so it reads as a single move in the history and
 * comes back in one undo — and because that batch names both containers, the
 * undo is offered at either end. Pasting on the far side is usually the only
 * end you can see, so this is the one operation that has to be reversible from
 * somewhere other than where it started.
 *
 * `boardFor` picks the arriving slot's zone per card, since the source zone
 * doesn't always exist over here (a binder has no sideboard, and a commander
 * pasted into a 60-card deck is just a creature). Returns copies moved.
 */
export async function moveDeckCardsToContainer(
  ids: string[],
  targetDeckId: string,
  boardFor: (slot: DeckCard) => DeckBoard,
): Promise<number> {
  if (ids.length === 0) return 0;
  let moved = 0;
  await write(DECK_TABLES, async (ctx) => {
    const target = await ctx.touchDeck(targetDeckId);
    if (!target) return;
    const { now } = ctx;
    const extra = batchFields('manual', ctx.batchId, target.name);
    for (const id of ids) {
      const card = await db.deckCards.get(id);
      if (!card) continue;
      const board = boardFor(card);
      // Same container and same zone: nothing to do. Same container, different
      // zone: that's an ordinary board move, and moveSlotRaw already knows how.
      if (card.deckId === targetDeckId) {
        moved += await moveSlotRaw(ctx, id, board, extra);
        continue;
      }
      // Merge into whatever is already sitting on that zone over here, exactly
      // as a board move merges, so pasting a second copy doesn't split the slot.
      if (!(await mergeIntoSlot(card, targetDeckId, board, now))) {
        await putSynced('deckCards', { ...card, id: newId(), deckId: targetDeckId, board, updatedAt: now });
      }
      await deleteSynced('deckCards', id);
      ctx.touchCopies([card]);
      // A leave from over there and an arrival over here. Same pair a board
      // move writes, so isMoveBatch reads it as a move and undo replays it back.
      const source = await ctx.touchDeck(card.deckId);
      ctx.emit(slotEvent('deck.remove', card, card.quantity, now, source, extra));
      ctx.emit(slotEvent('deck.add', { ...card, deckId: targetDeckId, board }, card.quantity, now, target, extra));
      moved += card.quantity;
    }
  });
  return moved;
}

/**
 * Move whole slots to another board in one go (the multi-select "Move to…").
 * Every line shares a batchId labelled with the deck, so the edit history shows
 * one entry the user can undo in a single tap. Slots already on that board are
 * skipped. Returns how many copies moved.
 */
export async function moveDeckCardsBulk(ids: string[], board: DeckBoard): Promise<number> {
  if (ids.length === 0) return 0;
  let moved = 0;
  await write(DECK_TABLES, async (ctx) => {
    const first = await db.deckCards.get(ids[0]!);
    const deck = first ? await ctx.getDeck(first.deckId) : undefined;
    const extra = batchFields('manual', ctx.batchId, deck?.name);
    // One at a time on purpose: two selected slots can target the same slot on
    // the far side, and each move has to see what the one before it merged.
    // The deck is stamped once at the end, not once per slot.
    for (const id of ids) moved += await moveSlotRaw(ctx, id, board, extra);
  });
  return moved;
}

/**
 * Change a slot's quantity/printing/wants; quantity ≤ 0 deletes the slot.
 * `scryfallId` and `wants` are only touched when the patch names them, and an
 * empty string / an all-undefined `wants` clears them back to "any" — so the
 * edit sheet can move a slot from a pinned foil to "any edition, any finish".
 */
/** How long a run of hand edits to one slot keeps folding into a single entry. */
const SLOT_COALESCE_MS = 30_000;

/**
 * Record a hand edit to one slot's quantity, folding it into the last one when
 * that was the same slot a moment ago.
 *
 * Stepping a playset up one card at a time is four presses of `+`, and four
 * lines in the edit history is not what happened: you added four Bolts. So a
 * run of edits in the same direction reads as one entry that grows.
 *
 * Only the same direction. Letting a removal eat the add before it would be
 * tidier still, and it would quietly delete the only thing undo had to work
 * with: delete a card you added a minute ago and both entries vanish, so Ctrl+Z
 * reaches past it and takes back something else instead. An extra line in the
 * history is a far smaller price than a deletion nothing can reverse.
 *
 * The folded event's timestamp moves to now, so "the last thing you did" stays
 * the last thing undo reaches for even when you touched something else in
 * between. Only ungrouped hand edits fold: an import, a scan or a trade already
 * has a batch of its own and is nobody's idea of clutter.
 */
async function emitSlotDelta(ctx: WriteCtx, card: DeckCard, kind: 'deck.add' | 'deck.remove', qty: number): Promise<void> {
  const { now } = ctx;

  const recent = await db.events.where('ts').above(now - SLOT_COALESCE_MS).toArray();
  // The newest ungrouped hand edit to this exact slot. Anything of the other
  // kind in between ends the run, so +,-,+ stays three honest entries rather
  // than folding the last press into one from before you changed direction.
  const last = recent
    .filter(
      (e) =>
        (e.kind === 'deck.add' || e.kind === 'deck.remove') &&
        e.deckId === card.deckId &&
        (e.board ?? 'main') === (card.board ?? 'main') &&
        e.oracleId === card.oracleId &&
        e.batchId == null &&
        e.tradeId == null &&
        e.source == null,
    )
    .sort((a, b) => b.ts - a.ts)[0];

  if (last?.kind === kind) {
    const grown: UserEvent = { ...last, qty: (last.qty ?? 0) + qty, ts: now, updatedAt: now };
    await putSynced('events', grown);
    return;
  }
  ctx.emit(slotEvent(kind, card, qty, now, await ctx.getDeck(card.deckId)));
}

async function patchDeckCard(
  id: string,
  patch: { quantity?: number; scryfallId?: string; anyBasic?: boolean; wants?: SlotWants; tags?: string[] },
): Promise<void> {
  await write(DECK_TABLES, async (ctx) => {
    const card = await db.deckCards.get(id);
    if (!card) return;
    const { now } = ctx;
    const quantity = patch.quantity ?? card.quantity;
    const delta = quantity - card.quantity;
    const anyBasic = patch.anyBasic ?? !!card.anyBasic;
    // A cleared want has to be written as undefined, not left off the object.
    const clearedWants: SlotWants = { condition: undefined, finish: undefined, lang: undefined };
    const wants = patch.wants ? { ...clearedWants, ...wantFields(patch.wants) } : {};
    // The slot after the edit, when it survives one. Held out here so the stamp
    // below can name both copies: repointing a slot from your English copy to
    // the Italian one is an edit to each of them.
    let next: DeckCard | undefined;

    if (quantity <= 0) {
      await deleteSynced('deckCards', id);
    } else {
      // The two are exclusive: a lands-box basic pins no edition (and asks
      // nothing of your copies), and pinning one turns the slot back into a copy
      // you're counting on owning.
      // Naming the copy a slot holds is saying it holds it: the edit sheet's save
      // and the assembler both come through here, so either one files an emptied
      // slot (DeckCard.unfiled) back in. A bare quantity or tag edit leaves the
      // flag where it was.
      const refiled = 'scryfallId' in patch || !!patch.wants;
      next = {
        ...card,
        quantity,
        ...(anyBasic
          ? { anyBasic: true, scryfallId: undefined, unfiled: undefined, ...clearedWants }
          : {
              anyBasic: undefined,
              ...('scryfallId' in patch ? { scryfallId: patch.scryfallId || undefined } : {}),
              ...(refiled ? { unfiled: undefined } : {}),
              ...wants,
            }),
        // Tags survive every other kind of edit; only a patch that names them
        // rewrites them (an empty list clears the slot back to untagged).
        ...('tags' in patch ? { tags: normalizeCardTags(patch.tags) } : {}),
        updatedAt: now,
      };
      await putSynced('deckCards', next);
    }

    const removedAll = quantity <= 0;
    if (delta !== 0 || removedAll) {
      await emitSlotDelta(
        ctx,
        card,
        removedAll || delta < 0 ? 'deck.remove' : 'deck.add',
        removedAll ? card.quantity : Math.abs(delta),
      );
    }
    ctx.touchCopies(next ? [card, next] : [card]);
    await ctx.touchDeck(card.deckId);
  });
}

/** Set a slot's quantity; deletes the slot at zero. */
export async function setDeckCardQuantity(id: string, quantity: number): Promise<void> {
  await patchDeckCard(id, { quantity });
}

/**
 * Pick (or clear) the color a choose-a-color commander is (see
 * DeckCard.chosenColor). Like a tag edit, it adds and removes no cardboard, so
 * there is no history event to emit — just the slot rewrite and the sync stage.
 */
export async function setDeckCardChosenColor(id: string, color: Color | undefined): Promise<void> {
  await write(DECK_TABLES, async (ctx) => {
    const card = await patchSynced('deckCards', id, (c) => {
      if (c.chosenColor === color) return false;
      c.chosenColor = color;
    }, ctx.now);
    if (card) await ctx.touchDeck(card.deckId);
  });
}

/** Update a slot's quantity, preferred printing and wants (deck edit sheet).
 *  An empty `scryfallId` means "any edition"; omitted wants mean "any". */
export async function updateDeckCard(
  id: string,
  patch: { quantity: number; scryfallId: string; anyBasic?: boolean; wants?: SlotWants; tags?: string[] },
): Promise<void> {
  await patchDeckCard(id, patch);
}

/**
 * Take the cardboard out of a container without touching its list, or put it
 * back — the multi-select "Unfile…" → this deck, and "File back here". The slot
 * keeps everything it names (printing, finish, condition, language); it just
 * stops claiming one of your copies, so the copy is free for another deck and
 * the green collection badge drops to the double checkmark (see
 * DeckCard.unfiled).
 *
 * Only slots that name one physical copy can go either way: a brew line and a
 * lands-box basic never held cardboard, so there is nothing to take out of them.
 * Nothing is added or removed from the container, so — like a tag edit — this
 * emits no history event; there is no card to undo back into place.
 *
 * Returns the copies affected.
 */
export async function setDeckCardsUnfiled(ids: string[], unfiled: boolean): Promise<number> {
  if (ids.length === 0) return 0;
  return write(DECK_TABLES, async (ctx) =>
    setSlotsUnfiled(ctx, (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c), unfiled),
  );
}

async function setSlotsUnfiled(ctx: WriteCtx, slots: DeckCard[], unfiled: boolean): Promise<number> {
  let copies = 0;
  const writes: DeckCard[] = [];
  for (const s of slots) {
    if (!namedCopy(s)) continue;
    if (!!s.unfiled === unfiled) continue;
    writes.push({ ...s, unfiled: unfiled ? true : undefined, updatedAt: ctx.now });
    copies += s.quantity;
  }
  await putSyncedMany('deckCards', writes);
  for (const w of writes) await ctx.touchDeck(w.deckId);
  // Taking a copy out of a container by hand, or putting it back, is the
  // plainest filing change there is.
  ctx.touchCopies(writes);
  return copies;
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
  return retagSlots(
    async () => (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c),
    (tags) => [...tags.filter((t) => !remove.has(t.toLocaleLowerCase())), ...add],
  );
}

/**
 * Rewrite the tags of the slots `load` returns, in one transaction. Slots whose
 * tags come out the same aren't rewritten, so re-applying a tag doesn't churn
 * the sync outbox. Every container a rewritten slot sits in is touched.
 */
async function retagSlots(load: () => Promise<DeckCard[]>, retag: (tags: string[]) => string[]): Promise<number> {
  return write(DECK_TABLES, async (ctx) => {
    const writes: DeckCard[] = [];
    for (const s of await load()) {
      const next = normalizeCardTags(retag(s.tags ?? []));
      if (sameCardTags(s.tags, next)) continue;
      writes.push({ ...s, tags: next, updatedAt: ctx.now });
    }
    await putSyncedMany('deckCards', writes);
    for (const w of writes) await ctx.touchDeck(w.deckId);
    return writes.length;
  });
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
  return retagSlots(
    () => db.deckCards.where('deckId').equals(deckId).toArray(),
    (tags) => tags.map((t) => (t.toLocaleLowerCase() === key ? target : t)),
  );
}

/** Drop a tag from every slot in one container — the tag then stops existing. */
export async function deleteDeckCardTag(deckId: string, tag: string): Promise<number> {
  const key = normalizeCardTags([tag])?.[0]?.toLocaleLowerCase();
  if (!key) return 0;
  return retagSlots(
    () => db.deckCards.where('deckId').equals(deckId).toArray(),
    (tags) => tags.filter((t) => t.toLocaleLowerCase() !== key),
  );
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
  await write(DECK_TABLES, async (ctx) => {
    const slots = (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c);
    await deleteSyncedMany('deckCards', slots.map((s) => s.id));
    ctx.touchCopies(slots);
    // Selection lives on one screen, so these are all one container's slots,
    // but touch each named deck anyway rather than assume it.
    for (const s of slots) {
      const deck = await ctx.touchDeck(s.deckId);
      ctx.emit(slotEvent('deck.remove', s, s.quantity, ctx.now, deck, batchFields('manual', ctx.batchId, deck?.name)));
      removed += s.quantity;
    }
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
  meta: { source?: EventSource } & BatchMeta = {},
): Promise<number> {
  if (cards.length === 0) return 0;
  let removed = 0;
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    const byOracle = groupByOracle(await db.deckCards.where('deckId').equals(containerId).toArray());
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
    const deck = await ctx.touchDeck(containerId);
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel ?? deck?.name);
    for (const [slot, qty] of taken) {
      await adjustRow('deckCards', slot, -qty, now);
      ctx.emit(slotEvent('deck.remove', slot, qty, now, deck, extra));
    }
    ctx.touchCopies(taken.keys());
  }, meta);
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
  const slots = await db.deckCards.where('deckId').equals(containerId).toArray();
  // An emptied-out slot (DeckCard.unfiled) is a line on the list, not a card in
  // the box, so there's nothing here to put up for grabs.
  return setSlotsForTrade(slots.filter((s) => !s.unfiled), forTrade);
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
    const byOracle = await ownedByOracle(requests);
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
    await putSyncedMany('collection', [...touched]);
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
  const centsOf = (scryfallId: string, finish: Finish) => acquisitionCents(prices.get(scryfallId), finish);

  // DECK_TABLES in full, not a hand-picked subset: reconcileFilingAfterTrade
  // opens a nested DECK_TABLES transaction, and Dexie aborts the whole trade if
  // that names a table this one doesn't (v0.158.0 added deckBehaviors and every
  // trade giving away a filed card silently rolled back).
  return write([...DECK_TABLES, db.wishlist, db.trades], async (ctx) => {
    if (await db.trades.get(sessionId)) return { applied: false }; // already applied
    const tradeExtra = { source: 'trade' as const, tradeId: sessionId };

    const entries = await db.collection.toArray();
    // Two indexes, because a trade line says what a card IS and nothing about
    // whether the cardboard is signed or altered:
    //  - byKey: full row identity. What a received card merges into, so a plain
    //    copy coming in lands on your plain row, never on your altered one.
    //  - byCopy: rows per copy identity, ordinary copies first. What a given card
    //    comes out of — the plain one goes across the table, and an annotated row
    //    is only touched when it's the only copy of that card you have.
    const byKey = new Map(entries.map((e) => [entryKey(e), e]));
    const byCopy = new Map<string, CollectionEntry[]>();
    for (const e of entries) push(byCopy, collectionKey(e), e);
    byCopy.forEach((list) => list.sort((a, b) => (a.special?.length ? 1 : 0) - (b.special?.length ? 1 : 0)));
    const { now } = ctx;

    // Remove given cards (decrement matching entries; reduce trade qty with them).
    for (const line of given) {
      const copies = byCopy.get(collectionKey(line)) ?? [];
      const ex = copies[0];
      const ownedQty = ex?.quantity ?? 0;
      const finalOwned = ex ? Math.max(0, ex.quantity - line.quantity) : 0;
      if (ex) {
        const next = await adjustRow('collection', ex, finalOwned - ex.quantity, now);
        if (next) {
          Object.assign(ex, next);
        } else {
          byKey.delete(entryKey(ex));
          copies.shift();
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
      const copy = { ...line, special: undefined };
      const priceEurCents = centsOf(line.scryfallId, line.finish);
      if (missing > 0) {
        ctx.emit(copyEvent('collection.add', copy, missing, now, { priceEurCents, ...tradeExtra, reconcile: true }));
      }
      // The event records the full traded quantity even when the card was
      // never registered (or under-registered) in the collection — the trade
      // happened either way, and the card history should say so.
      const ts = missing > 0 ? now + 1 : now;
      ctx.emit(copyEvent('collection.remove', copy, line.quantity, ts, { priceEurCents, reason: 'traded', ...tradeExtra }));
    }

    // Add received cards (merge on the same compound key).
    for (const line of received) {
      const copy = { ...line, lang: line.lang || 'en', special: undefined };
      const ex = byKey.get(entryKey(line));
      const next = await adjustRow('collection', ex, line.quantity, now, (q) => newEntry(copy, q, 0, now));
      if (ex) Object.assign(ex, next);
      else byKey.set(entryKey(next!), next!);
      ctx.emit(
        copyEvent('collection.add', copy, line.quantity, now, {
          priceEurCents: centsOf(line.scryfallId, line.finish),
          ...tradeExtra,
        }),
      );
    }

    // Prune wishlist by received cards (any printing of the oracle card).
    for (const line of received) {
      let toRemove = line.quantity;
      const wl = await db.wishlist.where('oracleId').equals(line.oracleId).toArray();
      for (const w of wl) {
        if (toRemove <= 0) break;
        const dec = Math.min(w.quantity, toRemove);
        toRemove -= dec;
        await adjustRow('wishlist', w, -dec, now);
        ctx.emit({ ts: now, kind: 'wish.fulfilled', oracleId: line.oracleId, scryfallId: line.scryfallId, qty: dec, ...tradeExtra });
      }
    }

    const trade: Trade = { id: sessionId, completedAt: now, partner, given, received };
    await putSynced('trades', trade);
    return { applied: true };
  });
}

// ---------------------------------------------------------------------------
// Undo an edit-history entry (edit-history feature). Reverses the recorded
// mutation and deletes the event(s) WITHOUT emitting new events — the log
// returns to its prior state, exactly like a sync-applied change.
//
// Which entries qualify used to be "the single newest one, and nothing else",
// which kept undo safe by keeping it tiny. The real hazard is a newer change to
// the same *row* (see db/undoScope.ts), so that is what's checked now: undoing
// last week's change to a deck you haven't touched since is safe, and being on
// a different page when the newest change happened no longer disqualifies you.
// ---------------------------------------------------------------------------

export type UndoRef =
  | { type: 'single'; id: string }
  | { type: 'batch'; batchId: string }
  | { type: 'trade'; tradeId: string };

/**
 * What an undo did, or why it didn't. `events` are the ones that were reversed
 * and deleted, so the caller can name what moved (and, later, redo it).
 *  - `gone`: the entry isn't in the log any more (undone elsewhere, or synced away).
 *  - `conflict`: something newer touched the same rows; undo that first.
 */
export type UndoResult =
  | { undone: true; events: UserEvent[]; trade?: Trade }
  | { undone: false; reason: 'gone' | 'conflict' };

const UNDO_TABLES = [...DECK_TABLES, db.wishlist, db.trades];

/** The copy an event was about, as a row lookup. Events written before special
 *  conditions existed name no specials, which is exactly the ordinary copy. */
function eventCopy(e: UserEvent & { scryfallId: string }) {
  return {
    scryfallId: e.scryfallId,
    condition: e.condition ?? ('NM' as Condition),
    finish: e.finish ?? ('nonfoil' as Finish),
    lang: e.lang ?? 'en',
    special: e.special,
  };
}

/** Change the collection by e.qty copies of the event's copy: positive adds
 *  them back (reverse of a removal), negative takes them out (reverse of an add). */
async function copiesAdjustRaw(e: UserEvent, sign: 1 | -1, now: number): Promise<void> {
  if (!e.scryfallId || !e.qty) return;
  const copy = { ...eventCopy({ ...e, scryfallId: e.scryfallId }), oracleId: e.oracleId };
  const existing = await findCollectionRow(copy);
  await adjustRow('collection', existing, sign * e.qty, now, (q) => newEntry(copy, q, 0, now));
}

/** Change an entry's quantityForTrade by delta (reverse of a tradelist mark). */
async function tradeMarkAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!e.scryfallId || !delta) return;
  const existing = await findCollectionRow(eventCopy({ ...e, scryfallId: e.scryfallId }));
  if (!existing) return;
  const next: CollectionEntry = {
    ...existing,
    quantityForTrade: clamp(existing.quantityForTrade + delta, 0, existing.quantity),
    updatedAt: now,
  };
  await putSynced('collection', next);
}

/** Change a wishlist line by delta (negative removes, positive re-adds). */
async function wishlistAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!delta) return;
  const list = await db.wishlist.where('oracleId').equals(e.oracleId).toArray();
  const key = wishKey({ scryfallId: e.scryfallId ?? null, condition: e.condition, finish: e.finish, lang: e.lang });
  const match =
    list.find((w) => wishKey(w) === key) ?? list.find((w) => w.scryfallId === (e.scryfallId ?? null)) ?? list[0];
  await adjustRow('wishlist', match, delta, now, (q) => newWish({ ...e, scryfallId: e.scryfallId ?? null }, q, now));
}

/** Change a deck slot by delta (negative removes, positive re-adds). No-op if the deck is gone. */
async function deckAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!e.deckId || !delta) return;
  const deck = await db.decks.get(e.deckId);
  if (!deck) return;
  const board = e.board ?? 'main';
  const cards = await db.deckCards.where('[deckId+board]').equals([e.deckId, board]).toArray();
  const dc = cards.find((c) => c.oracleId === e.oracleId);
  await adjustRow('deckCards', dc, delta, now, (q) => ({
    id: newId(),
    deckId: e.deckId!,
    oracleId: e.oracleId,
    ...(e.scryfallId ? { scryfallId: e.scryfallId } : {}),
    quantity: q,
    board,
    updatedAt: now,
  }));
  const touched: Deck = { ...deck, updatedAt: now };
  await putSynced('decks', touched);
}

/**
 * Apply one event's effect forward (sign 1, redo) or backward (sign -1, undo).
 * Undo and redo are the same table with the sign flipped, so they can't drift.
 */
async function applyEventSigned(e: UserEvent, sign: 1 | -1, now: number): Promise<void> {
  const qty = e.qty ?? 1;
  switch (e.kind) {
    case 'collection.add':
      await copiesAdjustRaw(e, sign, now);
      break;
    case 'collection.remove':
      await copiesAdjustRaw(e, -sign as 1 | -1, now);
      break;
    case 'wish.add':
      await wishlistAdjustRaw(e, sign * qty, now);
      break;
    case 'wish.remove':
      await wishlistAdjustRaw(e, -sign * qty, now);
      break;
    case 'wish.fulfilled':
      // Only a trade's wish.fulfilled pruned the wishlist. A manual add's never
      // touched it, so there's nothing to reverse or re-do.
      if (e.source === 'trade' || e.tradeId != null) await wishlistAdjustRaw(e, -sign * qty, now);
      break;
    case 'deck.add':
      await deckAdjustRaw(e, sign * qty, now);
      break;
    case 'deck.remove':
      await deckAdjustRaw(e, -sign * qty, now);
      break;
    case 'tradelist.mark':
      await tradeMarkAdjustRaw(e, sign * qty, now);
      break;
  }
}

/**
 * Undo the given history entry: reverse every event it groups and delete them.
 * No-op with a reason if the entry is gone or a newer change has since written
 * one of the same rows, so the caller can tell the user which it was.
 */
export async function undoEntry(ref: UndoRef): Promise<UndoResult> {
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
        .where('ts')
        .equals(one.ts)
        .filter(
          (e) =>
            e.kind === 'wish.fulfilled' &&
            e.oracleId === one.oracleId &&
            (e.scryfallId ?? null) === (one.scryfallId ?? null) &&
            e.batchId == null &&
            e.tradeId == null,
        )
        .toArray();
      events = [one, ...paired];
    }
    if (events.length === 0) return { undone: false, reason: 'gone' as const };

    // Guard: nothing newer may have written the rows this undo is about to
    // write (db/undoScope.ts explains why that, and not "is it the newest?").
    // Scanned from the entry's own earliest ts rather than its latest, so a
    // sibling entry sharing that millisecond is weighed too — being refused a
    // simultaneous undo is cheap, and guessing wrong about it isn't.
    const own = new Set(events.map((e) => e.id));
    const keys = new Set(events.flatMap(rowKeysOf));
    if (keys.size > 0) {
      const since = Math.min(...events.map((e) => e.ts));
      const later = await db.events.where('ts').aboveOrEqual(since).toArray();
      const blocked = later.some((e) => !own.has(e.id) && rowKeysOf(e).some((k) => keys.has(k)));
      if (blocked) return { undone: false, reason: 'conflict' as const };
    }

    const now = Date.now();
    // Reverse removals (which add copies back) before adds (which remove copies)
    // so a trade's backfill add + its removal on the same printing net to what
    // was truly owned, instead of a clamped-at-zero op leaving phantom copies.
    const ordered = [...events].sort(
      (a, b) => (a.kind === 'collection.remove' ? 0 : 1) - (b.kind === 'collection.remove' ? 0 : 1),
    );
    for (const e of ordered) await applyEventSigned(e, -1, now);
    await deleteSyncedMany('events', events.map((e) => e.id));
    // Handed back so a redo can put the session row back where it was; the
    // events alone don't describe the trade itself.
    let trade: Trade | undefined;
    if (ref.type === 'trade') {
      trade = await db.trades.get(ref.tradeId);
      await deleteSynced('trades', ref.tradeId);
    }
    return { undone: true, events, ...(trade ? { trade } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Redo: put back what undo took away.
//
// Undo deletes the events it reverses, so there is nothing left to replay from
// — which is why redo takes the events undo handed back rather than looking
// them up. It cannot resurrect them either: the sync log stamps an event row by
// its `ts` and a delete by the moment it happened, so re-putting an event under
// its original id and timestamp would lose to its own tombstone and vanish from
// the account's other devices. So a redo applies the change forward and emits
// *new* events for it, which is also the honest reading: you did this just now.
//
// The net effect on the edit history is still the one worth having. Undo erases
// its entry, redo writes one fresh entry, and no amount of pressing either key
// leaves a pile of "added, removed, added" behind.
// ---------------------------------------------------------------------------

export interface RedoInput {
  /** The events undoEntry reversed, exactly as it handed them back. */
  events: UserEvent[];
  /** The trade row undo removed, when the entry was a whole trade. */
  trade?: Trade;
  /** When the undo happened. Anything newer touching the same rows blocks this. */
  since: number;
  /** Events written by earlier redos this session — ours, so not "newer changes".
   *  Without this, replaying two undos of the same card in order would see the
   *  first redo as an intruder and refuse the second. */
  ownEventIds?: ReadonlySet<string>;
}

export type RedoResult =
  | { redone: true; events: UserEvent[] }
  | { redone: false; reason: 'conflict' };

/**
 * Re-apply an undone entry. Refuses if something has written the same rows
 * since the undo, because "redo" would then mean stacking this change on top of
 * a decision the user made afterwards, not restoring what they had.
 */
export async function redoEntry(input: RedoInput): Promise<RedoResult> {
  const { events, trade, since, ownEventIds } = input;
  return db.transaction('rw', UNDO_TABLES, async () => {
    const keys = new Set(events.flatMap(rowKeysOf));
    if (keys.size > 0) {
      const later = await db.events.where('ts').aboveOrEqual(since).toArray();
      const blocked = later.some((e) => !ownEventIds?.has(e.id) && rowKeysOf(e).some((k) => keys.has(k)));
      if (blocked) return { redone: false, reason: 'conflict' as const };
    }

    const now = Date.now();
    // Mirror of undo's ordering: there it reverses removals first, so here the
    // adds go first, and a trade's backfill add plus its removal on the same
    // printing still net to what was truly owned.
    const ordered = [...events].sort(
      (a, b) => (a.kind === 'collection.add' ? 0 : 1) - (b.kind === 'collection.add' ? 0 : 1),
    );
    for (const e of ordered) await applyEventSigned(e, 1, now);

    if (trade) {
      await putSynced('trades', trade);
    }

    // New ids and a new timestamp, keeping everything that says what the change
    // *was* — including batchId and tradeId, so a redone bulk operation groups
    // back into the single entry it was and can be undone in one press again.
    const fresh: UserEvent[] = events.map(({ id: _id, ts: _ts, updatedAt: _u, ...rest }) => ({
      ...rest,
      id: newId(),
      ts: now,
      updatedAt: now,
    }));
    await putSyncedMany('events', fresh);
    return { redone: true, events: fresh };
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
    await putSynced('sealedItems', row);
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
      await deleteSynced('sealedItems', id);
      return;
    }
    const row: SealedItem = { ...existing, quantity: clamp(next, 1, 9999), updatedAt: Date.now() };
    await putSynced('sealedItems', row);
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
      db.deckBehaviors.bulkAdd(data.deckBehaviors),
      db.trades.bulkAdd(data.trades),
      db.priceHistories.bulkAdd(data.priceHistories),
      db.sealedPriceHistories.bulkAdd(data.sealedPriceHistories),
      db.events.bulkAdd(data.events),
    ]);
  });
}

/** Wipe every user-data table (About screen: "delete all my data"). Card DB is kept. */
export async function deleteAllUserData(): Promise<void> {
  await db.transaction('rw', [...USER_DATA_TABLES, db.outbox], () => clearUserDataTables());
}
