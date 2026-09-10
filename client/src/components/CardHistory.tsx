import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, PriceHistory, Printing, RemovalReason, UserEvent } from '@mtg/shared';
import { REMOVAL_REASONS } from '@mtg/shared';
import { editUserEvent } from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import { centsAround, centsNearest, dayKeyOf } from '../price/history.js';
import { currencySymbol, moneyInput } from '../price/rates.js';
import { describeEvent, qtyBadge, REASON_LABELS } from '../history/eventRegistry.js';
import { fmtCents, fmtDate } from '../util/format.js';
import { Icon } from './icons.js';
import { useAsyncAction } from './useAsyncAction.js';
import { useDismiss } from './useDismiss.js';

// The card's event timeline (sync plan, 2026-07-16) — acquisitions with the
// market price at the time, removals with a reason, deck ins/outs, and the
// wishlist journey. Acquisition/exit prices and removal reasons are
// user-editable (removals default to 'sold'). Labels/icons come from the shared
// event registry (history/eventRegistry).


/**
 * The timeline as a sheet over whatever opened it, reached from the card
 * sheet's ⋯ menu as "Collection history".
 *
 * It used to be a tab on the card sheet, which charged all fifteen shapes of
 * that sheet 56px for a panel almost nobody opens, and split the sheet where
 * the content doesn't: the head above the tabs (price, owned count, filed-in
 * pills) and the buttons below them both belong to the details view, so the
 * strip claimed to switch views while two thirds of the sheet ignored it.
 * "History" also never said whose — this name does.
 *
 * Nested inside the card sheet's own backdrop (like EditionGrid), so its
 * click handler has to stop propagating or the sheet underneath closes too.
 */
export function CardHistorySheet({
  oracleCard,
  scryfallId,
  printings,
  priceHistory,
  onEventClick,
  onClose,
}: {
  oracleCard: Priced<OracleCard>;
  scryfallId: string;
  printings: Priced<Printing>[];
  priceHistory?: PriceHistory | null;
  onEventClick?: (e: UserEvent) => void;
  onClose: () => void;
}) {
  // Correcting what you paid is reading-your-own-history work, so the toggle
  // lives with the rows it fixes and dies with this sheet.
  const [editMode, setEditMode] = useState(false);
  useDismiss(onClose);
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="sheet card-history-sheet"
        role="dialog"
        aria-label={`Collection history for ${oracleCard.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="edition-picker-head">
          <div className="card-history-title">
            <h2>Collection history</h2>
            <p className="fine-print">Every change you've made to {oracleCard.name} in your collection.</p>
          </div>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <CardHistory
          oracleCard={oracleCard}
          scryfallId={scryfallId}
          printings={printings}
          priceHistory={priceHistory}
          editMode={editMode}
          onToggleEdit={() => setEditMode((v) => !v)}
          onEventClick={onEventClick}
        />
      </div>
    </div>
  );
}

export function CardHistory({
  oracleCard,
  scryfallId,
  printings,
  priceHistory,
  editMode = false,
  onToggleEdit,
  onEventClick,
}: {
  oracleCard: Priced<OracleCard>;
  /** The shown printing. The timeline scopes to it, plus the oracle's
   * printing-agnostic events (any-printing wishes / deck cards). */
  scryfallId: string;
  printings: Priced<Printing>[];
  /** Recorded daily prices of the sheet's shown printing (server-merged when signed in). */
  priceHistory?: PriceHistory | null;
  /** When true, editable rows expand into the inline price/reason editor. */
  editMode?: boolean;
  /** When set, the panel offers its own "Fix prices" toggle for `editMode`.
   *  These are the user's own events wherever the card is being shown, so the
   *  timeline is correctable from any sheet that renders it. */
  onToggleEdit?: () => void;
  /** When set (and not editing), clicking a row opens that event's info modal. */
  onEventClick?: (e: UserEvent) => void;
}) {
  const events = useLiveQuery(
    () => db.events.where('oracleId').equals(oracleCard.oracleId).toArray(),
    [oracleCard.oracleId],
  );
  // Scope to the shown printing; printing-agnostic events (any-printing wishes
  // / deck cards) have no edition, so they show on every edition's timeline.
  const sorted = useMemo(
    () =>
      (events ?? [])
        .filter((e) => !e.scryfallId || e.scryfallId === scryfallId)
        .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)),
    [events, scryfallId],
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
  // acquisitions of qty × (price now − price then). Removed copies aren't
  // netted out — this is "how the cards you picked up have moved", not a
  // realized P&L.
  //
  // "Price then" climbs the same ladder the sheet's own figure does (see
  // costBasis.ts): what you told us, else what we stamped on the day, else the
  // reading nearest that day. Skipping the unpriced adds instead would have
  // this line report nothing on exactly the cards the sheet above it reports a
  // gain for.
  const summary = useMemo(() => {
    const adds = sorted.filter((e) => e.kind === 'collection.add');
    if (!adds.length) return null;
    const since = Math.min(...adds.map((e) => e.ts));
    let delta = 0;
    let priced = false;
    for (const e of adds) {
      const then = e.priceEurCents ?? (priceHistory ? centsNearest(priceHistory, dayKeyOf(e.ts))?.cents ?? null : null);
      if (then == null) continue;
      const now = centsNow(e.scryfallId);
      if (now == null) continue;
      delta += (now - then) * (e.qty ?? 1);
      priced = true;
    }
    return { since, delta: priced ? delta : null };
    // centsNow only depends on printings/oracleCard, stable per render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, printings, oracleCard, priceHistory]);

  if (!events) return null;
  if (!sorted.length) {
    return <p className="fine-print">Nothing recorded yet. History starts when you add, trade or wish for this card.</p>;
  }

  // Only acquisitions and removals carry an editable price, so the toggle only
  // shows when the timeline actually has one to fix.
  const hasEditable = sorted.some((e) => e.kind === 'collection.add' || e.kind === 'collection.remove');

  return (
    <div className="card-history">
      <div className="history-head">
        {summary ? (
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
        ) : (
          <span />
        )}
        {onToggleEdit && hasEditable && (
          <button className="linklike history-edit-toggle" onClick={onToggleEdit}>
            {editMode ? 'Done' : 'Fix prices'}
          </button>
        )}
      </div>
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
  const action = useAsyncAction();
  // Only collection add/remove carry an editable price/reason. In edit mode a
  // click on one of those expands the inline editor; otherwise a click opens
  // the event's info modal (when a handler is provided).
  const hasInlineEdit = e.kind === 'collection.add' || e.kind === 'collection.remove';
  const inlineEditing = editMode && hasInlineEdit;
  const [editing, setEditing] = useState(false);
  // Prices are stored in EUR cents but typed in whatever currency the rest of
  // the row shows, so the editor converts on the way in and back out.
  const money = moneyInput();
  const [priceText, setPriceText] = useState(e.priceEurCents != null ? money.text(e.priceEurCents / 100) : '');
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
    const eur = money.toEur(priceText);
    const cents = eur == null ? null : Math.round(eur * 100);
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
            <span>
              {e.kind === 'collection.add' ? 'Price when acquired' : 'Price when removed'} (
              {currencySymbol(money.currency)}/ea)
            </span>
            <input
              inputMode="decimal"
              placeholder={hint != null ? `≈ ${money.text(hint / 100)}` : 'unknown'}
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
            <button className="primary" onClick={() => action.run('save the price', save)}>
              Save
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}
