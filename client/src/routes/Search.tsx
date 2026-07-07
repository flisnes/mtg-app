import { useEffect, useMemo, useState } from 'react';
import type { OracleCard, Rarity } from '@mtg/shared';
import { Page } from './Page.js';
import { searchCards, type SearchFilters } from '../cardDb/search.js';
import { addToCollection, addToWishlist } from '../db/dataAccess.js';
import { CardSheet } from '../components/CardSheet.js';
import { useToast } from '../components/Toast.js';

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
  const [sheetCard, setSheetCard] = useState<OracleCard | null>(null);
  const toast = useToast();

  const hasCriteria = query.trim().length > 0 || !!filters.color || !!filters.rarity || !!filters.type;

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
    () => (key: keyof SearchFilters, value: string) => setFilters((f) => ({ ...f, [key]: value || undefined })),
    [],
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
          {searching
            ? 'Searching…'
            : `${total} result${total === 1 ? '' : 's'}${total > results.length ? ` (showing ${results.length})` : ''}`}
        </p>
      )}

      <ul className="result-list">
        {results.map((card) => (
          <li key={card.oracleId} className="result-row">
            <button className="result-open" onClick={() => setSheetCard(card)} aria-label={`Edit ${card.name}`}>
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
            </button>
            <div className="quick-actions">
              <button title="Add to collection" onClick={() => quickCollection(card)}>
                +🗃️
              </button>
              <button title="Add to wishlist" onClick={() => quickWishlist(card)}>
                +⭐
              </button>
              <button title="Add to tradelist" onClick={() => quickTradelist(card)}>
                +🔁
              </button>
            </div>
          </li>
        ))}
      </ul>

      {sheetCard && <CardSheet oracleCard={sheetCard} onClose={() => setSheetCard(null)} />}
    </Page>
  );
}
