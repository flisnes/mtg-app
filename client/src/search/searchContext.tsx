import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { OracleCard } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import type { Scope } from '../components/ScopedResults.js';
import { recordSearch } from '../components/RecentSearches.js';
import { Icon } from '../components/icons.js';
import { listScopeFor, SCOPE_NOUN, type PageScope } from './scope.js';

// Card search is the front door to the hobby, so it lives in a persistent
// header instead of a tab: the input is reachable from every screen, and
// focusing it opens a full results overlay (filters, quick-adds, card sheet).
// Esc, the close button, or navigating to another tab closes the overlay.
//
// One exception, and it's the important one: when the scope is the very list
// you're standing on (Collection scope on /collection), the results ARE that
// page, so search filters it in place instead of covering it. You keep the
// page's sorting, multi-select and bulk actions and just narrow what they
// operate on. The overlay shrinks to a scope bar; turning the chip off expands
// it back to a full database search. See `useListFilter`.

/** How an entry point opens the search. Anything left out of `query` and
 *  `filters` keeps its current value; scope and pairWith default to none. */
export interface OpenSearch {
  scope?: PageScope | null;
  query?: string;
  filters?: SearchFilters;
  pairWith?: OracleCard | null;
  /** Put the cursor in the box ('select' also selects what's there). Off for
   *  entry points that already wrote the query: the keyboard would just cover
   *  the results. */
  focus?: boolean | 'select';
}

interface SearchCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (v: string) => void;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  /** The one list the search is narrowed to, or null for the whole database. */
  scope: PageScope | null;
  setScope: (s: PageScope | null) => void;
  /** A solo commander looking for their pair: results are narrowed to cards
   *  that can share the command zone with them, identity filter waived. */
  pairWith: OracleCard | null;
  setPairWith: (o: OracleCard | null) => void;
  /** Open the overlay the way an entry point wants it. */
  openWith: (o?: OpenSearch) => void;
  /** Close and drop everything, recording the query on the way out. */
  reset: () => void;
  /** Scope+query to apply on the next pathname-change reset, instead of the
   *  usual blank slate. See `useOpenCollectionSearch`. */
  queuePending: (p: { scope: Scope; query: string }) => void;
}

const Ctx = createContext<SearchCtx | null>(null);

export function useSearchCtx(): SearchCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSearchCtx: no GlobalSearchProvider above this component');
  return ctx;
}

// The entry-point hooks below hand back a stable function: callers memoize on
// it (ContainerDetail's Commander footer, for one), and the context value
// itself changes on every keystroke. So they close over the provider's
// memoized openWith/queuePending, never over the whole ctx.

/** Open (and focus) the global search from anywhere, e.g. "Add cards" buttons. */
export function useOpenSearch(): () => void {
  const openWith = useContext(Ctx)?.openWith;
  // These entry points mean "go find a card", so they always search the whole
  // database, never the (usually empty) list that offered the button.
  return useCallback(() => openWith?.({ focus: true }), [openWith]);
}

/** Magnifying glass in a list's toolbar: search this list, not the database.
 *  The header bar deliberately doesn't do this: reaching for it nearly always
 *  means "find a card to add", so it starts unscoped and this button is how
 *  you say "search what's in front of me". */
export function ListSearchButton() {
  const ctx = useContext(Ctx);
  const { pathname } = useLocation();
  const scope = listScopeFor(pathname);
  if (!scope) return null;
  const label = `Search your ${SCOPE_NOUN[scope]}`;
  return (
    <button
      className="select-toggle list-search-btn"
      onClick={() => ctx?.openWith({ scope, focus: true })}
      title={label}
      aria-label={label}
    >
      <Icon name="search" size={15} />
    </button>
  );
}

/**
 * The live search query when search is scoped to *this page's own list*, else
 * ''. List views (collection, tradelist, wishlist) call this and filter their
 * rows with it, which is what keeps sorting, multi-select and bulk actions
 * working on a searched-down list.
 */
export function useListFilter(scope: PageScope): string {
  const ctx = useContext(Ctx);
  const { pathname } = useLocation();
  if (!ctx?.open || ctx.scope !== scope || listScopeFor(pathname) !== scope) return '';
  return ctx.query;
}

