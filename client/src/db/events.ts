import type { CollectionEntry, ContainerKind, Deck, DeckBoard, EventSource, Finish, RemovalReason, UserEvent, WishlistEntry } from '@mtg/shared';
import { getPricesByIds } from '../cardDb/prices.js';
import { acquisitionCents } from '../price/acquisition.js';
import { db } from './schema.js';
import { putSynced } from './write.js';
import type { WriteCtx } from './write.js';
import { groupBy } from '../util/groupBy.js';

// ---------------------------------------------------------------------------
// Event emission. Events are immutable apart from the user-editable fields
// (priceEurCents, reason) — updatedAt is bumped only by editUserEvent.
// ---------------------------------------------------------------------------

export type NewEvent = Omit<UserEvent, 'id' | 'updatedAt'>;

/** What an event says about how and why, beyond the card and the count. */
export type EventExtra = Partial<
  Pick<UserEvent, 'source' | 'batchId' | 'batchLabel' | 'tradeId' | 'reason' | 'priceEurCents' | 'reconcile'>
>;

/** The one copy a collection-shaped event is about. */
export type CopyFields = Pick<CollectionEntry, 'oracleId' | 'scryfallId' | 'condition' | 'finish' | 'lang' | 'special'>;

/** A collection.add / collection.remove / tradelist.mark event for one copy. */
export function copyEvent(
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
export function wishEvent(
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
export function slotEvent(
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
export function batchFields(source: EventSource, batchId: string, label?: string): EventExtra {
  return { source, batchId, ...(label ? { batchLabel: label } : {}) };
}

export function groupByOracle<T extends { oracleId: string }>(rows: T[]): Map<string, T[]> {
  return groupBy(rows, (r) => r.oracleId);
}

/**
 * Given a preloaded wishlist grouped by oracleId, the wish.fulfilled event for
 * one add (or null). If an added printing matches a wishlist line (null
 * scryfallId = any printing), the wish is recorded as fulfilled. The wishlist
 * itself is not changed; only trades prune it.
 */
export function wishFulfilledEvent(
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
export async function priceCents(scryfallId: string, finish: Finish): Promise<number | null> {
  const prices = await getPricesByIds([scryfallId]);
  return acquisitionCents(prices.get(scryfallId), finish);
}

/** wishFulfilledEvent for a single add, reading just that card's wishes. */
export async function emitWishFulfilled(
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

/**
 * The event fields that name where a slot change happened. `deckKind` is only
 * written for storage, so a deck event looks exactly as it always did.
 */
function containerRef(deck: Deck | undefined): { deckName?: string; deckKind?: ContainerKind } {
  if (!deck) return {};
  const kind = deck.kind ?? 'deck';
  return { deckName: deck.name, ...(kind === 'deck' ? {} : { deckKind: kind }) };
}
