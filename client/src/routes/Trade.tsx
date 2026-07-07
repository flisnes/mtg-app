import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import type { Seat, TradeLine } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { TRADE_ENABLED } from '../trade/config.js';
import {
  getPersistedTrade,
  otherSeat,
  useTradeSession,
  type ActiveTrade,
} from '../trade/useTradeSession.js';

const lineKey = (l: { scryfallId: string; condition: string; finish: string; lang: string }) =>
  `${l.scryfallId}|${l.condition}|${l.finish}|${l.lang}`;

export function Trade() {
  const trade = useTradeSession();
  const [joinCode, setJoinCode] = useState('');
  const [resumable, setResumable] = useState<ActiveTrade | null>(null);

  useEffect(() => {
    if (trade.status === 'idle') void getPersistedTrade().then((t) => setResumable(t ?? null));
  }, [trade.status]);

  if (!TRADE_ENABLED) {
    return (
      <Page title="Trade" subtitle="Trade in person: share a code, build offers, confirm after inspecting.">
        <EmptyState phase="a later update">
          Trading needs a secure connection to the trade server, which isn’t configured for this build yet.
        </EmptyState>
      </Page>
    );
  }

  if (trade.status === 'idle' || trade.status === 'error') {
    return (
      <Page title="Trade" subtitle="Trade in person: share a code, build offers, confirm after inspecting.">
        {trade.error && <p className="gate-error">{trade.error}</p>}
        {resumable && (
          <div className="empty-state">
            <p>You have an unfinished trade ({resumable.code}).</p>
            <div className="confirm-row" style={{ justifyContent: 'center' }}>
              <button className="primary" onClick={() => trade.resume(resumable)}>
                Resume
              </button>
              <button onClick={() => { void db.settings.delete('activeTrade'); setResumable(null); }}>Discard</button>
            </div>
          </div>
        )}
        <div className="trade-actions">
          <button className="primary" onClick={trade.create}>
            Start a trade
          </button>
        </div>
        <div className="list-toolbar">
          <input
            className="search-input grow"
            placeholder="Enter code…"
            value={joinCode}
            maxLength={6}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            aria-label="Join code"
          />
          <button onClick={() => trade.join(joinCode)} disabled={joinCode.length < 6}>
            Join
          </button>
        </div>
      </Page>
    );
  }

  if (trade.status === 'connecting' || !trade.snapshot || !trade.seat) {
    return (
      <Page title="Trade">
        <p className="gate-msg">Connecting…</p>
      </Page>
    );
  }

  return <TradeBoard trade={trade} seat={trade.seat} />;
}