/**
 * Jump to the Collection screen with search open, scoped to Collection, and
 * the given card name as an exact quoted query: the "In your collection"
 * badge's one-tap route to every copy of that card. Navigating changes the
 * pathname, which would otherwise reset search to a blank slate (see the
 * provider), so the intent is queued and consumed by that same reset.
 */
export function useOpenCollectionSearch(): (cardName: string) => void {
  const ctx = useContext(Ctx);
  const openWith = ctx?.openWith;
  const queuePending = ctx?.queuePending;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback(
    (cardName: string) => {
      const query = `"${cardName}"`;
      if (listScopeFor(pathname) === 'collection') {
        // Already there: the pathname-change reset won't fire, so open directly.
        openWith?.({ scope: 'collection', query });
      } else {
        queuePending?.({ scope: 'collection', query });
        navigate('/collection');
      }
    },
    [openWith, queuePending, navigate, pathname],
  );
}

/**
 * The Commander section's "Find a partner" button: open the search narrowed to
 * cards that can share the command zone with the solo commander. The identity
 * checkbox is replaced by a "Can partner with …" one, so Tymna's WB doesn't
 * hide Tana (see SearchFilters.pairOnly). No focus: the results ARE the answer.
 */
export function useOpenPairSearch(): (commander: OracleCard) => void {
  const openWith = useContext(Ctx)?.openWith;
  return useCallback((commander: OracleCard) => openWith?.({ query: '', filters: {}, pairWith: commander }), [openWith]);
}

/**
 * Open the overlay on a query we wrote ourselves, against the whole database:
 * the rules-text chip's route out of the card sheet (see OracleSearchChip).
 * Filters are cleared because a search the user didn't type shouldn't inherit
 * narrowing they can't see.
 */
export function useOpenDbSearch(): (query: string) => void {
  const openWith = useContext(Ctx)?.openWith;
  return useCallback((query: string) => openWith?.({ query, filters: {} }), [openWith]);
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  // Search starts unscoped everywhere, even on /wishlist: the header bar is
  // mostly reached for to add a card, and a pre-picked list would hide the
  // card you were looking for. Narrowing to the list you're standing on is one
  // tap away on the list's own button (see `ListSearchButton`).
  const [scope, setScope] = useState<PageScope | null>(null);
  const [pairWith, setPairWith] = useState<OracleCard | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<{ scope: Scope; query: string } | null>(null);
  // Read by reset() so recording the outgoing query needs no dependency on it.
  const queryRef = useRef(query);
  queryRef.current = query;

  const openWith = useCallback((o: OpenSearch = {}) => {
    setScope(o.scope ?? null);
    setPairWith(o.pairWith ?? null);
    if (o.query !== undefined) setQuery(o.query);
    if (o.filters) setFilters(o.filters);
    setOpen(true);
    if (o.focus) inputRef.current?.focus();
    if (o.focus === 'select') inputRef.current?.select();
  }, []);

  // Closing is the usual "I'm done with this search for now", so it's the main
  // thing that feeds the recent list. Scope goes too, so the next tap on the
  // bar starts on the whole database rather than resuming a list filter the
  // user already dismissed.
  const reset = useCallback(() => {
    recordSearch(queryRef.current);
    setQuery('');
    setFilters({});
    setScope(null);
    setPairWith(null);
    setOpen(false);
    inputRef.current?.blur();
  }, []);

  const queuePending = useCallback((p: { scope: Scope; query: string }) => {
    pendingRef.current = p;
  }, []);

  // Navigating away (the tab bar stays tappable under the overlay) closes
  // search and drops the query, filters and scope, so reopening it on the new
  // page doesn't resurrect the old one's search. A queued pending scope+query
  // (useOpenCollectionSearch) overrides that blank slate for this one reset.
  const prevPath = useRef(pathname);
  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return reset();
    recordSearch(queryRef.current);
    openWith({ scope: pending.scope, query: pending.query, filters: {} });
  }, [pathname, reset, openWith]);

  const value = useMemo(
    () => ({
      open,
      setOpen,
      inputRef,
      query,
      setQuery,
      filters,
      setFilters,
      scope,
      setScope,
      pairWith,
      setPairWith,
      openWith,
      reset,
      queuePending,
    }),
    [open, query, filters, scope, pairWith, openWith, reset, queuePending],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
