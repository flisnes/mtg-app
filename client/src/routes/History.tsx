import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Trade } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardList, type CardItem } from '../components/CardViews.js';
import { Icon } from '../components/icons.js';

function summarize(lines: { quantity: number }[]): number {
  return lines.reduce((s, l) => s + l.quantity, 0);
}

export function History() {
  const trades = useLiveQuery(() => db.trades.orderBy('completedAt').reverse().toArray(), []);
  const [open, setOpen] = useState<Trade | null>(null);
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  return (
    <Page title="Trade history" subtitle="Completed trades, stored only on this device.">
      {trades === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : trades.length === 0 ? (
        <EmptyState>No trades yet.</EmptyState>
      ) : (
        <ul className="menu-list">
          {trades.map((t) => (
            <li key={t.id}>
              <button className="menu-item" style={{ width: '100%' }} onClick={() => setOpen(t)}>
                <span className="menu-icon" aria-hidden>
                  <Icon name="trade" />
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
            <TradeLines lines={open.given} onInfo={(oracle, scryfallId) => setInfo({ oracle, scryfallId })} />
            <h3>You received</h3>
            <TradeLines lines={open.received} onInfo={(oracle, scryfallId) => setInfo({ oracle, scryfallId })} />
            <div className="sheet-actions">
              <button className="primary" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}

function TradeLines({
  lines,
  onInfo,
}: {
  lines: Trade['given'];
  onInfo: (oracle: Priced<OracleCard>, scryfallId?: string) => void;
}) {
  const { printMap, oracleMap } = useCardMaps(lines);
  if (lines.length === 0) return <p className="fine-print">Nothing.</p>;
  return (
    <CardList
      items={lines.map((l, i): CardItem => {
        const oracle = oracleMap?.get(l.oracleId);
        return {
          key: `${i}-${l.scryfallId}`,
          name: l.name,
          image: printMap?.get(l.scryfallId)?.imageSmall ?? oracle?.imageSmall ?? null,
          count: l.quantity,
          sub: (
            <>
              {l.condition} · {l.finish}
              {l.lang !== 'en' ? ` · ${l.lang}` : ''}
            </>
          ),
          onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
        };
      })}
    />
  );
}