function TradeBoard({ trade, seat }: { trade: ReturnType<typeof useTradeSession>; seat: Seat }) {
  const snap = trade.snapshot!;
  const peer = otherSeat(seat);
  const [myOffer, setMyOffer] = useState<TradeLine[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const inited = useRef(false);

  // On (re)connect, seed the local offer from the server snapshot once.
  useEffect(() => {
    if (!inited.current && snap.offers[seat].length > 0) {
      inited.current = true;
      setMyOffer(snap.offers[seat]);
    }
  }, [snap, seat]);

  const theirOffer = snap.offers[peer];
  const editable = snap.state !== 'completed' && snap.state !== 'cancelled';

  function commit(next: TradeLine[]) {
    setMyOffer(next);
    trade.sendOffer(next);
  }

  function addLine(line: TradeLine, max: number) {
    const key = lineKey(line);
    const next = [...myOffer];
    const idx = next.findIndex((l) => lineKey(l) === key);
    if (idx >= 0) {
      if (next[idx]!.quantity >= max) return;
      next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
    } else next.push({ ...line, quantity: 1 });
    commit(next);
  }

  function setQty(key: string, qty: number) {
    const next = myOffer.map((l) => (lineKey(l) === key ? { ...l, quantity: qty } : l)).filter((l) => l.quantity > 0);
    commit(next);
  }

  // Prices for both offers.
  const scryfallIds = [...myOffer, ...theirOffer].map((l) => l.scryfallId);
  const priceMap = useLiveQuery(() => getPrintingsByIds(scryfallIds), [scryfallIds.join(',')]);
  const totalOf = (lines: TradeLine[]) =>
    lines.reduce((sum, l) => sum + (priceMap?.get(l.scryfallId)?.priceEur ?? 0) * l.quantity, 0);

  const iAccepted = snap.accepted[seat];
  const peerAccepted = snap.accepted[peer];
  const iConfirmed = snap.confirmed[seat];
  const peerConfirmed = snap.confirmed[peer];

  if (snap.state === 'completed') {
    return (
      <Page title="Trade complete 🎉">
        <p className="gate-msg">Your collection has been updated.</p>
        <div className="trade-actions">
          <Link className="chip" to="/history">
            View trade history
          </Link>
          <button className="primary" onClick={trade.reset}>
            New trade
          </button>
        </div>
      </Page>
    );
  }
  if (snap.state === 'cancelled') {
    return (
      <Page title="Trade cancelled">
        <p className="gate-msg">No changes were made.</p>
        <button className="primary" onClick={trade.reset}>
          New trade
        </button>
      </Page>
    );
  }

  return (
    <Page title="Trade">
      <div className="trade-status">
        <div>
          Code <strong className="trade-code">{snap.code}</strong>
        </div>
        <div className={trade.peerPresent ? 'presence-on' : 'presence-off'}>
          {snap.present[peer] ? 'Other User connected' : 'Waiting for other user…'}
        </div>
      </div>

      <div className="offer-panes">
        <div className="offer-pane">
          <h3>
            Your offer <span className="badge">€{totalOf(myOffer).toFixed(2)}</span>
          </h3>
          <OfferList lines={myOffer} editable={editable} onQty={setQty} />
          {editable && (
            <button onClick={() => setShowPicker((s) => !s)}>{showPicker ? 'Done adding' : '＋ Add from tradelist'}</button>
          )}
          {showPicker && editable && <TradelistPicker onAdd={addLine} />}
        </div>

        <div className="offer-pane">
          <h3>
            Other User’s offer <span className="badge">€{totalOf(theirOffer).toFixed(2)}</span>
          </h3>
          <OfferList lines={theirOffer} editable={false} />
          <p className="fine-print">{peerAccepted ? '✓ they accepted' : '…not accepted yet'}</p>
        </div>
      </div>

      <div className="trade-footer">
        {snap.state === 'agreed' ? (
          <>
            <p className="gate-msg">Both accepted. Inspect the cards, then confirm.</p>
            <div className="trade-actions">
              <button onClick={trade.cancel}>Cancel</button>
              <button className="primary" onClick={trade.confirmComplete} disabled={iConfirmed}>
                {iConfirmed ? 'Waiting for other…' : 'Confirm completed'}
              </button>
            </div>
            <p className="fine-print">
              {iConfirmed ? 'You confirmed. ' : ''}
              {peerConfirmed ? 'Other User confirmed.' : 'Other User has not confirmed yet.'}
            </p>
          </>
        ) : (
          <div className="trade-actions">
            <button onClick={trade.cancel}>Cancel</button>
            {iAccepted ? (
              <button className="primary" onClick={trade.unaccept}>
                Un-accept ({peerAccepted ? 'they accepted' : 'waiting for them'})
              </button>
            ) : (
              <button className="primary" onClick={trade.accept}>
                Accept offers
              </button>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

function OfferList({
  lines,
  editable,
  onQty,
}: {
  lines: TradeLine[];
  editable: boolean;
  onQty?: (key: string, qty: number) => void;
}) {
  if (lines.length === 0) return <p className="fine-print">No cards yet.</p>;
  return (
    <ul className="result-list">
      {lines.map((l) => (
        <li key={lineKey(l)} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
          <div className="result-main">
            <div className="result-name">
              {l.quantity}× {l.name}
            </div>
            <div className="result-sub">
              {l.condition} · {l.finish}
              {l.lang !== 'en' ? ` · ${l.lang}` : ''}
            </div>
          </div>
          {editable && onQty && (
            <div className="quick-actions">
              <button onClick={() => onQty(lineKey(l), l.quantity - 1)}>−</button>
              <button onClick={() => onQty(lineKey(l), l.quantity + 1)}>＋</button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function TradelistPicker({ onAdd }: { onAdd: (line: TradeLine, max: number) => void }) {
  const rows = useLiveQuery(async () => {
    const entries = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
    const oracleMap = await getOracleCardsByIds(entries.map((e) => e.oracleId));
    return entries.map((e) => ({ e, name: oracleMap.get(e.oracleId)?.name ?? '(unknown card)' }));
  }, []);

  if (!rows) return <p className="fine-print">Loading tradelist…</p>;
  if (rows.length === 0) return <p className="fine-print">Your tradelist is empty. Mark cards “for trade” first.</p>;

  return (
    <ul className="result-list">
      {rows.map(({ e, name }) => (
        <li key={e.id} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
          <button
            className="result-open"
            style={{ cursor: 'pointer' }}
            onClick={() =>
              onAdd(
                { oracleId: e.oracleId, scryfallId: e.scryfallId, name, quantity: 1, condition: e.condition, finish: e.finish, lang: e.lang },
                e.quantityForTrade,
              )
            }
          >
            <div className="result-main">
              <div className="result-name">{name}</div>
              <div className="result-sub">
                {e.condition} · {e.finish} · {e.quantityForTrade} for trade
              </div>
            </div>
            <span className="menu-chevron" aria-hidden>
              ＋
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
