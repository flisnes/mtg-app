import { useState } from 'react';
import { TRADE_ENABLED } from '../trade/config.js';
import { useTransfer } from '../transfer/useTransfer.js';

// "Your data" section of About & settings: move everything (collection, lists,
// decks, history) to another device with a one-time code, trade-style. The
// relay server forwards the payload chunks but never stores or parses them.

export function DataTransfer() {
  const t = useTransfer();
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState('');

  if (!TRADE_ENABLED) {
    return (
      <p className="fine-print">
        Device-to-device transfer needs a connection to the trade server, which isn’t configured for this build.
      </p>
    );
  }

  if (t.status === 'idle') {
    if (joining) {
      return (
        <div className="transfer-panel">
          <p className="fine-print">Enter the code shown on the device you’re transferring from.</p>
          <div className="list-toolbar">
            <input
              className="search-input grow"
              placeholder="Enter code…"
              value={joinCode}
              maxLength={6}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              aria-label="Transfer code"
            />
            <button className="primary" onClick={() => t.startReceive(joinCode)} disabled={joinCode.length < 6}>
              Receive
            </button>
            <button onClick={() => setJoining(false)}>Cancel</button>
          </div>
        </div>
      );
    }
    return (
      <div className="trade-actions">
        <button onClick={t.startSend}>Send to another device</button>
        <button onClick={() => setJoining(true)}>Receive from another device</button>
      </div>
    );
  }

  if (t.status === 'connecting') {
    return <p className="gate-msg">Connecting…</p>;
  }

  if (t.status === 'waiting') {
    return (
      <div className="transfer-panel">
        <p>
          Your transfer code is <strong className="trade-code">{t.code}</strong>
        </p>
        <p className="fine-print">
          On the other device, open About &amp; settings → Your data → “Receive from another device” and enter this
          code. Nothing is sent until it connects.
        </p>
        <button onClick={t.reset}>Cancel</button>
      </div>
    );
  }

  if (t.status === 'transferring') {
    const pct = Math.round(t.progress * 100);
    return (
      <div className="transfer-panel">
        <p className="gate-msg">
          {t.role === 'send' ? 'Sending' : 'Receiving'}… {pct}%
        </p>
        <div className="progress transfer-progress">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
        <button onClick={t.reset}>Cancel</button>
      </div>
    );
  }

  if (t.status === 'sent') {
    return (
      <div className="transfer-panel">
        <p role="status">Everything sent — finish the transfer on the other device.</p>
        <button onClick={t.reset}>Done</button>
      </div>
    );
  }

  if (t.status === 'review' && t.counts) {
    const c = t.counts;
    return (
      <div className="transfer-panel">
        <p role="status">
          Received {c.cards.toLocaleString()} card{c.cards === 1 ? '' : 's'} (
          {c.collectionEntries.toLocaleString()} collection entries), {c.wishlist.toLocaleString()} wishlist{' '}
          {c.wishlist === 1 ? 'entry' : 'entries'}, {c.decks.toLocaleString()} deck{c.decks === 1 ? '' : 's'},{' '}
          {c.trades.toLocaleString()} recorded trade{c.trades === 1 ? '' : 's'} and price tracking for{' '}
          {c.watchedCards.toLocaleString()} card{c.watchedCards === 1 ? '' : 's'}.
        </p>
        <p className="fine-print">
          Applying will <strong>replace</strong> the collection, lists and decks currently on this device.
        </p>
        <div className="confirm-row">
          <button className="danger" onClick={t.apply}>
            Replace my data
          </button>
          <button onClick={t.reset}>Cancel</button>
        </div>
      </div>
    );
  }

  if (t.status === 'applying') {
    return <p className="gate-msg">Applying…</p>;
  }

  if (t.status === 'done') {
    return (
      <div className="transfer-panel">
        <p role="status">Transfer complete — your data is now on this device.</p>
        <button onClick={t.reset}>Done</button>
      </div>
    );
  }

  return (
    <div className="transfer-panel">
      <p className="gate-error">{t.error ?? 'Transfer failed.'}</p>
      <button onClick={t.reset}>Start over</button>
    </div>
  );
}
