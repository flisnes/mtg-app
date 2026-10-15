import type { Condition, EventSource, Finish, UserEvent, WishlistEntry } from '@mtg/shared';
import { db } from './schema.js';
import { batchFields, wishEvent } from './events.js';
import { newId, wishKey } from './keys.js';
import { adjustRow, deleteSynced, putSynced, putSyncedMany, WISHLIST_TABLES, write } from './write.js';
import type { BatchMeta } from './write.js';

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

/** Change a wishlist line by delta (negative removes, positive re-adds). */
export async function wishlistAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!delta) return;
  const list = await db.wishlist.where('oracleId').equals(e.oracleId).toArray();
  const key = wishKey({ scryfallId: e.scryfallId ?? null, condition: e.condition, finish: e.finish, lang: e.lang });
  const match =
    list.find((w) => wishKey(w) === key) ?? list.find((w) => w.scryfallId === (e.scryfallId ?? null)) ?? list[0];
  await adjustRow('wishlist', match, delta, now, (q) => newWish({ ...e, scryfallId: e.scryfallId ?? null }, q, now));
}
