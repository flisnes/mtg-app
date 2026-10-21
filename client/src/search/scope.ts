import { matchPath, useLocation } from 'react-router-dom';
import { CONTAINER_KINDS } from '@mtg/shared';
import { CONTAINER_META } from '../deck/containers.js';
import type { AddTarget } from '../components/cardSheet/types.js';
import type { Scope } from '../components/ScopedResults.js';
import type { IconName } from '../components/icons.js';

// Where the search was opened from, and which lists it can narrow to there.

/**
 * A page whose own rows the search can narrow in place. A superset of `Scope`:
 * ScopedResults can render your collection/tradelist/wishlist from anywhere,
 * but price movers only exist on their own page, so 'movers' is never a scope
 * you can carry off it.
 */
export type PageScope = Scope | 'movers';

export const SCOPE_NOUN: Record<PageScope, string> = {
  collection: 'collection',
  tradelist: 'tradelist',
  wishlist: 'wishlist',
  movers: 'price movers',
};

/** The list a page *is*, if it's one that renders its own rows.
 *  Scoping search to this page's own list filters it in place. */
export function listScopeFor(pathname: string): PageScope | null {
  if (pathname === '/' || pathname === '/collection') return 'collection';
  if (pathname === '/wishlist') return 'wishlist';
  if (pathname === '/tradelist') return 'tradelist';
  if (pathname === '/movers') return 'movers';
  return null;
}

// Scope chips let the search look inside one of your own lists (or, on a
// community page, what the person you're browsing has listed) instead of the
// whole database. Your three are mutually exclusive: a selection spanning two
// of them has no single list to render into and makes bulk actions ambiguous
// ("add to tradelist" on a wishlist row?).
export const SCOPES: { key: Scope; label: string; icon: IconName }[] = [
  { key: 'collection', label: 'Collection', icon: 'collection' },
  { key: 'tradelist', label: 'Tradelist', icon: 'tradelist' },
  { key: 'wishlist', label: 'Wishlist', icon: 'wishlist' },
];

// What adding a result does depends on where the user searched from: the deck
// editor adds to that deck, the collection adds to the collection, and so on.
// Everywhere else ('default') offers the generic trio. Grid tiles stay clean:
// tapping one opens the card sheet, which carries the add buttons; list rows
// keep a quick-add.
export function useSearchTarget(): AddTarget {
  const { pathname } = useLocation();
  // Decks, binders and boxes all take the 'deck' target (same stored rows);
  // containerKind only changes the wording and hides the board buttons.
  for (const kind of CONTAINER_KINDS) {
    const id = matchPath(`${CONTAINER_META[kind].path}/:id`, pathname)?.params.id;
    if (id) return { kind: 'deck', deckId: id, containerKind: kind };
  }
  const scope = listScopeFor(pathname);
  // Price movers is read-only: there's no "add a card to your movers".
  return scope && scope !== 'movers' ? { kind: scope } : { kind: 'default' };
}

// Browsing another user's trade/wishlist (Community page) lets the search scope
// into *their* published lists too. Only for someone else: on your own the
// profile pills would just duplicate the Collection/Tradelist/Wishlist ones.
export function useProfileScope(me: string | undefined): { username: string } | null {
  const { pathname } = useLocation();
  const username = matchPath('/community/:username', pathname)?.params.username;
  if (!username || (me && username === me)) return null;
  return { username };
}
