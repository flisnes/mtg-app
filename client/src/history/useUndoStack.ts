import { useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { undoEntry, type UndoResult } from '../db/dataAccess.js';
import { scopeMatches, scopeTokensOf, undoableIds, type UndoScope } from '../db/undoScope.js';
import { entryEvents, groupEntries, undoRefOf, type HistoryEntry } from './useHistoryEntries.js';

// The undo stack a page walks backwards, scoped to that page.
//
// Two rules, both there to keep undo from doing something you can't see:
//
//  1. Scope. Editing deck A, moving to deck B, then pressing undo one time too
//     many must not start unpicking deck A off-screen. A page only ever offers
//     entries that touched it, and says so when it runs out instead of reaching
//     for the next thing along. A cut-and-paste between two decks touched both,
//     so it's offered at either end — the one case where reaching across is the
//     whole point.
//
//  2. This session only. The event log goes back to the day the collection was
//     imported; undo should not. The stack starts empty when the tab opens, so
//     no amount of leaning on the key rewinds last week's trade. The edit
//     history page is where older changes are reversed, deliberately and with
//     the entry in front of you.
//
// There is no bookkeeping to keep in step, because the event log *is* the
// stack: undoEntry deletes the events it reverses, so an undone entry leaves on
// its own and the live query re-reads what's left.

/** When this tab opened. The floor of every scoped stack. */
const SESSION_START = Date.now();

export interface UndoStack {
  /** Newest undoable entry on this page, or null when there's nothing left. */
  next: HistoryEntry | null;
  /**
   * Newest undoable entry from somewhere else, when this page has none. Lets
   * the caller say where the last change actually was rather than dead-ending.
   */
  elsewhere: HistoryEntry | null;
  /** Undo `next`. Null when there was nothing to undo. */
  undo: () => Promise<UndoResult | null>;
}

export function useUndoStack(scope: UndoScope): UndoStack {
  const events = useLiveQuery(() => db.events.where('ts').aboveOrEqual(SESSION_START).toArray(), []);

  const { next, elsewhere } = useMemo(() => {
    if (!events) return { next: null, elsewhere: null };
    // groupEntries wants newest-first, and an index range scan hands back
    // ascending; undoableIds needs that order too (it walks newest to oldest).
    const entries = groupEntries([...events].sort((a, b) => b.ts - a.ts));
    // Computed over every session entry, not just this page's: a blocking
    // change is a blocking change wherever it was made.
    const open = undoableIds(entries.map((e) => ({ id: e.id, events: entryEvents(e) })));
    let mine: HistoryEntry | null = null;
    let other: HistoryEntry | null = null;
    for (const e of entries) {
      if (!open.has(e.id)) continue;
      if (scopeMatches(scopeTokensOf(entryEvents(e)), scope)) {
        mine = e;
        break;
      }
      other ??= e;
    }
    return { next: mine, elsewhere: mine ? null : other };
  }, [events, scope.kind, scope.kind === 'container' ? scope.id : '']);

  const undo = useCallback(async () => (next ? undoEntry(undoRefOf(next)) : null), [next]);

  return { next, elsewhere, undo };
}
