import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Trade } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';

function summarize(lines: { quantity: number }[]): number {
  return lines.reduce((s, l) => s + l.quantity, 0);
}

export function History() {
  const trades = useLiveQuery(() => db.trades.orderBy('completedAt').reverse().toArray(), []);
  const [open, setOpen] = useState<Trade | null>(null);

  return (
    <Page title="Trade history" subtitle="Completed trades, stored only on this device.">
      {trades === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : trades.length === 0 ? (
        <EmptyState phase="a trade">No trades yet.</EmptyState>
      ) : (
        <ul className="menu-list">
          {trades.map((t) => (
            <li key={t.id}>
              <button className="menu-item" style={{ width: '100%' }} onClick={() => setOpen(t)}>
                <span className="menu-icon" aria-hidden>
                  🤝
                </span>
                <span>
                  Trade with Other User
                  <span className="badge">
                    −{summarize(t.given)} / +{summarize(t.received)}
                  </span>
                  <div className="result-sub">{new Date(t.completedAt).toLocaleString()}</div>
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Trade detail">
            <h2 style={{ margin: 0 }}>Trade with Other User</h2>
            <p className="fine-print">{new Date(open.completedAt).toLocaleString()}</p>
            <h3>You gave</h3>
            <TradeLines lines={open.given} />
            <h3>You received</h3>
            <TradeLines lines={open.received} />
            <div className="sheet-actions">
              <button className="primary" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

function TradeLines({ lines }: { lines: Trade['given'] }) {
  if (lines.length === 0) return <p className="fine-print">Nothing.</p>;
  return (
    <ul className="result-list">
      {lines.map((l, i) => (
        <li key={i} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
          <div className="result-main">
            <div className="result-name">
              {l.quantity}× {l.name}
            </div>
            <div className="result-sub">
              {l.condition} · {l.finish}
              {l.lang !== 'en' ? ` · ${l.lang}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
