import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { CONTAINER_KINDS, type Color, type DeckBoard, type DeckFormat, type OracleCard, type Priced, type Printing } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { addDeckCard, addToCollection, addToWishlist, addToWishlistBulk } from '../db/dataAccess.js';
import { formatLabel, isBackground, isBasicLand, isValidCommanderPair } from '../deck/legality.js';
import { CONTAINER_META } from '../deck/containers.js';
import { CardSheet, type AddTarget } from './CardSheet.js';
import { CardSearchView } from './CardSearchView.js';
import { BulkActionBar } from './BulkActionBar.js';
import { useMultiSelect } from './useMultiSelect.js';
import { RecentSearches, recordSearch } from './RecentSearches.js';
import { ScopedResults, type Scope } from './ScopedResults.js';
import { ProfileScopedResults } from './ProfileScopedResults.js';
import { ContainerScopedResults } from './ContainerScopedResults.js';
import type { IconName } from './icons.js';
import { ownedBadge } from './OwnedBadge.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { useToast } from './Toast.js';
import { Icon } from './icons.js';
import { AccountMenu } from './AccountMenu.js';
import { NotificationBell } from './NotificationBell.js';
import { useAccount } from '../account/useAccount.js';
import { useOwnAvatar } from '../account/ownProfile.js';
import { useDismiss } from './useDismiss.js';

// Card search is the front door to the hobby, so it lives in a persistent
// header instead of a tab: the input is reachable from every screen, and
// focusing it opens a full results overlay (filters, quick-adds, card sheet).
// Esc, ✕, or navigating to another tab closes the overlay.
//
// One exception, and it's the important one: when the scope is the very list
// you're standing on (Collection scope on /collection), the results ARE that
// page, so search filters it in place instead of covering it — you keep the
// page's sorting, multi-select and bulk actions and just narrow what they
// operate on. The overlay shrinks to a scope bar; turning the chip off expands
// it back to a full database search. See `useListFilter`.

// What adding a result does depends on where the user searched from: the deck
// editor adds to that deck, the collection adds to the collection, and so on.
// Everywhere else ('default') offers the generic trio. Grid tiles stay clean —
// tapping one opens the card sheet, which carries the add buttons; list rows
// keep a quick-add.
function useSearchTarget(): AddTarget {
  const { pathname } = useLocation();
  // Decks, binders and boxes all take the 'deck' target (same stored rows);
  // containerKind only changes the wording and hides the board buttons.
  for (const kind of CONTAINER_KINDS) {
    const id = matchPath(`${CONTAINER_META[kind].path}/:id`, pathname)?.params.id;
    if (id) return { kind: 'deck', deckId: id, containerKind: kind };
  }
  const scope = listScopeFor(pathname);
  // Price movers is read-only — there's no "add a card to your movers".
  return scope && scope !== 'movers' ? { kind: scope } : { kind: 'default' };
}

/**
 * A page whose own rows the search can narrow in place. A superset of `Scope`:
 * ScopedResults can render your collection/tradelist/wishlist from anywhere,
 * but price movers only exist on their own page, so 'movers' is never a scope
 * you can carry off it.
 */
export type PageScope = Scope | 'movers';

const SCOPE_NOUN: Record<PageScope, string> = {
  collection: 'collection',
  tradelist: 'tradelist',
  wishlist: 'wishlist',
  movers: 'price movers',
};

/** The list a page *is*, if it's one that renders its own rows.
 *  Scoping search to this page's own list filters it in place. */
function listScopeFor(pathname: string): PageScope | null {
  if (pathname === '/' || pathname === '/collection') return 'collection';
  if (pathname === '/wishlist') return 'wishlist';
  if (pathname === '/tradelist') return 'tradelist';
  if (pathname === '/movers') return 'movers';
  return null;
}

// Browsing another user's trade/wishlist (Community page) lets the search scope
// into *their* published lists too. Only for someone else — on your own the
// profile pills would just duplicate the Collection/Tradelist/Wishlist ones.
function useProfileScope(me: string | undefined): { username: string } | null {
  const { pathname } = useLocation();
  const username = matchPath('/community/:username', pathname)?.params.username;
  if (!username || (me && username === me)) return null;
  return { username };
}

