import type { ContainerKind, DeckBoard, EventSource, RemovalReason, UserEvent } from '@mtg/shared';
import type { IconName } from '../components/icons.js';
import { CONTAINER_META } from '../deck/containers.js';

// Single source of truth for how a recorded UserEvent is presented — its label,
// icon, and qty direction — plus the filter categories the edit-history view
// offers. Adding or removing a recorded event type is a change *here* (and the
// matching emit() in dataAccess); the card History tab, the edit-history list,
// the event modal, and the type filter all read from this file so they stay in
// step. Keep it presentation-only: no DB access, no React.

export type EventDirection = 'in' | 'out' | 'neutral';

export interface EventDisplay {
  /** Human label for the action ("Sold", "Received in trade", …). */
  verb: string;
  icon: IconName;
  /** Tints the quantity badge: green in, red out, plain neutral. */
  direction: EventDirection;
}

/** Removal reasons as shown to the user (also used by the reason picker). */
export const REASON_LABELS: Record<RemovalReason, string> = {
  sold: 'Sold',
  traded: 'Traded away',
  lost: 'Lost',
  corrected: 'Corrected',
  other: 'Removed',
};

function boardSuffix(e: UserEvent): string {
  return e.board === 'side'
    ? ' (sideboard)'
    : e.board === 'commander'
      ? ' (commander)'
      : e.board === 'token'
        ? ' (tokens)'
        : '';
}

// Deck slot events cover binders and boxes too (same rows); `deckKind` is only
// set for storage, so anything without it reads as a deck, as it always did.
function containerIcon(e: UserEvent): IconName {
  return CONTAINER_META[e.deckKind ?? 'deck'].icon;
}

/** "a deck" / "a binder" / "a box", for an event whose container is long gone. */
function containerNoun(e: UserEvent): string {
  return `a ${CONTAINER_META[e.deckKind ?? 'deck'].noun}`;
}

/** A collection event came from a trade (new events carry source; old ones only tradeId). */
function isTrade(e: UserEvent): boolean {
  return e.source === 'trade' || e.tradeId != null;
}

/** How to render a single event (card History tab + edit-history rows). */
export function describeEvent(e: UserEvent): EventDisplay {
  switch (e.kind) {
    case 'collection.add':
      // A backfill for a card given away but never registered — read it as a
      // plain add, not "Received in trade" (it left the collection, not entered).
      if (e.reconcile) return { verb: 'Added to collection', icon: 'plus', direction: 'in' };
      if (isTrade(e)) return { verb: 'Received in trade', icon: 'trade', direction: 'in' };
      if (e.source === 'import') return { verb: 'Imported', icon: 'import', direction: 'in' };
      if (e.source === 'sealed') return { verb: 'Sealed product', icon: 'sealed', direction: 'in' };
      return { verb: 'Added to collection', icon: 'plus', direction: 'in' };
    case 'collection.remove':
      if (isTrade(e)) return { verb: 'Traded away', icon: 'trade', direction: 'out' };
      return { verb: REASON_LABELS[e.reason ?? 'sold'], icon: 'minus', direction: 'out' };
    case 'deck.add':
      return { verb: `Added to ${e.deckName ?? containerNoun(e)}${boardSuffix(e)}`, icon: containerIcon(e), direction: 'in' };
    case 'deck.remove':
      return { verb: `Removed from ${e.deckName ?? containerNoun(e)}`, icon: containerIcon(e), direction: 'out' };
    case 'wish.add':
      return { verb: 'Added to wishlist', icon: 'wishlist', direction: 'neutral' };
    case 'wish.fulfilled':
      return { verb: 'Wish fulfilled', icon: 'wishlist', direction: 'neutral' };
    case 'wish.remove':
      return { verb: 'Removed from wishlist', icon: 'wishlist', direction: 'neutral' };
    case 'tradelist.mark':
      return { verb: 'Marked for trade', icon: 'tradelist', direction: 'neutral' };
  }
}

const BOARD_NOUN: Record<DeckBoard, string> = {
  main: 'mainboard',
  side: 'sideboard',
  commander: 'command zone',
  token: 'tokens',
};

/**
 * A batch that both takes deck slots out and puts them back in is a move
 * between zones: the same cards, described twice. Both halves are needed (undo
 * replays them backwards), but anything counting cards must not count both.
 */
export function isMoveBatch(events: readonly UserEvent[]): boolean {
  return events.some((e) => e.kind === 'deck.add') && events.some((e) => e.kind === 'deck.remove');
}

/** How many cards a batch touched — a move's pairs counted once. */
export function batchCount(events: readonly UserEvent[]): number {
  const counted = isMoveBatch(events) ? events.filter((e) => e.kind === 'deck.add') : events;
  return counted.reduce((sum, e) => sum + (e.qty ?? 0), 0);
}

/**
 * How to render a grouped batch entry (import / sealed / scan / trade / a
 * multi-select operation). Deck and wishlist batches are named for their
 * destination (a scan into a deck still reads "Added to <deck>"), everything
 * else by how the batch was made. A batch that both removes and adds deck slots
 * is a move between zones, and says so rather than reading as a removal.
 */
