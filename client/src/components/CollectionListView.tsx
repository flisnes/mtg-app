import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import type { CollectionEntry, Color, OracleCard, Printing, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { CardSheet } from './CardSheet.js';
import { CardGrid, ViewToggle, useViewMode, type GridItem } from './CardGrid.js';

export interface JoinedEntry {
  entry: CollectionEntry;
  oracle?: OracleCard;
  printing?: Printing;
}

const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic'];

/** Join collection entries with their card + printing display data. */
function useJoinedCollection(): JoinedEntry[] | undefined {
  return useLiveQuery(async () => {
    const entries = await db.collection.toArray();
    const [oracleMap, printMap] = await Promise.all([
      getOracleCardsByIds(entries.map((e) => e.oracleId)),
      getPrintingsByIds(entries.map((e) => e.scryfallId)),
    ]);
    return entries.map((entry) => ({
      entry,
      oracle: oracleMap.get(entry.oracleId),
      printing: printMap.get(entry.scryfallId),
    }));
  }, []);
}

function priceOf(p?: Printing, o?: OracleCard): string {
  const eur = p?.priceEur ?? o?.priceEur;
  const usd = p?.priceUsd ?? o?.priceUsd;
  if (eur != null) return `€${eur.toFixed(2)}`;
  if (usd != null) return `$${usd.toFixed(2)}`;
  return '—';
}

export function CollectionListView({ onlyTrade = false }: { onlyTrade?: boolean }) {
  const rows = useJoinedCollection();
  const [name, setName] = useState('');
  const [set, setSet] = useState('');
  const [color, setColor] = useState('');
  const [rarity, setRarity] = useState('');
  const [tradeOnly, setTradeOnly] = useState(onlyTrade);
  const [editing, setEditing] = useState<JoinedEntry | null>(null);
  const [view, setView] = useViewMode();

  const sets = useMemo(() => {
    const m = new Map<string, string>();
    rows?.forEach((r) => r.printing && m.set(r.printing.set, r.printing.setName));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = name.trim().toLowerCase();
    return rows
      .filter((r) => {
        if ((onlyTrade || tradeOnly) && r.entry.quantityForTrade <= 0) return false;
        if (q && !(r.oracle?.name.toLowerCase().includes(q) ?? false)) return false;
        if (set && r.printing?.set !== set) return false;
        if (color && !(r.oracle?.colorIdentity.includes(color as Color) ?? false)) return false;
        if (rarity && r.oracle?.rarity !== rarity) return false;
        return true;
      })
      .sort((a, b) => (a.oracle?.name ?? '').localeCompare(b.oracle?.name ?? ''));
  }, [rows, name, set, color, rarity, tradeOnly, onlyTrade]);

  const totalQty = filtered.reduce((s, r) => s + r.entry.quantity, 0);

  if (rows === undefined) return <p className="search-meta">Loading…</p>;

  return (
    <>
      <div className="list-toolbar">
        <input
          className="search-input grow"
          type="search"
          placeholder="Filter by name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Filter by name"
        />
      </div>
      <div className="filter-row">
        <select value={set} onChange={(e) => setSet(e.target.value)} aria-label="Set">
          <option value="">Any set</option>
          {sets.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <select value={color} onChange={(e) => setColor(e.target.value)} aria-label="Color">
          <option value="">Any color</option>
          {COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={rarity} onChange={(e) => setRarity(e.target.value)} aria-label="Rarity">
          <option value="">Any rarity</option>
          {RARITIES.map((r) => (
            <option key={r} value={r}>
              {r[0]!.toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {!onlyTrade && (
        <label className="chip" style={{ alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} /> On tradelist only
        </label>
      )}

      <div className="meta-row">
        <p className="search-meta">
          {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'} · {totalQty} card{totalQty === 1 ? '' : 's'}
        </p>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p>Nothing here yet.</p>
          <p className="empty-phase">
            <Link to="/">Search for cards</Link> to add some.
          </p>
        </div>
      ) : view === 'grid' ? (
        <CardGrid
          items={filtered.map(
            (r): GridItem => ({
              key: r.entry.id,
              name: r.oracle?.name ?? '(unknown card)',
              image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
              count: r.entry.quantity,
              badge: r.entry.quantityForTrade > 0 ? `${r.entry.quantityForTrade} FT` : undefined,
              badgeClass: 'badge-trade',
              onClick: () => setEditing(r),
            }),
          )}
        />
      ) : (
        <ul className="result-list">
          {filtered.map((r) => (
            <li key={r.entry.id} className="result-row">
              <button className="result-open" onClick={() => setEditing(r)} aria-label={`Edit ${r.oracle?.name ?? 'card'}`}>
                {r.printing?.imageSmall ?? r.oracle?.imageSmall ? (
                  <img className="result-thumb" src={r.printing?.imageSmall ?? r.oracle?.imageSmall ?? ''} alt="" loading="lazy" width={46} height={64} />
                ) : (
                  <div className="result-thumb" aria-hidden />
                )}
                <div className="result-main">
                  <div className="result-name">
                    {r.oracle?.name ?? '(unknown card)'}
                    {r.entry.quantityForTrade > 0 && <span className="badge badge-trade">{r.entry.quantityForTrade} for trade</span>}
                  </div>
                  <div className="result-sub">
                    {r.printing ? `${r.printing.setName} · #${r.printing.collectorNumber}` : ''} · {r.entry.condition} · {r.entry.finish}
                    {r.entry.lang !== 'en' ? ` · ${r.entry.lang}` : ''}
                  </div>
                </div>
                <div className="result-price">{priceOf(r.printing, r.oracle)}</div>
                <div className="qty-pill">×{r.entry.quantity}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing?.oracle && <CardSheet oracleCard={editing.oracle} entry={editing.entry} onClose={() => setEditing(null)} />}
    </>
  );
}
