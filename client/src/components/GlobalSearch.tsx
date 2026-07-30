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
import { matchPath, useLocation } from 'react-router-dom';
import { CONTAINER_KINDS, type Color, type DeckBoard, type DeckFormat, type OracleCard, type Priced, type Printing } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { addDeckCard, addToCollection, addToWishlist } from '../db/dataAccess.js';
import { formatLabel } from '../deck/legality.js';
import { CONTAINER_META } from '../deck/containers.js';
import { CardSheet, type AddTarget } from './CardSheet.js';
import { CardSearchView } from './CardSearchView.js';
import { ScopedResults, type Scope } from './ScopedResults.js';
import { ProfileScopedResults } from './ProfileScopedResults.js';
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
  if (pathname === '/' || pathname === '/collection') return { kind: 'collection' };
  if (pathname === '/wishlist') return { kind: 'wishlist' };
  if (pathname === '/tradelist') return { kind: 'tradelist' };
  return { kind: 'default' };
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

// Scope chips let the search look inside what you already own (or, on a
// community page, what the person you're browsing has listed) instead of the
// whole database. `profileTrade`/`profileWish` target the viewed profile.
type PillKey = Scope | 'profileTrade' | 'profileWish';
const SCOPES: { key: Scope; label: string; icon: IconName }[] = [
  { key: 'collection', label: 'Collection', icon: 'collection' },
  { key: 'tradelist', label: 'Tradelist', icon: 'tradelist' },
  { key: 'wishlist', label: 'Wishlist', icon: 'wishlist' },
];
const isLocalScope = (k: PillKey): k is Scope => k === 'collection' || k === 'tradelist' || k === 'wishlist';
// Pre-pick a scope for the list you opened search from: your own list pages
// pick the matching pill; another user's community page picks both of theirs
// (that's what you're looking at and most likely want to search).
function seedScopes(kind: AddTarget['kind'], profile: boolean): Set<PillKey> {
  if (profile) return new Set<PillKey>(['profileTrade', 'profileWish']);
  return kind === 'collection' || kind === 'wishlist' || kind === 'tradelist' ? new Set<PillKey>([kind]) : new Set();
}

interface SearchCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const Ctx = createContext<SearchCtx | null>(null);

