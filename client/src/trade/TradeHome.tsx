import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import type { SessionSnapshot } from '@mtg/shared';
import { Page } from '../routes/Page.js';
import { db } from '../db/schema.js';
import { CodeJoinForm } from '../components/CodeJoinForm.js';
import { Icon } from '../components/icons.js';
import { Loading } from '../components/Loading.js';
import { clearTradeScanSessions } from '../scan/tradeSessions.js';
import { plural } from '../util/format.js';
import { sumQty } from '../util/groupBy.js';
import { TradeRow } from './TradeRow.js';
import {
  clearPersistedSoloTrade,
  clearPersistedTrade,
  getPersistedSoloTrade,
  getPersistedTrade,
  type ActiveTrade,
  type TradeSession,
} from './useTradeSession.js';

export const TRADE_SUBTITLE = 'Trade in person: share a code, build offers, confirm after inspecting.';

/** Both piles of a stored solo trade: what the resume prompt offers back. */
function soloCards(snap: SessionSnapshot): number {
  return sumQty(snap.offers.a) + sumQty(snap.offers.b);
}

/** The trade landing: start, join or resume, the last few trades, and the list shortcuts. */
export function TradeHome({ trade }: { trade: TradeSession }) {
  const [resumable, setResumable] = useState<ActiveTrade | null>(null);
  // A solo trade has no relay session to resume: the stored snapshot *is* the
  // trade, so it comes back whole (both piles included).
  const [soloResumable, setSoloResumable] = useState<SessionSnapshot | null>(null);

  // Re-read on 'error' too: a mid-trade drop that exhausts its reconnect
  // attempts lands here directly (skipping 'idle'), and the persisted trade is
  // still there to resume. The Resume prompt shouldn't be missing for it.
  useEffect(() => {
    void getPersistedTrade().then((t) => setResumable(t ?? null));
    void getPersistedSoloTrade().then((s) => setSoloResumable(s ?? null));
  }, [trade.status]);

  const soloCount = soloResumable ? soloCards(soloResumable) : 0;
  return (
    <Page title="Trade" subtitle={TRADE_SUBTITLE}>
      <div className="trade-home">
        <section className="trade-home-start">
          {trade.error && <p className="gate-error">{trade.error}</p>}
          {resumable && (
            <div className="empty-state">
              <p>You have an unfinished trade ({resumable.code}).</p>
              <div className="confirm-row" style={{ justifyContent: 'center' }}>
                <button className="primary" onClick={() => trade.resume(resumable)}>
                  Resume
                </button>
                <button onClick={() => { void clearPersistedTrade(); setResumable(null); }}>Discard</button>
              </div>
            </div>
          )}
          {soloResumable && (
            <div className="empty-state">
              <p>
                You have an unfinished solo trade ({soloCount} {plural(soloCount, 'card')}).
              </p>
              <div className="confirm-row" style={{ justifyContent: 'center' }}>
                <button className="primary" onClick={() => trade.resumeSolo(soloResumable)}>
                  Resume
                </button>
                <button
                  onClick={() => {
                    void clearPersistedSoloTrade();
                    clearTradeScanSessions();
                    setSoloResumable(null);
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
          <div className="trade-actions">
            <button className="primary" onClick={trade.create}>
              Start a trade
            </button>
            <button onClick={trade.startSolo}>Trade solo</button>
          </div>
          <p className="fine-print">
            Trading with someone who isn’t on the app? “Trade solo” lets you fill in both sides and record it yourself.
          </p>
          <CodeJoinForm label="Join code" submitLabel="Join" onSubmit={trade.join} />
        </section>

        <RecentTrades />

        <div className="trade-home-links">
          <Link className="trade-home-tile" to="/tradelist">
            <span className="trade-home-tile-icon" aria-hidden>
              <Icon name="tradelist" size={22} />
            </span>
            <strong>Your tradelist</strong>
            <span className="fine-print">Cards you’ve marked for trade</span>
          </Link>
          <Link className="trade-home-tile" to="/community">
            <span className="trade-home-tile-icon" aria-hidden>
              <Icon name="community" size={22} />
            </span>
            <strong>Community trades</strong>
            <span className="fine-print">Browse other collectors</span>
          </Link>
        </div>
      </div>
    </Page>
  );
}

/**
 * The middle slab of the trade landing: the last few completed trades (device-
 * local, same store as the history view) with a shortcut to the full history.
 */
function RecentTrades() {
  const trades = useLiveQuery(() => db.trades.orderBy('completedAt').reverse().limit(3).toArray(), []);
  return (
    <section className="trade-home-recent">
      <div className="trade-home-recent-head">
        <h3>Recent trades</h3>
        <Link className="chip" to="/history">
          Trade history <Icon name="chevronRight" size={16} className="chev" />
        </Link>
      </div>
      {trades === undefined ? (
        <Loading fine />
      ) : trades.length === 0 ? (
        <p className="fine-print">No trades yet. Completed trades will show up here.</p>
      ) : (
        <ul className="menu-list">
          {trades.map((t) => (
            <li key={t.id}>
              <TradeRow trade={t} to="/history" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Between "Start a trade"/"Join" and a session: say what's happening, let the
 * user back out, and after a few seconds admit the server isn't answering
 * (venue wifi) with Retry and the solo fallback. Retries carry on meanwhile.
 */
export function TradeConnecting({ trade }: { trade: TradeSession }) {
  const { intent, slow } = trade;
  const doing =
    intent?.kind === 'join'
      ? <>Joining <strong className="trade-code">{intent.code}</strong>…</>
      : intent?.kind === 'resume'
        ? <>Resuming trade <strong className="trade-code">{intent.code}</strong>…</>
        : 'Starting a trade…';
  return (
    <Page title="Trade">
      <div className="trade-connecting" role="status" aria-live="polite">
        <span className="spinner" aria-hidden />
        <p className="trade-connecting-doing">{doing}</p>
        {slow ? (
          <>
            <p className="trade-connecting-fail">Can’t reach the trade server</p>
            <p className="fine-print">Still trying in the background. Check your connection, or record the trade yourself.</p>
            <div className="trade-actions">
              <button className="primary" onClick={trade.retryConnect}>
                Retry
              </button>
              <button onClick={trade.startSolo}>Trade solo instead</button>
            </div>
          </>
        ) : (
          <p className="fine-print">Connecting to the trade server…</p>
        )}
        <button className="trade-connecting-cancel" onClick={trade.abortConnect}>
          Cancel
        </button>
      </div>
    </Page>
  );
}

/** A live trade whose socket dropped: the board stays, this says why edits may bounce. */
export function ReconnectBanner({ trade }: { trade: TradeSession }) {
  if (trade.status !== 'connecting') return null;
  return (
    <div className="trade-reconnecting" role="status" aria-live="polite">
      <span className="spinner spinner-sm" aria-hidden />
      <span>{trade.error ?? 'Reconnecting to the trade server…'}</span>
    </div>
  );
}
