import type { UserEvent } from '@mtg/shared';

// Which rows an undo would write, and which page the change belongs to.
//
// Undo used to be offered on the newest entry in the log and nothing else, on
// the grounds that reversing anything older risked a domino effect. But the
// domino is same-*row*, not same-*time*: undoing "added 4 Bolt to Burn" after
// "removed 2 Bolt from Burn" makes deckAdjustRaw subtract 4 from a slot holding
// 2, which clamps at zero and silently eats the slot. Two changes to *different*
// decks can never do that to each other, because a deck slot is found by
// (deckId, board, oracleId) and those sets are disjoint.
//
// So the guard asks the precise question instead of the convenient one: does
// anything newer touch the same rows? Everything else may be undone, whenever
// it happened and whatever page you're on.
//
// Pure: no DB access, no React. Both the authoritative check inside undoEntry
// and the "can this be undone?" the UI paints read from here, so they agree.

/**
 * The rows `reverseEvent` would write for this event, as opaque keys. Two
 * events collide when they share one.
 *
 * These MUST mirror how the raw helpers in dataAccess find their row. If one of
 * those changes how it matches, the matching key here changes with it:
 *   - collection + tradelist: the (scryfallId, condition, finish, lang)
 *     compound key that removeCopiesRaw / addCopiesRaw / tradeMarkAdjustRaw
 *     look the entry up by, defaults included.
 *   - deck slots: (deckId, board, oracleId), what deckAdjustRaw matches on.
 *     The deck row's own updatedAt bump is not a key — a touched timestamp
 *     can't corrupt anything.
 *   - wishlist: wishlistAdjustRaw falls back to *any* line with the same
 *     oracleId when the exact key misses, so the whole oracleId is one key.
 *     Conservative on purpose: it refuses a pair of undos that might have been
 *     fine rather than letting one write the other's line.
 */
export function rowKeysOf(e: UserEvent): string[] {
  switch (e.kind) {
    case 'collection.add':
    case 'collection.remove':
    case 'tradelist.mark': {
      if (!e.scryfallId) return [];
      const key = [e.scryfallId, e.condition ?? 'NM', e.finish ?? 'nonfoil', e.lang ?? 'en'].join('|');
      return [`collection:${key}`];
    }
    case 'deck.add':
    case 'deck.remove':
      if (!e.deckId) return [];
      return [`deck:${e.deckId}|${e.board ?? 'main'}|${e.oracleId}`];
    case 'wish.add':
    case 'wish.remove':
    case 'wish.fulfilled':
      return [`wish:${e.oracleId}`];
  }
}

/** Where a change happened, as tokens an `UndoScope` is matched against. */
export type ScopeToken = string;

/**
 * The pages an entry belongs to. Usually one, but a cut-and-paste between two
 * decks is a single batch that removes slots from one and adds them to the
 * other, so it belongs to both and is undoable from either end. Container
 * actions that also write collection or wishlist rows (marking a deck for
 * trade, sending its missing cards to the wishlist) carry those tokens too, so
 * they surface on those pages as well as in the deck.
 */
export function scopeTokensOf(events: readonly UserEvent[]): Set<ScopeToken> {
  const out = new Set<ScopeToken>();
  for (const e of events) {
    switch (e.kind) {
      case 'deck.add':
      case 'deck.remove':
        if (e.deckId) out.add(`container:${e.deckId}`);
        break;
      case 'collection.add':
      case 'collection.remove':
      case 'tradelist.mark':
        out.add('collection');
        break;
      case 'wish.add':
      case 'wish.remove':
      case 'wish.fulfilled':
        out.add('wishlist');
        break;
    }
  }
  return out;
}

/** The page asking "what can I undo?" — `global` accepts every entry. */
export type UndoScope =
  | { kind: 'container'; id: string }
  | { kind: 'collection' }
  | { kind: 'wishlist' }
  | { kind: 'global' };

export function scopeMatches(tokens: ReadonlySet<ScopeToken>, scope: UndoScope): boolean {
  switch (scope.kind) {
    case 'global':
      return true;
    case 'container':
      return tokens.has(`container:${scope.id}`);
    case 'collection':
      return tokens.has('collection');
    case 'wishlist':
      return tokens.has('wishlist');
  }
}

/** An entry as this module needs to see it: an id and the events it groups. */
export interface UndoGroup {
  id: string;
  events: readonly UserEvent[];
}

/**
 * Of these entries, the ids that can be undone right now.
 *
 * `groups` must be newest-first and unfiltered — an entry is blocked by a newer
 * change to the same row whether or not that change is on screen. Walking from
 * the newest down, an entry is undoable when none of its rows have been touched
 * by anything already walked past.
 *
 * A blocked entry stays blocked until whatever came after it is undone first,
 * which is what makes repeated undo behave like a stack rather than a lottery.
 */
export function undoableIds(groups: readonly UndoGroup[]): Set<string> {
  const touched = new Set<string>();
  const out = new Set<string>();
  for (const g of groups) {
    const keys = g.events.flatMap(rowKeysOf);
    if (!keys.some((k) => touched.has(k))) out.add(g.id);
    for (const k of keys) touched.add(k);
  }
  return out;
}
