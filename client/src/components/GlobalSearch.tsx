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
import type { Color, DeckBoard, DeckFormat, OracleCard, Priced, Rarity } from '@mtg/shared';
import { searchCards, type SearchFilters } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { addDeckCard, addToCollection, addToWishlist } from '../db/dataAccess.js';
import { formatLabel } from '../deck/legality.js';
import { CardSheet, type AddTarget } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { useToast } from './Toast.js';
import { Icon } from './icons.js';

// Card search is the front door to the hobby, so it lives in a persistent
// header instead of a tab: the input is reachable from every screen, and
// focusing it opens a full results overlay (filters, quick-adds, card sheet).
// Esc, ✕, or navigating to another tab closes the overlay.

const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic'];
const COLORS = [
  { value: 'W', label: 'White' },
  { value: 'U', label: 'Blue' },
  { value: 'B', label: 'Black' },
  { value: 'R', label: 'Red' },
  { value: 'G', label: 'Green' },
] as const;
const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land'];
const PAGE_SIZE = 60;

// What the quick-action buttons on each result do depends on where the user
// searched from: the deck editor adds to that deck, the collection adds to the
// collection, and so on. Everywhere else offers the generic trio.
type SearchTarget = AddTarget | { kind: 'default' };

function useSearchTarget(): SearchTarget {
  const { pathname } = useLocation();
  const deckId = matchPath('/decks/:id', pathname)?.params.id;
  if (deckId) return { kind: 'deck', deckId };
  if (pathname === '/' || pathname === '/collection') return { kind: 'collection' };
  if (pathname === '/wishlist') return { kind: 'wishlist' };
  if (pathname === '/tradelist') return { kind: 'tradelist' };
  return { kind: 'default' };
}

function price(card: Priced<OracleCard>): string {
  if (card.priceEur != null) return `€${card.priceEur.toFixed(2)}`;
  if (card.priceUsd != null) return `$${card.priceUsd.toFixed(2)}`;
  return '—';
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
          aria-label="Search cards"
        />
        {open && (
          <button className="header-close" onClick={close} aria-label="Close search">
            ✕
          </button>
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
  const [results, setResults] = useState<Priced<OracleCard>[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [searching, setSearching] = useState(false);
  const [sheetCard, setSheetCard] = useState<Priced<OracleCard> | null>(null);
  const [view, setView] = useViewMode();
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

  const hasCriteria = query.trim().length > 0 || !!filters.color || !!filters.rarity || !!filters.type;

  // New criteria start back at the first page. The debounce below swallows the
  // extra effect run this triggers, so only one search fires.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query, filters, deckFilterActive, deckCtx]);

  useEffect(() => {
    if (!hasCriteria) {
      setResults([]);
      setTotal(0);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const effective: SearchFilters = deckFilterActive
        ? { ...filters, legalIn: deckCtx!.format, identity: deckCtx!.identity ?? undefined }
        : filters;
      const res = await searchCards(query, effective, limit);
      setResults(res.cards);
      setTotal(res.total);
      setSearching(false);
    }, 120);
    return () => clearTimeout(handle);
  }, [query, filters, hasCriteria, deckFilterActive, deckCtx, limit]);

  const setFilter = (key: keyof SearchFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value || undefined }));

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
    deck: 'Results add straight into this deck (main or sideboard).',
    collection: 'Results add straight into your collection.',
    wishlist: 'Results add straight onto your wishlist.',
    tradelist: 'Results add to your collection, marked for trade.',
    default: null,
  }[target.kind];

  return (
    <div className="search-overlay">
      <div className="search-overlay-inner">
        <div className="filter-row">
          <select value={filters.color ?? ''} onChange={(e) => setFilter('color', e.target.value)} aria-label="Color">
            <option value="">Any color</option>
            {COLORS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={filters.type ?? ''} onChange={(e) => setFilter('type', e.target.value)} aria-label="Type">
            <option value="">Any type</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select value={filters.rarity ?? ''} onChange={(e) => setFilter('rarity', e.target.value)} aria-label="Rarity">
            <option value="">Any rarity</option>
            {RARITIES.map((r) => (
              <option key={r} value={r}>
                {r[0]!.toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
          {deckCtx && deckCtx.format !== 'casual' && (
            <label className="deck-filter-toggle" title="Hide cards this deck can't legally play">
              <input type="checkbox" checked={deckLegalOnly} onChange={(e) => setDeckLegalOnly(e.target.checked)} />
              {formatLabel(deckCtx.format)}-legal
              {deckCtx.identity && ` · ${deckCtx.identity.length ? deckCtx.identity.join('') : 'C'} identity`}
            </label>
          )}
        </div>

        {hasCriteria ? (
          <div className="meta-row">
            <p className="search-meta">
              {searching
                ? 'Searching…'
                : `${total} result${total === 1 ? '' : 's'}${total > results.length ? ` (showing ${results.length})` : ''}`}
            </p>
            <ViewToggle mode={view} onChange={setView} />
          </div>
        ) : (
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
        )}

        <CardItems
          view={view}
          items={results.map(
            (card): CardItem => ({
              key: card.oracleId,
              name: card.name,
              image: card.imageSmall ?? null,
              sub: (
                <>
                  <span className={`rarity-dot rarity-${card.rarity}`} aria-hidden />
                  {card.typeLine}
                </>
              ),
              price: price(card),
              onClick: () => setSheetCard(card),
              actions: actionsFor(card),
            }),
          )}
        />

        {total > results.length && (
          <button
            className="show-more"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
            disabled={searching}
          >
            {searching ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, total - results.length)} more`}
          </button>
        )}

        {sheetCard && (
          <CardSheet
            oracleCard={sheetCard}
            addTarget={
              target.kind === 'default'
                ? undefined
                : target.kind === 'deck'
                  ? { ...target, format: deckCtx?.format }
                  : target
            }
            onClose={() => setSheetCard(null)}
          />
        )}
      </div>
    </div>
  );
}
