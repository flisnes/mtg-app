import type { EventSource, RemovalReason, UserEvent, UserEventKind } from '@mtg/shared';
import type { IconName } from '../components/icons.js';

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
  other: 'Removed',
};

function boardSuffix(e: UserEvent): string {
  return e.board === 'side' ? ' (sideboard)' : e.board === 'commander' ? ' (commander)' : '';
}

/** A collection event came from a trade (new events carry source; old ones only tradeId). */
function isTrade(e: UserEvent): boolean {
  return e.source === 'trade' || e.tradeId != null;
}

/** How to render a single event (card History tab + edit-history rows). */
export function describeEvent(e: UserEvent): EventDisplay {
  switch (e.kind) {
    case 'collection.add':
      if (isTrade(e)) return { verb: 'Received in trade', icon: 'trade', direction: 'in' };
      if (e.source === 'import') return { verb: 'Imported', icon: 'import', direction: 'in' };
      if (e.source === 'sealed') return { verb: 'Sealed product', icon: 'sealed', direction: 'in' };
      return { verb: 'Added to collection', icon: 'plus', direction: 'in' };
    case 'collection.remove':
      if (isTrade(e)) return { verb: 'Traded away', icon: 'trade', direction: 'out' };
      return { verb: REASON_LABELS[e.reason ?? 'sold'], icon: 'minus', direction: 'out' };
    case 'deck.add':
      return { verb: `Added to ${e.deckName ?? 'a deck'}${boardSuffix(e)}`, icon: 'decks', direction: 'in' };
    case 'deck.remove':
      return { verb: `Removed from ${e.deckName ?? 'a deck'}`, icon: 'decks', direction: 'out' };
    case 'wish.add':
      return { verb: 'Added to wishlist', icon: 'wishlist', direction: 'neutral' };
    case 'wish.fulfilled':
      return { verb: 'Wish fulfilled', icon: 'wishlist', direction: 'neutral' };
    case 'wish.remove':
      return { verb: 'Removed from wishlist', icon: 'wishlist', direction: 'neutral' };
  }
}

/**
 * How to render a grouped batch entry (import / sealed / scan / trade). `kind`
 * is a representative event of the batch: deck and wishlist batches are named
 * for their destination (a scan into a deck still reads "Added to <deck>"),
 * everything else by how the batch was made.
 */
export function describeBatch(source: EventSource, label?: string, kind?: UserEventKind): EventDisplay {
  if (kind === 'deck.add') return { verb: `Added to ${label ?? 'a deck'}`, icon: 'decks', direction: 'in' };
  if (kind === 'wish.add') return { verb: 'Added to wishlist', icon: 'wishlist', direction: 'neutral' };
  if (source === 'scan') return { verb: 'Scanned', icon: 'camera', direction: 'in' };
  if (source === 'sealed') return { verb: label ?? 'Sealed product', icon: 'sealed', direction: 'in' };
  if (source === 'trade') return { verb: 'Trade', icon: 'trade', direction: 'neutral' };
  return { verb: 'Imported', icon: 'import', direction: 'in' };
}

/** Signed quantity badge text for an event, or null when there's no quantity. */
export function qtyBadge(e: UserEvent): string | null {
  if (!e.qty) return null;
  const dir = describeEvent(e).direction;
  if (dir === 'in') return `+${e.qty}`;
  if (dir === 'out') return `−${e.qty}`;
  return `${e.qty}×`;
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
  { value: 'deck', label: 'Decks', match: (e) => e.kind.startsWith('deck.') },
];

/** Whether an event shows in the edit-history view at all (all do, for now). */
export function shownInHistory(_e: UserEvent): boolean {
  return true;
}
