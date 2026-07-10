import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import type { OracleCard, Priced } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { addToWishlist, removeFromWishlist } from '../db/dataAccess.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from '../components/CardViews.js';

export function Wishlist() {
  const [name, setName] = useState('');
  const [view, setView] = useViewMode();
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);
  const rows = useLiveQuery(async () => {
    const entries = await db.wishlist.toArray();
    const oracleMap = await getOracleCardsByIds(entries.map((e) => e.oracleId));
    return entries.map((entry) => ({ entry, oracle: oracleMap.get(entry.oracleId) }));
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
            <Link to="/">Search for cards</Link> and tap ＋⭐.
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
                image: r.oracle?.imageSmall ?? null,
                count: r.entry.quantity,
                sub: r.entry.scryfallId ? 'specific printing' : 'any printing',
                onClick: r.oracle
                  ? () => setInfo({ oracle: r.oracle!, scryfallId: r.entry.scryfallId ?? undefined })
                  : undefined,
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

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}