export function describeBatch(source: EventSource, label?: string, events: readonly UserEvent[] = []): EventDisplay {
  const kind = events[0]?.kind;
  // Only storage sets deckKind, so a batch without it keeps the deck icon it
  // always had.
  const deckKind = events[0]?.deckKind;
  const containerIcon = CONTAINER_META[deckKind ?? 'deck'].icon;
  if (isMoveBatch(events)) {
    const to = events.find((e) => e.kind === 'deck.add')?.board;
    return {
      verb: to ? `Moved to ${BOARD_NOUN[to]}` : 'Moved between zones',
      icon: 'moveTo',
      direction: 'neutral',
    };
  }
  if (kind === 'deck.add') return { verb: `Added to ${label ?? 'a deck'}`, icon: containerIcon, direction: 'in' };
  // A bulk removal from a deck, binder or box (multi-select "remove these").
  if (kind === 'deck.remove') {
    return {
      verb: `Removed from ${label ?? `a ${CONTAINER_META[deckKind ?? 'deck'].noun}`}`,
      icon: containerIcon,
      direction: 'out',
    };
  }
  if (kind === 'wish.add') return { verb: 'Added to wishlist', icon: 'wishlist', direction: 'neutral' };
  if (kind === 'tradelist.mark') return { verb: 'Marked for trade', icon: 'tradelist', direction: 'neutral' };
  if (source === 'scan') return { verb: 'Scanned', icon: 'camera', direction: 'in' };
  if (source === 'sealed') return { verb: label ?? 'Sealed product', icon: 'sealed', direction: 'in' };
  if (source === 'trade') return { verb: 'Trade', icon: 'trade', direction: 'neutral' };
  return { verb: 'Imported', icon: 'import', direction: 'in' };
}

/**
 * Wording for a slot event seen from *inside* its own container's history,
 * where the container's name is already the page title. Naming it again ("Added
 * to Mono-Red Burn") wastes the line, so the board is what gets said instead;
 * storage has no boards, so it just goes in or out.
 */
export function describeDeckEvent(e: UserEvent, kind: ContainerKind): EventDisplay {
  const added = e.kind === 'deck.add';
  const shape = { icon: (added ? 'plus' : 'minus') as IconName, direction: (added ? 'in' : 'out') as EventDirection };
  if (kind !== 'deck') return { verb: added ? 'Filed here' : 'Taken out', ...shape };
  const where = BOARD_NOUN[e.board ?? 'main'];
  return { verb: added ? `Added to ${where}` : `Removed from ${where}`, ...shape };
}

/**
 * Deck-scoped wording for a batch of slot events (a scan, a pasted list, a
 * multi-select filed away). Takes the totals rather than the events because a
 * re-scan reconciles — it can add *and* remove in one pass, and then neither
 * "added" nor "removed" is the honest word for it.
 */
export function describeDeckBatch(source: EventSource, added: number, removed: number): EventDisplay {
  if (added > 0 && removed > 0) {
    return { verb: source === 'scan' ? 'Re-scanned' : 'Reconciled', icon: 'refresh', direction: 'neutral' };
  }
  const out = removed > 0;
  const direction: EventDirection = out ? 'out' : 'in';
  if (source === 'scan') return { verb: out ? 'Removed by scan' : 'Scanned in', icon: 'camera', direction };
  if (source === 'import') return { verb: 'Imported list', icon: 'import', direction };
  return { verb: out ? 'Removed in bulk' : 'Added in bulk', icon: out ? 'minus' : 'plus', direction };
}

/** Signed quantity text for a direction, or null when there's no quantity. */
export function signedQty(direction: EventDirection, qty?: number): string | null {
  if (!qty) return null;
  if (direction === 'in') return `+${qty}`;
  if (direction === 'out') return `−${qty}`;
  return `${qty}×`;
}

/** Signed quantity badge text for an event, or null when there's no quantity. */
export function qtyBadge(e: UserEvent): string | null {
  return signedQty(describeEvent(e).direction, e.qty);
}

// ---------------------------------------------------------------------------
// Type filter for the edit-history view. Each category is a predicate over an
// event; an entry matches a category if any of its events do. Add/remove a
// row here to change what the filter dropdown offers.
// ---------------------------------------------------------------------------

export interface FilterCategory {
  value: string;
  label: string;
  match: (e: UserEvent) => boolean;
}

export const FILTER_CATEGORIES: readonly FilterCategory[] = [
  {
    value: 'add',
    label: 'Added',
    match: (e) => e.kind === 'collection.add' && !isTrade(e) && e.source !== 'import' && e.source !== 'sealed',
  },
  {
    value: 'remove',
    label: 'Sold / removed',
    match: (e) => e.kind === 'collection.remove' && !isTrade(e),
  },
  { value: 'import', label: 'Imports', match: (e) => e.source === 'import' },
  { value: 'sealed', label: 'Sealed products', match: (e) => e.source === 'sealed' },
  { value: 'trade', label: 'Trades', match: isTrade },
  { value: 'wishlist', label: 'Wishlist', match: (e) => e.kind.startsWith('wish.') },
  // One category for every container: decks, binders and boxes share the kind.
  { value: 'deck', label: 'Decks & storage', match: (e) => e.kind.startsWith('deck.') },
  { value: 'tradelist', label: 'Tradelist', match: (e) => e.kind === 'tradelist.mark' },
];

