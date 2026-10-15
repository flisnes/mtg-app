import { normalizeSpecialConditions } from '@mtg/shared';
import type { CollectionEntry, Condition, DeckCard, EventSource, Finish, RemovalReason, SpecialCondition, UserEvent } from '@mtg/shared';
import { db } from './schema.js';
import { getPricesByIds } from '../cardDb/prices.js';
import { acquisitionCents } from '../price/acquisition.js';
import { batchFields, copyEvent, emitWishFulfilled, groupByOracle, priceCents, wishFulfilledEvent } from './events.js';
import type { CopyFields } from './events.js';
import { clamp, collectionKey, entryKey, exactSlotKey, findCollectionRow, newId, slotClaimKey } from './keys.js';
import type { CopyRef, SlotWants } from './keys.js';
import { adjustRow, COLLECTION_TABLES, deleteSynced, deleteSyncedMany, putSynced, putSyncedMany, write } from './write.js';
import type { BatchMeta } from './write.js';
import { sumQty } from '../util/groupBy.js';

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
export function newEntry(c: CopyFields, qty: number, forTrade: number, now: number): CollectionEntry {
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
export async function ownedByOracle(requests: { oracleId: string }[]): Promise<Map<string, CollectionEntry[]>> {
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
          const claimed = sumQty(
            (await db.deckCards.where('oracleId').equals(e.oracleId).toArray()).filter((s) => slotClaimKey(s) === from),
          );
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
export async function copiesAdjustRaw(e: UserEvent, sign: 1 | -1, now: number): Promise<void> {
  if (!e.scryfallId || !e.qty) return;
  const copy = { ...eventCopy({ ...e, scryfallId: e.scryfallId }), oracleId: e.oracleId };
  const existing = await findCollectionRow(copy);
  await adjustRow('collection', existing, sign * e.qty, now, (q) => newEntry(copy, q, 0, now));
}

/** Change an entry's quantityForTrade by delta (reverse of a tradelist mark). */
export async function tradeMarkAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
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
