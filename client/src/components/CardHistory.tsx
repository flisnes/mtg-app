import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, PriceHistory, Printing, RemovalReason, UserEvent } from '@mtg/shared';
import { REMOVAL_REASONS } from '@mtg/shared';
import { editUserEvent } from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import { centsAround } from '../price/history.js';
import { describeEvent, qtyBadge, REASON_LABELS } from '../history/eventRegistry.js';
import { fmtCents, fmtDate } from '../util/format.js';

// History tab of the card sheet (sync plan, 2026-07-16): the card's event
// timeline — acquisitions with the market price at the time, removals with a
// reason, deck ins/outs, and the wishlist journey. Acquisition/exit prices and
// removal reasons are user-editable (removals default to 'sold'). Labels/icons
// come from the shared event registry (history/eventRegistry).


export function CardHistory({
  oracleCard,
  printings,
  priceHistory,
  editMode = false,
  onEventClick,
}: {
  oracleCard: Priced<OracleCard>;
  printings: Priced<Printing>[];
  /** Recorded daily prices of the sheet's shown printing (server-merged when signed in). */
  priceHistory?: PriceHistory | null;
  /** When true, editable rows expand into the inline price/reason editor. */
  editMode?: boolean;
  /** When set (and not editing), clicking a row opens that event's info modal. */
  onEventClick?: (e: UserEvent) => void;
}) {
  const events = useLiveQuery(
    () => db.events.where('oracleId').equals(oracleCard.oracleId).toArray(),
    [oracleCard.oracleId],
  );
  const sorted = useMemo(
    () => (events ?? []).slice().sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)),
    [events],
  );

  /**
   * Recorded EUR cents around an event's day, as a hint for events whose
   * acquisition/exit price is unknown. Only when the event names the same
   * printing the history was fetched for — a price of a different printing
   * would be a wrong hint, so those show plain "price unknown".
   */
  const centsThen = (e: UserEvent): number | null => {
    if (!priceHistory || e.scryfallId !== priceHistory.scryfallId) return null;
    return centsAround(priceHistory, new Date(e.ts).toISOString().slice(0, 10));
  };

  /** Current EUR cents for the printing an event names (oracle default as fallback). */
  const centsNow = (scryfallId: string | null | undefined): number | null => {
    const eur = scryfallId
      ? (printings.find((p) => p.scryfallId === scryfallId)?.priceEur ?? oracleCard.priceEur)
      : oracleCard.priceEur;
    return eur == null ? null : Math.round(eur * 100);
  };

  // Summary: owned since the earliest acquisition; value change = Σ over
  // acquisitions with a known price of qty × (price now − price then).
  // Removed copies aren't netted out — this is "how the cards you picked up
  // have moved", not a realized P&L.
  const summary = useMemo(() => {
    const adds = sorted.filter((e) => e.kind === 'collection.add');
    if (!adds.length) return null;
    const since = Math.min(...adds.map((e) => e.ts));
    let delta = 0;
    let priced = false;
    for (const e of adds) {
      if (e.priceEurCents == null) continue;
      const now = centsNow(e.scryfallId);
      if (now == null) continue;
      delta += (now - e.priceEurCents) * (e.qty ?? 1);
      priced = true;
    }
    return { since, delta: priced ? delta : null };
    // centsNow only depends on printings/oracleCard, stable per render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, printings, oracleCard]);

  if (!events) return null;
  if (!sorted.length) {
    return <p className="fine-print">Nothing recorded yet. History starts when you add, trade or wish for this card.</p>;
  }

  return (
    <div className="card-history">
      {summary && (
        <p className="history-summary">
          Owned since {fmtDate(summary.since)}
          {summary.delta != null && (
            <>
              {' · '}
              <span className={summary.delta > 0 ? 'price-up' : summary.delta < 0 ? 'price-down' : ''}>
                {summary.delta >= 0 ? '+' : '−'}
                {fmtCents(Math.abs(summary.delta))} since acquisition
              </span>
            </>
          )}
        </p>
      )}
      <ul className="history-list">
        {sorted.map((e) => (
          <HistoryRow
            key={e.id}
            event={e}
            centsNow={centsNow}
            centsThen={centsThen}
            editMode={editMode}
            onEventClick={onEventClick}
          />
        ))}
      </ul>
    </div>
  );
}

function HistoryRow({
  event: e,
  centsNow,
  centsThen,
  editMode,
  onEventClick,
}: {
  event: UserEvent;
  centsNow: (scryfallId: string | null | undefined) => number | null;
  centsThen: (e: UserEvent) => number | null;
  editMode: boolean;
  onEventClick?: (e: UserEvent) => void;
}) {
  // Only collection add/remove carry an editable price/reason. In edit mode a
  // click on one of those expands the inline editor; otherwise a click opens
  // the event's info modal (when a handler is provided).
  const hasInlineEdit = e.kind === 'collection.add' || e.kind === 'collection.remove';
  const inlineEditing = editMode && hasInlineEdit;
  const [editing, setEditing] = useState(false);
  const [priceText, setPriceText] = useState(e.priceEurCents != null ? (e.priceEurCents / 100).toFixed(2) : '');
  const [reason, setReason] = useState<RemovalReason>(e.reason ?? 'sold');

  const badge = qtyBadge(e);
  const now = hasInlineEdit ? centsNow(e.scryfallId) : null;
  const then = e.priceEurCents ?? null;
  const perCopyDelta = then != null && now != null ? now - then : null;
  // Recorded market price around the event's day — a hint where the user never
  // set one, not a substitute (it doesn't feed the summary delta above).
  const hint = hasInlineEdit && then == null ? centsThen(e) : null;

  const clickable = inlineEditing || !!onEventClick;
  const onRowClick = inlineEditing
    ? () => setEditing((v) => !v)
    : onEventClick
      ? () => onEventClick(e)
      : undefined;

  async function save() {
    const trimmed = priceText.trim().replace(',', '.');
    const cents = trimmed === '' ? null : Math.round(Number(trimmed) * 100);
    await editUserEvent(e.id, {
      priceEurCents: cents != null && Number.isFinite(cents) && cents >= 0 ? cents : null,
      ...(e.kind === 'collection.remove' ? { reason } : {}),
    });
    setEditing(false);
  }

  return (
    <li className="history-item">
      <button
        className={`history-row${clickable ? ' history-row-editable' : ''}`}
        onClick={onRowClick}
        disabled={!clickable}
      >
        {badge && <span className={`history-qty history-qty-${e.kind === 'collection.remove' ? 'out' : 'in'}`}>{badge}</span>}
        <span className="history-label">{describeEvent(e).verb}</span>
        <span className="history-when">{fmtDate(e.ts)}</span>
        {then != null && (
          <span className="history-price">
            {fmtCents(then)}/ea
            {perCopyDelta != null && perCopyDelta !== 0 && (
              <span className={perCopyDelta > 0 ? 'price-up' : 'price-down'}>
                {' '}
                ({perCopyDelta > 0 ? '+' : '−'}
                {fmtCents(Math.abs(perCopyDelta))})
              </span>
            )}
          </span>
        )}
        {hasInlineEdit && then == null && (
          <span className="history-price fine-print">{hint != null ? `≈ ${fmtCents(hint)}/ea then` : 'price unknown'}</span>
        )}
      </button>

      {editing && inlineEditing && (
        <div className="history-edit">
          <label className="field">
            <span>{e.kind === 'collection.add' ? 'Price when acquired (€/ea)' : 'Price when removed (€/ea)'}</span>
            <input
              inputMode="decimal"
              placeholder={hint != null ? `≈ ${(hint / 100).toFixed(2)}` : 'unknown'}
              value={priceText}
              onChange={(ev) => setPriceText(ev.target.value)}
            />
          </label>
          {e.kind === 'collection.remove' && (
            <label className="field">
              <span>Reason</span>
              <select value={reason} onChange={(ev) => setReason(ev.target.value as RemovalReason)}>
                {REMOVAL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="confirm-row">
            <button className="primary" onClick={() => void save()}>
              Save
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}
