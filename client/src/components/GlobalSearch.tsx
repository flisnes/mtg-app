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
import type { Color, DeckBoard, DeckFormat, OracleCard, Priced } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { addDeckCard, addToCollection, addToWishlist } from '../db/dataAccess.js';
import { formatLabel } from '../deck/legality.js';
import { CardSheet, type AddTarget } from './CardSheet.js';
import { CardSearchView } from './CardSearchView.js';
import { useToast } from './Toast.js';
import { Icon } from './icons.js';
import { NotificationBell } from './NotificationBell.js';
import { useAccount } from '../account/useAccount.js';

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
  const deckId = matchPath('/decks/:id', pathname)?.params.id;
  if (deckId) return { kind: 'deck', deckId };
  if (pathname === '/' || pathname === '/collection') return { kind: 'collection' };
  if (pathname === '/wishlist') return { kind: 'wishlist' };
  if (pathname === '/tradelist') return { kind: 'tradelist' };
  return { kind: 'default' };
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
  const navigate = useNavigate();
  const { enabled: accountsEnabled, session, syncReady, pendingChanges, sync } = useAccount();
  const signedIn = !!session;

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
      setOpen(false);
      inputRef.current?.blur();
    }
  }, [path, setOpen, inputRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen, inputRef]);

  function close() {
    setQuery('');
    setFilters({});
    setOpen(false);
    inputRef.current?.blur();
  }

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
              <button
                className="header-account"
                onClick={() => navigate('/account')}
                aria-label={signedIn ? `Account: signed in as ${session!.username} (${syncLabel})` : 'Account & sync'}
                title={signedIn ? `Signed in as ${session!.username} — ${syncLabel}` : 'Account & sync'}
              >
                <Icon name="account" size={22} />
                {signedIn && <span className={`header-account-dot header-account-dot-${syncTone}`} aria-hidden />}
              </button>
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
  const [sheetCard, setSheetCard] = useState<Priced<OracleCard> | null>(null);
  const [deckLegalOnly, setDeckLegalOnly] = useState(true);
  const toast = useToast();
  const target = useSearchTarget();

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

  // Quick-add uses the default printing / NM / nonfoil / en; the sheet is for detail.
  async function quickCollection(card: OracleCard) {
    await addToCollection({ oracleId: card.oracleId, scryfallId: card.defaultScryfallId, condition: 'NM', finish: 'nonfoil', lang: 'en' });
    toast(`Added ${card.name} to collection`);
  }
  async function quickWishlist(card: OracleCard) {
    await addToWishlist({ oracleId: card.oracleId, scryfallId: null });
    toast(`Added ${card.name} to wishlist`);
  }
  async function quickTradelist(card: OracleCard) {
    await addToCollection({ oracleId: card.oracleId, scryfallId: card.defaultScryfallId, condition: 'NM', finish: 'nonfoil', lang: 'en', quantityForTrade: 1 });
    toast(`Added ${card.name} to tradelist`);
  }
  async function quickDeck(card: OracleCard, deckId: string, board: DeckBoard) {
    await addDeckCard({ deckId, oracleId: card.oracleId, board });
    const suffix = board === 'side' ? ' (sideboard)' : board === 'commander' ? ' (commander)' : '';
    toast(`Added ${card.name}${suffix} to deck`);
  }

  function actionsFor(card: Priced<OracleCard>): ReactNode {
    switch (target.kind) {
      case 'deck':
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
      case 'collection':
        return (
          <button title="Add to collection" onClick={() => quickCollection(card)}>
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
          <button title="Add to tradelist" onClick={() => quickTradelist(card)}>
            +<Icon name="tradelist" size={16} />
          </button>
        );
      default:
        return (
          <>
            <button title="Add to collection" onClick={() => quickCollection(card)}>
              +<Icon name="collection" size={16} />
            </button>
            <button title="Add to wishlist" onClick={() => quickWishlist(card)}>
              +<Icon name="wishlist" size={16} />
            </button>
            <button title="Add to tradelist" onClick={() => quickTradelist(card)}>
              +<Icon name="tradelist" size={16} />
            </button>
          </>
        );
    }
  }

  const targetHint = {
    deck: 'Adding a result puts it in this deck (main or sideboard).',
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
    <>
      <p className="search-meta">
        Type a card name, or pick a filter, to search the whole card database.
        {targetHint && ` ${targetHint}`}
      </p>
      <p className="search-meta search-syntax-hint">
        Scryfall syntax works too: <code>o:"whenever ~ enters"</code> <code>t:legendary</code> <code>c:ug</code>{' '}
        <code>id&lt;=bg</code> <code>mv&lt;=2</code> <code>r:mythic</code> <code>f:modern</code> — prefix{' '}
        <code>-</code> to negate.
      </p>
    </>
  );

  return (
    <div className="search-overlay">
      <div className="search-overlay-inner">
        <CardSearchView
          query={query}
          filters={filters}
          setFilters={setFilters}
          effectiveFilters={effectiveFilters}
          filterExtras={filterExtras}
          emptyState={emptyState}
          actionsFor={actionsFor}
          listOnlyActions
          onCardClick={setSheetCard}
        />

        {sheetCard && (
          <CardSheet
            oracleCard={sheetCard}
            addTarget={target.kind === 'deck' ? { ...target, format: deckCtx?.format } : target}
            onClose={() => setSheetCard(null)}
          />
        )}
      </div>
    </div>
  );
}
