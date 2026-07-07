import { useEffect, useMemo, useState } from 'react';
import type { OracleCard, Rarity } from '@mtg/shared';
import { Page } from './Page.js';
import { searchCards, type SearchFilters } from '../cardDb/search.js';

const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic'];
const COLORS = [
  { value: 'W', label: 'White' },
  { value: 'U', label: 'Blue' },
  { value: 'B', label: 'Black' },
  { value: 'R', label: 'Red' },
  { value: 'G', label: 'Green' },
] as const;
const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land'];

function price(card: OracleCard): string {
  if (card.priceEur != null) return `€${card.priceEur.toFixed(2)}`;
  if (card.priceUsd != null) return `$${card.priceUsd.toFixed(2)}`;
  return '—';
}

export function Search() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [results, setResults] = useState<OracleCard[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  const hasCriteria = query.trim().length > 0 || !!filters.color || !!filters.rarity || !!filters.type;

  // Debounced search. searchCards is in-memory after the first call, so this is
  // fast; the debounce just avoids re-running on every keystroke.
  useEffect(() => {
    if (!hasCriteria) {
      setResults([]);
      setTotal(0);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const res = await searchCards(query, filters);
      setResults(res.cards);
      setTotal(res.total);
      setSearching(false);
    }, 120);
    return () => clearTimeout(handle);
  }, [query, filters, hasCriteria]);

  const setFilter = useMemo(
    () => (key: keyof SearchFilters, value: string) =>
      setFilters((f) => ({ ...f, [key]: value || undefined })),
    [],
  );

  return (
    <Page title="Search" subtitle="Find cards to add to your collection, wishlist, or tradelist.">
      <input
        className="search-input"
        type="search"
        placeholder="Search cards… (try “bolt”)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search cards"
        autoFocus
      />

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
      </div>

      {hasCriteria && (
        <p className="search-meta">
          {searching ? 'Searching…' : `${total} result${total === 1 ? '' : 's'}${total > results.length ? ` (showing ${results.length})` : ''}`}
        </p>
      )}

      <ul className="result-list">
        {results.map((card) => (
          <li key={card.oracleId} className="result-row">
            {card.imageSmall ? (
              <img className="result-thumb" src={card.imageSmall} alt="" loading="lazy" width={46} height={64} />
            ) : (
              <div className="result-thumb" aria-hidden />
            )}
            <div className="result-main">
              <div className="result-name">{card.name}</div>
              <div className="result-sub">
                <span className={`rarity-dot rarity-${card.rarity}`} aria-hidden />
                {card.typeLine}
              </div>
            </div>
            <div className="result-price">{price(card)}</div>
          </li>
        ))}
      </ul>
    </Page>
  );
}
