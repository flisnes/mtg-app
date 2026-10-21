import { isPurchaseBatch, type Trade, type UserEvent } from '@mtg/shared';
import { db } from './schema.js';
import { rowKeysOf } from './undoScope.js';
import { copiesAdjustRaw, tradeMarkAdjustRaw } from './collectionWrites.js';
import { newId } from './keys.js';
import { deckAdjustRaw } from './slotWrites.js';
import { wishlistAdjustRaw } from './wishlistWrites.js';
import { deleteSynced, deleteSyncedMany, putSynced, UNDO_TABLES, write, type WriteCtx } from './write.js';

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

/**
 * Apply one event's effect forward (sign 1, redo) or backward (sign -1, undo).
 * Undo and redo are the same table with the sign flipped, so they can't drift.
 * Runs inside a write context, so a batch touching one deck sixty times stamps
 * and stages that deck once, the same as the forward writers.
 */
async function applyEventSigned(ctx: WriteCtx, e: UserEvent, sign: 1 | -1): Promise<void> {
  const { now } = ctx;
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
      await deckAdjustRaw(ctx, e, sign * qty);
      break;
    case 'deck.remove':
      await deckAdjustRaw(ctx, e, -sign * qty);
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
  // Nothing is emitted through the ctx here: undo deletes events, it doesn't
  // write any. The ctx is for the deck stamps.
  return write(UNDO_TABLES, async (ctx) => {
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
    // Never offered (undoScope.ts), and refused here too: these adds are copies
    // you owned before the import, and reversing them would delete them.
    if (events.some((e) => isPurchaseBatch(e.batchId))) return { undone: false, reason: 'conflict' as const };

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

    // Reverse removals (which add copies back) before adds (which remove copies)
    // so a trade's backfill add + its removal on the same printing net to what
    // was truly owned, instead of a clamped-at-zero op leaving phantom copies.
    const ordered = [...events].sort(
      (a, b) => (a.kind === 'collection.remove' ? 0 : 1) - (b.kind === 'collection.remove' ? 0 : 1),
    );
    for (const e of ordered) await applyEventSigned(ctx, e, -1);
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
  return write(UNDO_TABLES, async (ctx) => {
    const keys = new Set(events.flatMap(rowKeysOf));
    if (keys.size > 0) {
      const later = await db.events.where('ts').aboveOrEqual(since).toArray();
      const blocked = later.some((e) => !ownEventIds?.has(e.id) && rowKeysOf(e).some((k) => keys.has(k)));
      if (blocked) return { redone: false, reason: 'conflict' as const };
    }

    const { now } = ctx;
    // Mirror of undo's ordering: there it reverses removals first, so here the
    // adds go first, and a trade's backfill add plus its removal on the same
    // printing still net to what was truly owned.
    const ordered = [...events].sort(
      (a, b) => (a.kind === 'collection.add' ? 0 : 1) - (b.kind === 'collection.add' ? 0 : 1),
    );
    for (const e of ordered) await applyEventSigned(ctx, e, 1);

    if (trade) {
      await putSynced('trades', trade);
    }

    // New ids and a new timestamp, keeping everything that says what the change
    // *was* — including batchId and tradeId, so a redone bulk operation groups
    // back into the single entry it was and can be undone in one press again.
    // Emitted through the ctx, which flushes them in one bulk write.
    const fresh: UserEvent[] = events.map(({ id: _id, ts: _ts, updatedAt: _u, ...rest }) => ({
      ...rest,
      id: newId(),
      ts: now,
      updatedAt: now,
    }));
    for (const e of fresh) ctx.emit(e, e.id);
    return { redone: true, events: fresh };
  });
}
