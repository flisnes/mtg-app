import { useEffect, useMemo, type ReactNode } from 'react';
import type { OracleCard, Priced, Printing, Rarity } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { useCardSearch } from '../cardDb/useCardSearch.js';
import { useDisplayPrintings } from '../cardDb/useDisplayPrintings.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { SortControls, formatPrice, useCardSort } from './CardSorting.js';
import type { MultiSelect } from './useMultiSelect.js';
import { SelectToggle } from './SelectToggle.js';

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
  showFilters = true,
  sortKey,
  emptyState,
  badgeFor,
  actionsFor,
  listOnlyActions = false,
  selection,
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
  /** Show the color/type/rarity dropdowns. `filterExtras` still renders when off. */
  showFilters?: boolean;
  /**
   * Offer the sort controls, persisting under `cardSort:<sortKey>`. Omit in
   * pickers where the point is to find one named card and best-match is the
   * only order that helps.
   */
  sortKey?: string;
  /** Shown in place of results when there's nothing to search for yet. */
  emptyState: ReactNode;
  badgeFor?: (card: Priced<OracleCard>, printing?: Priced<Printing>) => ResultBadge | null;
  /** Per-result quick action (e.g. a ＋). Omit entirely to keep results clean
   *  and let the card sheet (opened by tapping a tile) carry the add action. */
  actionsFor?: (card: Priced<OracleCard>, printing?: Priced<Printing>) => ReactNode;
  /** Show quick actions only in list view; grid tiles stay clean and the card
   *  sheet (opened by tapping a tile) carries the add actions instead. */
  listOnlyActions?: boolean;
  /**
   * Multi-select over the results, keyed by oracleId. Supplied by the caller so
   * it owns both the state and the bulk bar — search results are cards, not
   * copies you own, so what a selection of them can do is the caller's call.
   * `onKeys` reports every result currently listed, for "select all".
   */
  selection?: { sel: MultiSelect; onKeys: (keys: string[]) => void };
  onCardClick: (card: Priced<OracleCard>, printing?: Priced<Printing>) => void;
}) {
  const [view, setView] = useViewMode();
  // Best match is the only order the database can rank by itself, so it's the
  // default; the rest are the same keys every owned list sorts by. The hook
  // runs either way — an unsorted caller just never shows or sends the prefs.
  const [sort, setSort] = useCardSort(sortKey ?? 'search', { key: 'relevance', dir: 'desc' });
  const eff = effectiveFilters ?? filters;
  const hasCriteria =
    query.trim().length > 0 || (showFilters && (!!filters.color || !!filters.rarity || !!filters.type));

  // New criteria start back at the first page — keyed on a serialized signature
  // so opening/closing a card sheet over the results doesn't reset the count.
  // The debounce in useCardSearch swallows the extra run so only one search fires.
  // Reordering starts over at page one too: "cheapest first" sorts the whole
  // match set, so page three of the old order says nothing about the new one.
  const { limit, showMore } = usePagedLimit(`${query}|${JSON.stringify(eff)}|${sortKey ? `${sort.key}:${sort.dir}` : ''}`, PAGE_SIZE);

  const searchSort = useMemo(() => ({ key: sort.key, dir: sort.dir }), [sort.key, sort.dir]);
  const { results, total, searching } = useCardSearch(query, {
    filters: eff,
    limit,
    sort: sortKey ? searchSort : undefined,
    enabled: hasCriteria,
  });
  // Which printing each result should appear as. Empty (and free) unless the
  // user has moved off the default "latest printing" preference.
  const shown = useDisplayPrintings(results);

  const setFilter = (key: keyof SearchFilters, value: string) =>
    setFilters((f) => ({ ...f, [key]: value || undefined }));

  // Keep the caller's "select all" pointed at what's actually listed, which
  // changes as you type and as you page.
  const onKeys = selection?.onKeys;
  const resultKeys = results.map((c) => c.oracleId).join('|');
  useEffect(() => {
    onKeys?.(resultKeys ? resultKeys.split('|') : []);
  }, [onKeys, resultKeys]);

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

      {(showFilters || filterExtras) && (
        <div className="filter-row">
          {showFilters && (
            <>
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
            </>
          )}
          {filterExtras}
        </div>
      )}

      {hasCriteria ? (
        <>
          <div className="meta-row">
            <p className="search-meta">
              {searching
                ? 'Searching…'
                : `${total} result${total === 1 ? '' : 's'}${total > results.length ? ` (showing ${results.length})` : ''}`}
            </p>
            <div className="meta-actions">
              {selection && !selection.sel.active && results.length > 0 && (
                <SelectToggle onEnter={selection.sel.enter} />
              )}
              {sortKey && <SortControls prefs={sort} onChange={setSort} withRelevance />}
              <ViewToggle mode={view} onChange={setView} />
            </div>
          </div>

          <CardItems
            view={view}
            selectable={selection?.sel.active}
            selectedKeys={selection?.sel.selected}
            onToggleSelect={selection?.sel.toggle}
            items={results.map((card): CardItem => {
              const printing = shown.get(card.oracleId);
              const b = badgeFor?.(card, printing);
              return {
                key: card.oracleId,
                name: card.name,
                image: printing?.imageSmall ?? card.imageSmall ?? null,
                mana: card.manaCost,
                badge: b?.icon,
                badgeClass: b?.cls,
                badgeTitle: b?.title,
                sub: (
                  <>
                    <span className={`rarity-dot rarity-${card.rarity}`} aria-hidden />
                    {printing ? `${printing.setName} · ` : ''}
                    {card.typeLine}
                  </>
                ),
                // The chosen printing's own price, not the representative one's.
                price: formatPrice(printing, card) ?? '—',
                onClick: () => onCardClick(card, printing),
                actions:
                  !actionsFor || (listOnlyActions && view === 'grid') ? undefined : actionsFor(card, printing),
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