// Scope chips let the search look inside one of your own lists (or, on a
// community page, what the person you're browsing has listed) instead of the
// whole database. Your three are mutually exclusive — a selection spanning two
// of them has no single list to render into and makes bulk actions ambiguous
// ("add to tradelist" on a wishlist row?).
const SCOPES: { key: Scope; label: string; icon: IconName }[] = [
  { key: 'collection', label: 'Collection', icon: 'collection' },
  { key: 'tradelist', label: 'Tradelist', icon: 'tradelist' },
  { key: 'wishlist', label: 'Wishlist', icon: 'wishlist' },
];

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
  /** Scope+query to apply on the next pathname-change reset, instead of the
   *  usual blank slate — see `useOpenCollectionSearch`. */
  queuePending: (p: { scope: Scope; query: string }) => void;
}

const Ctx = createContext<SearchCtx | null>(null);

/** Open (and focus) the global search from anywhere, e.g. "＋ Add cards" buttons. */
export function useOpenSearch(): () => void {
  const ctx = useContext(Ctx);
  return () => {
    // These entry points mean "go find a card", so they always search the whole
    // database — never the (usually empty) list that offered the button.
    ctx?.setScope(null);
    ctx?.setOpen(true);
    ctx?.inputRef.current?.focus();
  };
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
 * the given card name as an exact quoted query — the "In your collection"
 * badge's one-tap route to every copy of that card. Navigating changes the
 * pathname, which would otherwise reset search to a blank slate (see the
 * effect below), so the intent is queued and consumed by that same reset.
 */
export function useOpenCollectionSearch(): (cardName: string) => void {
  const ctx = useContext(Ctx);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (cardName: string) => {
    const query = `"${cardName}"`;
    if (pathname === '/' || pathname === '/collection') {
      // Already there — the pathname-change reset won't fire, so set directly.
      ctx?.setScope('collection');
      ctx?.setQuery(query);
      ctx?.setOpen(true);
    } else {
      ctx?.queuePending({ scope: 'collection', query });
      navigate('/collection');
    }
  };
}

/**
 * Open the overlay on a query we wrote ourselves, against the whole database —
 * the rules-text chip's route out of the card sheet (see OracleSearchChip). No
 * navigation, so no pathname-change reset to queue behind: scope, filters and
 * query are set directly. Filters are cleared because a search the user didn't
 * type shouldn't inherit narrowing they can't see, and the input isn't focused
 * because the query is already written and the keyboard would just cover the
 * results.
 */
export function useOpenDbSearch(): (query: string) => void {
  const ctx = useContext(Ctx);
  return (query: string) => {
    ctx?.setScope(null);
    ctx?.setFilters({});
    ctx?.setQuery(query);
    ctx?.setOpen(true);
  };
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  // Pre-pick the list you're standing on, so search on /wishlist starts by
  // filtering the wishlist.
  const [scope, setScope] = useState<PageScope | null>(() => listScopeFor(pathname));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<{ scope: Scope; query: string } | null>(null);
  const queuePending = (p: { scope: Scope; query: string }) => {
    pendingRef.current = p;
  };

  // Navigating away (the tab bar stays tappable under the overlay) closes
  // search and drops the query, filters and scope, so reopening it on the new
  // page doesn't resurrect the old one's search. The query goes to the recent
  // list on the way out, which is what makes the round trip survivable. A
  // queued pending scope+query (useOpenCollectionSearch) overrides that blank
  // slate for this one reset.
  const prevPath = useRef(pathname);
  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    recordSearch(query);
    const pending = pendingRef.current;
    pendingRef.current = null;
    setQuery(pending?.query ?? '');
    setFilters({});
    setScope(pending?.scope ?? listScopeFor(pathname));
    setOpen(!!pending);
    if (!pending) inputRef.current?.blur();
  }, [pathname, query]);

  const value = useMemo(
    () => ({ open, setOpen, inputRef, query, setQuery, filters, setFilters, scope, setScope, queuePending }),
    [open, query, filters, scope],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The header search bar + results overlay. Render once, inside the provider. */
export function GlobalSearchBar() {
  const ctx = useContext(Ctx)!;
  const { open, setOpen, inputRef, query, setQuery, setFilters } = ctx;
  const { enabled: accountsEnabled, session, syncReady, pendingChanges, sync } = useAccount();
  const signedIn = !!session;
  const ownAvatar = useOwnAvatar(session);

  // Subtle sync indicator on the account button: green = synced, amber =
  // syncing or changes waiting (or the join-account decision pending), red =
  // sync error. Signed out shows no dot at all.
  const syncTone =
    sync.phase === 'error' ? 'err' : sync.phase === 'syncing' || pendingChanges > 0 || !syncReady ? 'busy' : 'ok';
  const syncLabel =
    sync.phase === 'error'
      ? 'sync problem'
      : sync.phase === 'syncing'
        ? 'syncing…'
        : pendingChanges > 0
          ? `${pendingChanges} ${pendingChanges === 1 ? 'change' : 'changes'} waiting to sync`
          : !syncReady
            ? 'sync setup pending'
            : 'synced';

  // Closing is the usual "I'm done with this search for now" — off to look at
  // the deck — so it's the main thing that feeds the recent list. Scope doesn't
  // matter: the same Scryfall syntax searches your own lists, and one shared
  // list means a query typed against the database can be reused on a binder.
  function close() {
    recordSearch(query);
    setQuery('');
    setFilters({});
    setOpen(false);
    inputRef.current?.blur();
  }

  // Escape and the back button dismiss the overlay through the shared stack, so
  // a sheet opened from a search result closes before the search itself does.
  useDismiss(open ? close : null);

  return (
    <>
      <header className="app-header">
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder='Search cards… (bolt, t:goblin, o:"draw a card")'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          // Results update live; Enter just dismisses the (mobile) keyboard
          // so it stops covering them. The overlay stays open. It does count as
          // committing the query though, so the recent list gets it now rather
          // than only if the search is closed cleanly.
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            recordSearch(query);
            e.currentTarget.blur();
          }}
          enterKeyHint="search"
          aria-label="Search cards"
        />
        {open ? (
          <button className="header-close" onClick={close} aria-label="Close search">
            ✕
          </button>
        ) : (
          // The bell also carries local filing conflicts, so it isn't gated on
          // accounts being switched on at all — it hides itself when there's
          // genuinely nothing to report.
          <>
            <NotificationBell signedIn={accountsEnabled && signedIn} />
            {accountsEnabled && (
              <AccountMenu
                signedIn={signedIn}
                username={session?.username}
                ownAvatar={ownAvatar}
                syncTone={syncTone}
                syncLabel={syncLabel}
              />
            )}
          </>
        )}
      </header>
      {open && <SearchOverlay />}
    </>
  );
}