/** Open (and focus) the global search from anywhere, e.g. "＋ Add cards" buttons. */
export function useOpenSearch(): () => void {
  const ctx = useContext(Ctx);
  return () => {
    ctx?.setOpen(true);
    ctx?.inputRef.current?.focus();
  };
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const value = useMemo(() => ({ open, setOpen, inputRef }), [open]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The header search bar + results overlay. Render once, inside the provider. */
export function GlobalSearchBar() {
  const ctx = useContext(Ctx)!;
  const { open, setOpen, inputRef } = ctx;
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  const location = useLocation();
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

  // Navigating away (tab bar stays tappable under the overlay) closes search.
  const path = location.pathname;
  const prevPath = useRef(path);
  useEffect(() => {
    if (prevPath.current !== path) {
      prevPath.current = path;
      // Clear the query/filters too (same as close()), so reopening search
      // after navigating away doesn't resurrect the old query and filters.
      setQuery('');
      setFilters({});
      setOpen(false);
      inputRef.current?.blur();
    }
  }, [path, setOpen, inputRef]);

  function close() {
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
          // so it stops covering them. The overlay stays open.
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          enterKeyHint="search"
          aria-label="Search cards"
        />
        {open ? (
          <button className="header-close" onClick={close} aria-label="Close search">
            ✕
          </button>
        ) : (
          accountsEnabled && (
            <>
              {signedIn && <NotificationBell />}
              <AccountMenu
                signedIn={signedIn}
                username={session?.username}
                ownAvatar={ownAvatar}
                syncTone={syncTone}
                syncLabel={syncLabel}
              />
            </>
          )
        )}
      </header>
      {open && <SearchOverlay query={query} filters={filters} setFilters={setFilters} />}
    </>
  );
}

function SearchOverlay({
  query,
  filters,
  setFilters,
}: {
  query: string;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
}) {
  // The sheet opens on the printing the result was showing, so tapping a tile
  // doesn't silently swap to a different edition than the one you tapped.
  const [sheetCard, setSheetCard] = useState<{ card: Priced<OracleCard>; scryfallId?: string } | null>(null);
  const [deckLegalOnly, setDeckLegalOnly] = useState(true);
  const toast = useToast();
  const target = useSearchTarget();
  const { session } = useAccount();
  const profile = useProfileScope(session?.username);
  const [scopes, setScopes] = useState<Set<PillKey>>(() => seedScopes(target.kind, !!profile));
  const toggleScope = (key: PillKey) =>
    setScopes((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const ownership = useOwnershipIndex();

  // The full set of pills for this context: your own three everywhere, plus the
  // viewed user's two on their community page.
  const pills: { key: PillKey; label: string; icon: IconName; title: string }[] = [
    ...SCOPES.map((s) => ({ ...s, title: `Search your ${s.label.toLowerCase()}` })),
    ...(profile
      ? ([
          { key: 'profileTrade', label: `${profile.username}’s tradelist`, icon: 'tradelist', title: `Search ${profile.username}’s tradelist` },
          { key: 'profileWish', label: `${profile.username}’s wishlist`, icon: 'wishlist', title: `Search ${profile.username}’s wishlist` },
        ] as const)
      : []),
  ];

  const localScopes = new Set<Scope>([...scopes].filter(isLocalScope));
  const profileTradeOn = scopes.has('profileTrade');
  const profileWishOn = scopes.has('profileWish');
  const profileActive = !!profile && !!session && (profileTradeOn || profileWishOn);
  const scoped = localScopes.size > 0 || profileActive;

  // Wording for the container being searched from (a deck, binder or box).
  const containerMeta = CONTAINER_META[(target.kind === 'deck' && target.containerKind) || 'deck'];

  // Searching from a deck filters to cards you could actually play there: legal
  // in the deck's format and, for Commander, within the commander's identity.
  const deckId = target.kind === 'deck' ? target.deckId : undefined;
  const deckCtx = useLiveQuery(async () => {
    if (!deckId) return null;
    const deck = await db.decks.get(deckId);
    if (!deck) return null;
    const format: DeckFormat = deck.format ?? 'casual';
    let identity: Color[] | null = null;
    if (format === 'commander') {
      const commanders = await db.deckCards.where('[deckId+board]').equals([deckId, 'commander']).toArray();
      if (commanders.length) {
        const oracles = await db.oracleCards.bulkGet(commanders.map((c) => c.oracleId));
        identity = [...new Set(oracles.filter(Boolean).flatMap((o) => o!.colorIdentity))];
      }
    }
    return { format, identity };
  }, [deckId]);
  const deckFilterActive = deckLegalOnly && !!deckCtx && deckCtx.format !== 'casual';

  const effectiveFilters = useMemo<SearchFilters>(
    () =>
      deckFilterActive
        ? { ...filters, legalIn: deckCtx!.format, identity: deckCtx!.identity ?? undefined }
        : filters,
    [filters, deckFilterActive, deckCtx],
  );

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
  async function quickDeck(card: OracleCard, deckId: string, board: DeckBoard, noun = 'deck') {
    await addDeckCard({ deckId, oracleId: card.oracleId, board });
    const suffix = board === 'side' ? ' (sideboard)' : board === 'commander' ? ' (commander)' : '';
    toast(`Added ${card.name}${suffix} to ${noun}`);
  }

  function actionsFor(card: Priced<OracleCard>, printing?: Priced<Printing>): ReactNode {
    switch (target.kind) {
      case 'deck': {
        // Storage is one pile: a single quick-add, no board buttons.
        if (containerMeta.kind !== 'deck') {
          return (
            <button
              title={`Add to ${containerMeta.noun}`}
              onClick={() => quickDeck(card, target.deckId, 'main', containerMeta.noun)}
            >
              +<Icon name={containerMeta.icon} size={16} />
            </button>
          );
        }
        return (
          <>
            <button title="Add to mainboard" onClick={() => quickDeck(card, target.deckId, 'main')}>
              +Main
            </button>
            <button title="Add to sideboard" onClick={() => quickDeck(card, target.deckId, 'side')}>
              +SB
            </button>
            {deckCtx?.format === 'commander' && (
              <button title="Add as commander" onClick={() => quickDeck(card, target.deckId, 'commander')}>
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

  const emptyState = (
    <p className="search-meta">
      Type a card name to search the whole card database.{targetHint && ` ${targetHint}`}
    </p>
  );

  return (
    <div className="search-overlay">
      <div className="search-overlay-inner">
        <div className="scope-chips" role="group" aria-label="Search within">
          {pills.map((s) => (
            <button
              key={s.key}
              className="chip"
              aria-pressed={scopes.has(s.key)}
              onClick={() => toggleScope(s.key)}
              title={s.title}
            >
              <Icon name={s.icon} size={14} /> {s.label}
            </button>
          ))}
        </div>

        {scoped ? (
          <>
            {localScopes.size > 0 && <ScopedResults scopes={localScopes} query={query} />}
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
            onCardClick={(card, printing) => setSheetCard({ card, scryfallId: printing?.scryfallId })}
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
