import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Color, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { joinCollectionEntries, type JoinedEntry } from '../db/queries.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { PileView, CardBackSheet, type PileEntry } from './PileView.js';
import { SortControls, formatPrice, priceValue, sortCards, useCardSort } from './CardSorting.js';
import { historyChange } from '../price/history.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useGoblinMode } from './useGoblinMode.js';
import { useOpenSearch } from './GlobalSearch.js';

const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic'];

/** Join collection entries with their card + printing display data. */
function useJoinedCollection(): JoinedEntry[] | undefined {
  return useLiveQuery(async () => joinCollectionEntries(await db.collection.toArray()), []);
}

export function CollectionListView({ onlyTrade = false }: { onlyTrade?: boolean }) {
  const rows = useJoinedCollection();
  const [name, setName] = useState('');
  const [set, setSet] = useState('');
  const [color, setColor] = useState('');
  const [rarity, setRarity] = useState('');
  const [tradeOnly, setTradeOnly] = useState(onlyTrade);
  const [editing, setEditing] = useState<JoinedEntry | null>(null);
  // Pile view is goblin-mode only and never offered on the tradelist screen.
  const goblin = useGoblinMode();
  const allowPile = goblin && !onlyTrade;
  const [view, setView] = useViewMode(allowPile);
  const pileMode = view === 'pile' && allowPile;
  const [info, setInfo] = useState<JoinedEntry | null>(null);
  const [cardBack, setCardBack] = useState(false);
  const [sort, setSort] = useCardSort(onlyTrade ? 'tradelist' : 'collection');
  const openSearch = useOpenSearch();
  const moverFlags = useMoverFlags();

  // scryfallId → recorded price change; only loaded while a change sort is
  // active (the histories table is the biggest user-data table).
  const needChanges = sort.key === 'change' || sort.key === 'changePct';
  const changes = useLiveQuery(async () => {
    if (!needChanges) return undefined;
    const m = new Map<string, { delta: number; pct: number | null }>();
    for (const h of await db.priceHistories.toArray()) {
      const c = historyChange(h);
      if (c) m.set(h.scryfallId, { delta: c.delta, pct: c.pct });
    }
    return m;
  }, [needChanges]);

  const sets = useMemo(() => {
    const m = new Map<string, string>();
    rows?.forEach((r) => r.printing && m.set(r.printing.set, r.printing.setName));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = name.trim().toLowerCase();
    const matching = rows.filter((r) => {
      if ((onlyTrade || tradeOnly) && r.entry.quantityForTrade <= 0) return false;
      if (q && !(r.oracle?.name.toLowerCase().includes(q) ?? false)) return false;
      if (set && r.printing?.set !== set) return false;
      if (color && !(r.oracle?.colorIdentity.includes(color as Color) ?? false)) return false;
      if (rarity && r.oracle?.rarity !== rarity) return false;
      return true;
    });
    return sortCards(
      matching,
      (r) => ({
        name: r.oracle?.name,
        cmc: r.oracle?.cmc,
        price: priceValue(r.printing, r.oracle),
        change: changes?.get(r.entry.scryfallId)?.delta ?? null,
        changePct: changes?.get(r.entry.scryfallId)?.pct ?? null,
      }),
      sort,
    );
  }, [rows, name, set, color, rarity, tradeOnly, onlyTrade, sort, changes]);

  const totalQty = filtered.reduce((s, r) => s + r.entry.quantity, 0);

  if (rows === undefined) return <p className="search-meta">Loading…</p>;

  const emptyState = (
    <div className="empty-state">
      <p>Nothing here yet.</p>
      <p className="empty-phase">
        <button className="linklike" onClick={openSearch}>
          Search for cards
        </button>{' '}
        to add some.
      </p>
    </div>
  );

  return (
    <>
      {!pileMode && (
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
              <input type="checkbox" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} /> On tradelist
              only
            </label>
          )}
        </>
      )}

      <div className="meta-row">
        <p className="search-meta">
          {pileMode ? rows.length : filtered.length} entr{(pileMode ? rows.length : filtered.length) === 1 ? 'y' : 'ies'} ·{' '}
          {pileMode ? rows.reduce((s, r) => s + r.entry.quantity, 0) : totalQty} card
          {(pileMode ? rows.reduce((s, r) => s + r.entry.quantity, 0) : totalQty) === 1 ? '' : 's'}
        </p>
        <div className="meta-actions">
          {!pileMode && <SortControls prefs={sort} onChange={setSort} withChange />}
          <ViewToggle mode={view} onChange={setView} showPile={allowPile} />
        </div>
      </div>

      {pileMode ? (
        rows.length === 0 ? (
          emptyState
        ) : (
          <PileView
            items={rows.map(
              (r): PileEntry => ({
                key: r.entry.id,
                name: r.oracle?.name ?? '(unknown card)',
                image: r.printing?.imageNormal ?? r.oracle?.imageNormal ?? r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
                imageBack: r.printing?.imageBackNormal ?? r.oracle?.imageBackNormal ?? r.printing?.imageBackSmall ?? r.oracle?.imageBackSmall ?? null,
                count: r.entry.quantity,
                onLongPress: (faceDown) => {
                  // Face-down single-faced card: only the generic back is
                  // showing, so we tell them about the back, not the front.
                  const hasBack = !!(r.printing?.imageBackNormal ?? r.oracle?.imageBackNormal ?? r.printing?.imageBackSmall ?? r.oracle?.imageBackSmall);
                  if (faceDown && !hasBack) setCardBack(true);
                  else setInfo(r);
                },
              }),
            )}
          />
        )
      ) : filtered.length === 0 ? (
        emptyState
      ) : (
        <CardItems
          view={view}
          items={filtered.map(
            (r): CardItem => ({
              key: r.entry.id,
              name: r.oracle?.name ?? '(unknown card)',
              image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
              count: r.entry.quantity,
              badge: r.entry.quantityForTrade > 0 ? `${r.entry.quantityForTrade} FT` : undefined,
              badgeClass: 'badge-trade',
              badgeTitle: r.entry.quantityForTrade > 0 ? `${r.entry.quantityForTrade} for trade` : undefined,
              sub: (
                <>
                  {r.printing ? `${r.printing.setName} · #${r.printing.collectorNumber} · ` : ''}
                  {r.entry.condition} · {r.entry.finish}
                  {r.entry.lang !== 'en' ? ` · ${r.entry.lang}` : ''}
                </>
              ),
              price: formatPrice(r.printing, r.oracle) ?? '—',
              trend: moverFlags?.get(r.entry.scryfallId),
              onClick: () => setEditing(r),
            }),
          )}
        />
      )}

      {editing?.oracle && <CardSheet oracleCard={editing.oracle} entry={editing.entry} onClose={() => setEditing(null)} />}
      {info?.oracle && <CardSheet oracleCard={info.oracle} initialScryfallId={info.entry.scryfallId} readOnly onClose={() => setInfo(null)} />}
      {cardBack && <CardBackSheet onClose={() => setCardBack(false)} />}
    </>
  );
}