function SearchOverlay() {
  const { query, setQuery, filters, setFilters, scope, setScope } = useContext(Ctx)!;
  const { pathname } = useLocation();
  // The sheet opens on the printing the result was showing, so tapping a tile
  // doesn't silently swap to a different edition than the one you tapped.
  const [sheetCard, setSheetCard] = useState<{ card: Priced<OracleCard>; scryfallId?: string } | null>(null);
  const [deckLegalOnly, setDeckLegalOnly] = useState(true);
  const toast = useToast();
  const target = useSearchTarget();
  const { session } = useAccount();
  const profile = useProfileScope(session?.username);
  // The viewed user's two lists are what you're looking at on their page, so
  // both start on. They're independent of your own (single) scope.
  const [profileTradeOn, setProfileTradeOn] = useState(!!profile);
  const [profileWishOn, setProfileWishOn] = useState(!!profile);
  const ownership = useOwnershipIndex();

  // Unlike the three list pills, this one never starts on — standing on a deck
  // doesn't mean you want search narrowed to it, since half of what you're
  // there to do is find cards that *aren't* in it yet. So the pill offers the
  // scope; it never assumes it the way listScopeFor does for your own lists.
  const [containerOn, setContainerOn] = useState(false);

  // Multi-select over the results. A search result is a card, not a copy you
  // own, so the only thing a selection of them can honestly do is go on the
  // wishlist — adding to the collection needs an edition, a condition and a
  // language per card, which is exactly what the card sheet is for.
  const sel = useMultiSelect();
  const [resultKeys, setResultKeys] = useState<string[]>([]);

  async function bulkWish() {
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const res = await addToWishlistBulk(
      ids.map((oracleId) => ({ oracleId, scryfallId: null, quantity: 1 })),
      { source: 'manual', label: 'From search' },
    );
    toast(`Added ${res.cards} card${res.cards === 1 ? '' : 's'} to wishlist`);
    sel.exit();
  }

  // Wording for the container being searched from (a deck, binder or box).
  const containerMeta = CONTAINER_META[(target.kind === 'deck' && target.containerKind) || 'deck'];

  // The full set of pills for this context: your own three everywhere, this
  // container's one wherever you're standing on a deck/binder/box, plus the
  // viewed user's two on their community page.
  // The movers pill only exists on the movers page: nothing off it can render
  // that list, so carrying the scope away would have nothing to show.
  const pageScopes: { key: PageScope; label: string; icon: IconName }[] =
    listScopeFor(pathname) === 'movers'
      ? [...SCOPES, { key: 'movers', label: 'Price movers', icon: 'prices' }]
      : SCOPES;

  const pills: { key: string; label: string; icon: IconName; title: string; on: boolean; toggle: () => void }[] = [
    ...pageScopes.map((s) => ({
      key: s.key,
      label: s.label,
      icon: s.icon,
      title: `Search your ${s.label.toLowerCase()}`,
      on: scope === s.key,
      toggle: () => {
        setScope(scope === s.key ? null : s.key);
        setContainerOn(false);
      },
    })),
    ...(target.kind === 'deck'
      ? [
          {
            key: 'container',
            label: `This ${containerMeta.noun}`,
            icon: containerMeta.icon,
            title: `Search this ${containerMeta.noun}`,
            on: containerOn,
            toggle: () => {
              setContainerOn((v) => !v);
              setScope(null);
            },
          },
        ]
      : []),
    ...(profile
      ? [
          {
            key: 'profileTrade',
            label: `${profile.username}’s tradelist`,
            icon: 'tradelist' as IconName,
            title: `Search ${profile.username}’s tradelist`,
            on: profileTradeOn,
            toggle: () => setProfileTradeOn((v) => !v),
          },
          {
            key: 'profileWish',
            label: `${profile.username}’s wishlist`,
            icon: 'wishlist' as IconName,
            title: `Search ${profile.username}’s wishlist`,
            on: profileWishOn,
            toggle: () => setProfileWishOn((v) => !v),
          },
        ]
      : []),
  ];

  const chips = (
    <div className="scope-chips" role="group" aria-label="Search within">
      {pills.map((s) => (
        <button key={s.key} className="chip" aria-pressed={s.on} onClick={s.toggle} title={s.title}>
          <Icon name={s.icon} size={14} /> {s.label}
        </button>
      ))}
    </div>
  );

  const profileActive = !!profile && !!session && (profileTradeOn || profileWishOn);
  const scoped = !!scope || profileActive || containerOn;

  // Searching from a deck filters to cards you could actually play there: legal
  // in the deck's format and, for Commander, within the commander's identity.
  const deckId = target.kind === 'deck' ? target.deckId : undefined;
  const deckCtx = useLiveQuery(async () => {
    if (!deckId) return null;
    const deck = await db.decks.get(deckId);
    if (!deck) return null;
    const format: DeckFormat = deck.format ?? 'casual';
    let identity: Color[] | null = null;
    let commanders: OracleCard[] = [];
    if (format === 'commander') {
      const rows = await db.deckCards.where('[deckId+board]').equals([deckId, 'commander']).toArray();
      if (rows.length) {
        const oracles = await db.oracleCards.bulkGet(rows.map((c) => c.oracleId));
        commanders = oracles.filter((o): o is OracleCard => !!o);
        identity = [...new Set(commanders.flatMap((o) => o.colorIdentity))];
      }
    }
    return { format, identity, commanders };
  }, [deckId]);
  const deckFilterActive = deckLegalOnly && !!deckCtx && deckCtx.format !== 'casual';

  // One commander in the zone shouldn't hide the partner or Background that
  // would join them: the second commander is exactly what widens the identity.
  // (Legendary-or-Background first, so the pairing regexes only run on the few.)
  const partnerExempt = useMemo(() => {
    const solo = deckCtx?.commanders.length === 1 ? deckCtx.commanders[0]! : null;
    if (!solo) return undefined;
    return (c: OracleCard) =>
      (/\bLegendary\b/.test(c.typeLine) || isBackground(c)) && isValidCommanderPair(solo, c);
  }, [deckCtx]);

  const effectiveFilters = useMemo<SearchFilters>(
    () =>
      deckFilterActive
        ? {
            ...filters,
            legalIn: deckCtx!.format,
            identity: deckCtx!.identity ?? undefined,
            identityExempt: partnerExempt,
          }
        : filters,
    [filters, deckFilterActive, deckCtx, partnerExempt],
  );

  // Scoped to the list this very page renders: it filters itself (keeping its
  // sort, multi-select and bulk actions), so all the overlay contributes is the
  // chip row. Everything else gets the full-screen results. Every hook above
  // has to stay above this return — toggling the chip flips the branch.
  if (scope && listScopeFor(pathname) === scope) {
    return (
      <div className="search-scopebar">
        <div className="search-overlay-inner">
          {chips}
          {!query && (
            <>
              <p className="search-meta">
                Filtering your {SCOPE_NOUN[scope]}. Turn the chip off to search every card instead.
              </p>
              <RecentSearches onPick={setQuery} />
            </>
          )}
        </div>
      </div>
    );
  }

  // Quick-add uses the printing the result is showing (the user's preference,
  // or the card DB's representative) / NM / nonfoil / en; the sheet is for detail.
  const shownId = (card: OracleCard, printing?: Printing) => printing?.scryfallId ?? card.defaultScryfallId;

  async function quickCollection(card: OracleCard, printing?: Printing) {
    await addToCollection({ oracleId: card.oracleId, scryfallId: shownId(card, printing), condition: 'NM', finish: 'nonfoil', lang: 'en' });
    toast(`Added ${card.name} to collection`);
  }
  async function quickWishlist(card: OracleCard) {
    await addToWishlist({ oracleId: card.oracleId, scryfallId: null });
    toast(`Added ${card.name} to wishlist`);
  }
  async function quickTradelist(card: OracleCard, printing?: Printing) {
    await addToCollection({ oracleId: card.oracleId, scryfallId: shownId(card, printing), condition: 'NM', finish: 'nonfoil', lang: 'en', quantityForTrade: 1 });
    toast(`Added ${card.name} to tradelist`);
  }
  async function quickDeck(card: OracleCard, deckId: string, board: DeckBoard, noun = 'deck', printing?: Printing) {
    // A basic land in a deck defaults to "any printing" — whatever's on top of
    // the lands box. Binders and boxes hold real cardboard, so they don't.
    const anyBasic = containerMeta.kind === 'deck' && isBasicLand(card);
    // The printing the result is showing, like the collection quick-adds: tap +
    // on an edition tile and that edition is what lands in the container.
    await addDeckCard({ deckId, oracleId: card.oracleId, board, anyBasic, scryfallId: shownId(card, printing) });
    const suffix = board === 'side' ? ' (sideboard)' : board === 'commander' ? ' (commander)' : '';
    toast(`Added ${card.name}${suffix} to ${noun}${anyBasic ? ' (any printing)' : ''}`);
  }

  function actionsFor(card: Priced<OracleCard>, printing?: Priced<Printing>): ReactNode {
    switch (target.kind) {
      case 'deck': {
        // Storage is one pile: a single quick-add, no board buttons.
        if (containerMeta.kind !== 'deck') {
          return (
            <button
              title={`Add to ${containerMeta.noun}`}
              onClick={() => quickDeck(card, target.deckId, 'main', containerMeta.noun, printing)}
            >
              +<Icon name={containerMeta.icon} size={16} />
            </button>
          );
        }
        return (
          <>
            <button title="Add to mainboard" onClick={() => quickDeck(card, target.deckId, 'main', 'deck', printing)}>
              +Main
            </button>
            <button title="Add to sideboard" onClick={() => quickDeck(card, target.deckId, 'side', 'deck', printing)}>
              +SB
            </button>
            {deckCtx?.format === 'commander' && (
              <button title="Add as commander" onClick={() => quickDeck(card, target.deckId, 'commander', 'deck', printing)}>
                +Cmdr
              </button>
            )}
          </>
        );
      }
      case 'collection':
        return (
          <button title="Add to collection" onClick={() => quickCollection(card, printing)}>
            +<Icon name="collection" size={16} />
          </button>
        );
      case 'wishlist':
        return (
          <button title="Add to wishlist" onClick={() => quickWishlist(card)}>
            +<Icon name="wishlist" size={16} />
          </button>
        );
      case 'tradelist':
        return (
          <button title="Add to tradelist" onClick={() => quickTradelist(card, printing)}>
            +<Icon name="tradelist" size={16} />
          </button>
        );
      default:
        return (
          <>
            <button title="Add to collection" onClick={() => quickCollection(card, printing)}>
              +<Icon name="collection" size={16} />
            </button>
            <button title="Add to wishlist" onClick={() => quickWishlist(card)}>
              +<Icon name="wishlist" size={16} />
            </button>
            <button title="Add to tradelist" onClick={() => quickTradelist(card, printing)}>
              +<Icon name="tradelist" size={16} />
            </button>
          </>
        );
    }
  }

  const targetHint = {
    deck:
      containerMeta.kind === 'deck'
        ? 'Adding a result puts it in this deck (main or sideboard).'
        : `Adding a result files it in this ${containerMeta.noun}.`,
    collection: 'Adding a result puts it in your collection.',
    wishlist: 'Adding a result puts it on your wishlist.',
    tradelist: 'Adding a result puts it in your collection, marked for trade.',
    default: null,
  }[target.kind];

  const filterExtras = deckCtx && deckCtx.format !== 'casual' && (
    <label className="deck-filter-toggle" title="Hide cards this deck can't legally play">
      <input type="checkbox" checked={deckLegalOnly} onChange={(e) => setDeckLegalOnly(e.target.checked)} />
      {formatLabel(deckCtx.format)}-legal
      {deckCtx.identity && ` · ${deckCtx.identity.length ? deckCtx.identity.join('') : 'C'} identity`}
    </label>
  );

  // Nothing typed yet: the recent searches are the offer, with the usual hint
  // under them. Picking one just fills the query — results update live, and the
  // keyboard stays down so it doesn't cover them.
  const emptyState = (
    <>
      <RecentSearches onPick={setQuery} />
      <p className="search-meta">
        Type a card name to search the whole card database.{targetHint && ` ${targetHint}`}
      </p>
    </>
  );

  return (
    <div className="search-overlay">
      <div className="search-overlay-inner">
        {chips}

        {scoped ? (
          <>
            {/* An empty scoped query lists everything in scope, so there's no
                empty state to hang these off — they go above the list. */}
            {!query && <RecentSearches onPick={setQuery} />}
            {scope && scope !== 'movers' && <ScopedResults scope={scope} query={query} />}
            {containerOn && target.kind === 'deck' && (
              <ContainerScopedResults deckId={target.deckId} kind={containerMeta.kind} format={deckCtx?.format} query={query} />
            )}
            {profileActive && profile && session && (
              <ProfileScopedResults
                token={session.token}
                username={profile.username}
                query={query}
                showTrade={profileTradeOn}
                showWish={profileWishOn}
              />
            )}
          </>
        ) : (
          <CardSearchView
            query={query}
            filters={filters}
            setFilters={setFilters}
            effectiveFilters={effectiveFilters}
            filterExtras={filterExtras}
            showFilters={false}
            emptyState={emptyState}
            badgeFor={(card, printing) => ownedBadge(ownership?.lookup(card.oracleId, shownId(card, printing)))}
            actionsFor={actionsFor}
            listOnlyActions
            selection={{ sel, onKeys: setResultKeys }}
            onCardClick={(card, printing) => setSheetCard({ card, scryfallId: printing?.scryfallId })}
          />
        )}

        {sel.active && (
          <BulkActionBar
            count={sel.count}
            allSelected={resultKeys.length > 0 && resultKeys.every((k) => sel.selected.has(k))}
            onToggleAll={() => sel.toggleAll(resultKeys)}
            onCancel={sel.exit}
            actions={[{ label: 'Add to wishlist', icon: 'wishlist', onClick: () => void bulkWish() }]}
          />
        )}

        {sheetCard && (
          <CardSheet
            oracleCard={sheetCard.card}
            initialScryfallId={sheetCard.scryfallId}
            addTarget={target.kind === 'deck' ? { ...target, format: deckCtx?.format } : target}
            onClose={() => setSheetCard(null)}
          />
        )}
      </div>
    </div>
  );
}
