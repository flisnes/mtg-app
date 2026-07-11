import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing, WishlistEntry } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { addToWishlist, removeFromWishlist } from '../db/dataAccess.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from '../components/CardViews.js';
import { useOpenSearch } from '../components/GlobalSearch.js';
import { Icon } from '../components/icons.js';

interface WishRow {
  entry: WishlistEntry;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
}

export function Wishlist() {
  const [name, setName] = useState('');
  const [view, setView] = useViewMode();
  const openSearch = useOpenSearch();
  const [editing, setEditing] = useState<WishRow | null>(null);
  const rows = useLiveQuery(async (): Promise<WishRow[]> => {
    const entries = await db.wishlist.toArray();
    const [oracleMap, printMap] = await Promise.all([
      getOracleCardsByIds(entries.map((e) => e.oracleId)),
      getPrintingsByIds(entries.map((e) => e.scryfallId).filter((id): id is string => id !== null)),
    ]);
    return entries.map((entry) => ({
      entry,
      oracle: oracleMap.get(entry.oracleId),
      printing: entry.scryfallId ? printMap.get(entry.scryfallId) : undefined,
    }));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = name.trim().toLowerCase();
    return rows
      .filter((r) => !q || (r.oracle?.name.toLowerCase().includes(q) ?? false))
      .sort((a, b) => (a.oracle?.name ?? '').localeCompare(b.oracle?.name ?? ''));
  }, [rows, name]);

  return (
    <Page title="Wishlist" subtitle="Cards you’re after — surfaced to trade partners during a session.">
      {rows === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p>Nothing on your wishlist yet.</p>
          <p className="empty-phase">
            <button className="linklike" onClick={openSearch}>Search for cards</button> and tap +
            <Icon name="wishlist" size={14} />.
          </p>
        </div>
      ) : (
        <>
          <input
            className="search-input"
            type="search"
            placeholder="Filter by name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Filter by name"
          />
          <div className="meta-row">
            <p className="search-meta">{filtered.length} card{filtered.length === 1 ? '' : 's'}</p>
            <ViewToggle mode={view} onChange={setView} />
          </div>
          <CardItems
            view={view}
            items={filtered.map(
              (r): CardItem => ({
                key: r.entry.id,
                name: r.oracle?.name ?? '(unknown card)',
                image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
                count: r.entry.quantity,
                sub: r.entry.scryfallId
                  ? r.printing
                    ? `${r.printing.setName} · #${r.printing.collectorNumber}`
                    : 'specific printing'
                  : 'any printing',
                onClick: r.oracle ? () => setEditing(r) : undefined,
                actions: (
                  <>
                    <button title="Remove one" onClick={() => removeFromWishlist(r.entry.id, 1)}>−</button>
                    <button
                      title="Add one"
                      onClick={() => addToWishlist({ oracleId: r.entry.oracleId, scryfallId: r.entry.scryfallId, quantity: 1 })}
                    >
                      ＋
                    </button>
                    <button title="Remove" onClick={() => removeFromWishlist(r.entry.id)}>✕</button>
                  </>
                ),
              }),
            )}
          />
        </>
      )}

      {editing?.oracle && (
        <CardSheet oracleCard={editing.oracle} wishEntry={editing.entry} onClose={() => setEditing(null)} />
      )}
    </Page>
  );
}
