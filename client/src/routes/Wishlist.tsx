import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { addToWishlist, removeFromWishlist } from '../db/dataAccess.js';
import { CardGrid, ViewToggle, useViewMode, type GridItem } from '../components/CardGrid.js';

export function Wishlist() {
  const [name, setName] = useState('');
  const [view, setView] = useViewMode();
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
          {view === 'grid' ? (
            <CardGrid
              items={filtered.map(
                (r): GridItem => ({
                  key: r.entry.id,
                  name: r.oracle?.name ?? '(unknown card)',
                  image: r.oracle?.imageSmall ?? null,
                  count: r.entry.quantity,
                  footer: (
                    <>
                      <button title="Remove one" onClick={() => removeFromWishlist(r.entry.id, 1)}>−</button>
                      <button title="Add one" onClick={() => addToWishlist({ oracleId: r.entry.oracleId, scryfallId: r.entry.scryfallId, quantity: 1 })}>＋</button>
                      <button title="Remove" onClick={() => removeFromWishlist(r.entry.id)}>✕</button>
                    </>
                  ),
                }),
              )}
            />
          ) : (
          <ul className="result-list">
            {filtered.map((r) => (
              <li key={r.entry.id} className="result-row">
                <div className="result-open">
                  {r.oracle?.imageSmall ? (
                    <img className="result-thumb" src={r.oracle.imageSmall} alt="" loading="lazy" width={46} height={64} />
                  ) : (
                    <div className="result-thumb" aria-hidden />
                  )}
                  <div className="result-main">
                    <div className="result-name">{r.oracle?.name ?? '(unknown card)'}</div>
                    <div className="result-sub">{r.entry.scryfallId ? 'specific printing' : 'any printing'}</div>
                  </div>
                </div>
                <div className="quick-actions">
                  <button
                    title="Remove one"
                    onClick={() => removeFromWishlist(r.entry.id, 1)}
                  >
                    −
                  </button>
                  <span className="qty-pill" style={{ padding: '0 0.4rem', alignSelf: 'center' }}>
                    {r.entry.quantity}
                  </span>
                  <button
                    title="Add one"
                    onClick={() => addToWishlist({ oracleId: r.entry.oracleId, scryfallId: r.entry.scryfallId, quantity: 1 })}
                  >
                    ＋
                  </button>
                  <button title="Remove" onClick={() => removeFromWishlist(r.entry.id)}>
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
          )}
        </>
      )}
    </Page>
  );
}
