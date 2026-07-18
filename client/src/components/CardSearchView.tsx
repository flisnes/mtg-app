import { type ReactNode } from 'react';
import type { OracleCard, Priced, Rarity } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { useCardSearch } from '../cardDb/useCardSearch.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { formatPrice } from './CardSorting.js';

// The reusable body of the card-search experience: an optional search input,
// the color/type/rarity filter row, a result-count + list/grid toggle, the
// results themselves, and "show more" paging. The global header search and the
// trade card pickers both render this so search looks and behaves the same
// everywhere — the only differences (what a result's ＋ does, what indicator it
// carries, what shows before any query) are supplied by the caller.

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

/** A small corner indicator on each result (e.g. "do I own this?"). */
export interface ResultBadge {
  icon: ReactNode;
  cls?: string;
  title?: string;
}

export function CardSearchView({
  query,
  onQueryChange,
  inputPlaceholder,
  filters,
  setFilters,
  effectiveFilters,
  filterExtras,
  emptyState,
  badgeFor,
  actionsFor,
  onCardClick,
}: {
  query: string;
  /** Provide to render a search input inside the view (header search omits it). */
  onQueryChange?: (q: string) => void;
  inputPlaceholder?: string;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  /** Filters actually sent to the search (e.g. with deck legality folded in). Defaults to `filters`. */
  effectiveFilters?: SearchFilters;
  /** Extra controls appended to the filter row (e.g. a deck-legal toggle). */
  filterExtras?: ReactNode;
  /** Shown in place of results when there's nothing to search for yet. */
  emptyState: ReactNode;
  badgeFor?: (card: Priced<OracleCard>) => ResultBadge | null;
  actionsFor: (card: Priced<OracleCard>) => ReactNode;
  onCardClick: (card: Priced<OracleCard>) => void;
}) {
  const [view, setView] = useViewMode();
  const eff = effectiveFilters ?? filters;
  const hasCriteria = query.trim().length > 0 || !!filters.color || !!filters.rarity || !!filters.type;

  // New criteria start back at the first page — keyed on a serialized signature
  // so opening/closing a card sheet over the results doesn't reset the count.
  // The debounce in useCardSearch swallows the extra run so only one search fires.
  const { limit, showMore } = usePagedLimit(`${query}|${JSON.stringify(eff)}`, PAGE_SIZE);

  const { results, total, searching } = useCardSearch(query, { filters: eff, limit, enabled: hasCriteria });

  const setFilter = (key: keyof SearchFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value || undefined }));

  return (
    <>
      {onQueryChange && (
        <input
          className="search-input"
          type="search"
          placeholder={inputPlaceholder ?? 'Search cards…'}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          // Results update live; Enter just dismisses the (mobile) keyboard.
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          enterKeyHint="search"
          aria-label="Search cards"
        />
      )}

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
        {filterExtras}
      </div>

      {hasCriteria ? (
        <>
          <div className="meta-row">
            <p className="search-meta">
              {searching
                ? 'Searching…'
                : `${total} result${total === 1 ? '' : 's'}${total > results.length ? ` (showing ${results.length})` : ''}`}
            </p>
            <ViewToggle mode={view} onChange={setView} />
          </div>

          <CardItems
            view={view}
            items={results.map((card): CardItem => {
              const b = badgeFor?.(card);
              return {
                key: card.oracleId,
                name: card.name,
                image: card.imageSmall ?? null,
                badge: b?.icon,
                badgeClass: b?.cls,
                badgeTitle: b?.title,
                sub: (
                  <>
                    <span className={`rarity-dot rarity-${card.rarity}`} aria-hidden />
                    {card.typeLine}
                  </>
                ),
                price: formatPrice(card) ?? '—',
                onClick: () => onCardClick(card),
                actions: actionsFor(card),
              };
            })}
          />

          {total > results.length && (
            <button className="show-more" onClick={showMore} disabled={searching}>
              {searching ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, total - results.length)} more`}
            </button>
          )}
        </>
      ) : (
        emptyState
      )}
    </>
  );
}
