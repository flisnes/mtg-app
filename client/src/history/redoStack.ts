import type { Trade, UserEvent } from '@mtg/shared';
import { scopeMatches, scopeTokensOf, type ScopeToken, type UndoScope } from '../db/undoScope.js';

// What undo took away, kept until it's put back or goes stale.
//
// The undo stack needs no bookkeeping because the event log is the stack. Redo
// gets no such gift: undo *deletes* the events it reverses, so the only copy of
// what to put back is the one undoEntry handed to the caller. That copy lives
// here, in memory, for the life of the tab. A reload loses it, same as every
// editor, and that's the honest behaviour — nothing was written down.
//
// Scoped like undo: a page only redoes what it undid. And no clearing on the
// next unrelated action, because "does anything newer touch these rows?" is a
// better question than "has anything happened at all?" — the same question the
// undo guard asks (db/undoScope.ts). Redo one deck after editing another and
// nothing is lost; redo a card someone has since changed by hand and it's
// refused, which is exactly when redo would have been a surprise.

/** Cap: a session's worth of undo is plenty, and this holds whole events. */
const LIMIT = 50;

export interface RedoItem {
  events: UserEvent[];
  /** Present when the undone entry was a whole trade session. */
  trade?: Trade;
  tokens: Set<ScopeToken>;
  /** When the undo happened — the line "newer" is measured from. */
  undoneAt: number;
  /** What to call it in a toast, e.g. "Added to Goblins". */
  verb: string;
}

const stack: RedoItem[] = [];

// Every event id redo has written this session. Passed to redoEntry so its
// conflict check can tell our own replays from someone changing the card by
// hand: undo A then B, redo B then A, and B's replay must not look to A like an
// intruder on the same row.
const ownEventIds = new Set<string>();

export function pushRedo(item: RedoItem): void {
  stack.push(item);
  if (stack.length > LIMIT) stack.shift();
}

/** Newest redoable item for this page, and the newest for anywhere else. */
export function peekRedo(scope: UndoScope): { mine: RedoItem | null; elsewhere: RedoItem | null } {
  let mine: RedoItem | null = null;
  let elsewhere: RedoItem | null = null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i]!;
    if (scopeMatches(item.tokens, scope)) {
      mine = item;
      break;
    }
    elsewhere ??= item;
  }
  return { mine, elsewhere: mine ? null : elsewhere };
}

/** Drop an item, whether it was replayed or refused — a refused redo is stale
 *  for good, since the change that blocked it isn't going anywhere. */
export function dropRedo(item: RedoItem): void {
  const i = stack.indexOf(item);
  if (i >= 0) stack.splice(i, 1);
}

export function noteRedoEvents(events: readonly UserEvent[]): void {
  for (const e of events) ownEventIds.add(e.id);
}

export function redoEventIds(): ReadonlySet<string> {
  return ownEventIds;
}

/** Build the item for something just undone. */
export function redoItemFor(
  events: UserEvent[],
  trade: Trade | undefined,
  verb: string,
): RedoItem {
  return { events, ...(trade ? { trade } : {}), tokens: scopeTokensOf(events), undoneAt: Date.now(), verb };
}
