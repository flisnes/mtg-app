import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Trade } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardList, type CardItem } from '../components/CardViews.js';
import { Sheet } from '../components/Sheet.js';
import { Loading } from '../components/Loading.js';
import { tradeLineCardItem } from '../components/cardRows.js';
import { TradeRow } from '../trade/TradeRow.js';
import { fmtDateTime } from '../util/format.js';

export function History() {
  const trades = useLiveQuery(() => db.trades.orderBy('completedAt').reverse().toArray(), []);
  const [open, setOpen] = useState<Trade | null>(null);
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  return (
    <Page title="Trade history" subtitle="Completed trades, stored only on this device.">
      {trades === undefined ? (
        <Loading />
      ) : trades.length === 0 ? (
        <EmptyState>No trades yet.</EmptyState>
      ) : (
        <ul className="menu-list">
          {trades.map((t) => (
            <li key={t.id}>
              <TradeRow trade={t} onClick={() => setOpen(t)} />
            </li>
          ))}
        </ul>
      )}

      {open && (
        <Sheet
          onClose={() => setOpen(null)}
          label="Trade detail"
          title={`Trade with ${open.partner ?? 'Other User'}`}
          subtitle={fmtDateTime(open.completedAt)}
        >
          <h3>You gave</h3>
          <TradeLines lines={open.given} onInfo={(oracle, scryfallId) => setInfo({ oracle, scryfallId })} />
          <h3>You received</h3>
          <TradeLines lines={open.received} onInfo={(oracle, scryfallId) => setInfo({ oracle, scryfallId })} />
        </Sheet>
      )}

      {info && (
        <CardSheet mode="info" oracleCard={info.oracle} initialScryfallId={info.scryfallId} onClose={() => setInfo(null)} />
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
  const cards = useCardMaps(lines);
  if (lines.length === 0) return <p className="fine-print">Nothing.</p>;
  return (
    <CardList
      items={lines.map((l, i): CardItem => {
        const oracle = cards.oracleMap?.get(l.oracleId);
        return {
          ...tradeLineCardItem(l, `${i}-${l.scryfallId}`, cards),
          onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
        };
      })}
    />
  );
}
