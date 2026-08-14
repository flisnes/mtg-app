import type { ReactNode } from 'react';
import { Icon } from './icons.js';
import { useDismiss } from './useDismiss.js';
import { useTapGuard } from './useTapGuard.js';

/**
 * "You don't own these yet — add them to your collection too?"
 *
 * A deck, binder or box says where cardboard is; the collection says you have
 * it. Filling a container from a physical pile is the moment both facts become
 * true at once, so every path that fills one — a scan, a re-scan, a pasted list
 * — ends here with a tick-list rather than leaving the collection none the wiser.
 */
export interface UnownedCard {
  key: string;
  name: string;
  image?: string;
  /** Set · number · language · finish · condition, for the row's second line. */
  sub: string;
  qty: number;
}

export function UnownedPromptSheet({
  cards,
  picked,
  busy = false,
  intro,
  confirmLabel,
  backLabel = 'Back',
  onToggle,
  onToggleAll,
  onBack,
  onConfirm,
}: {
  cards: UnownedCard[];
  picked: Set<string>;
  busy?: boolean;
  /** Why this is being asked, in a sentence. */
  intro?: ReactNode;
  confirmLabel: (chosenQty: number) => string;
  backLabel?: string;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const allPicked = cards.length > 0 && picked.size === cards.length;
  const chosen = cards.filter((c) => picked.has(c.key));
  const chosenQty = chosen.reduce((n, c) => n + c.qty, 0);
  useDismiss(busy ? null : onBack);
  const tapGuard = useTapGuard();

  return (
    <div className="sheet-backdrop" onClick={onBack} {...tapGuard}>
      <div
        className="sheet scan-list-sheet"
        role="dialog"
        aria-label="Add these cards to your collection"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="scan-sheet-head">
          <h2>Add to collection?</h2>
          <button className="scan-close" onClick={onBack} aria-label={backLabel}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="fine-print">
          {intro ?? (
            <>
              {cards.length} card{cards.length === 1 ? '' : 's'} here {cards.length === 1 ? "isn't" : "aren't"} in your
              collection yet. Pick which to also add:
            </>
          )}
        </p>
        <div className="list-toolbar">
          <label className="chip" style={{ alignSelf: 'flex-start' }}>
            <input type="checkbox" checked={allPicked} onChange={onToggleAll} /> {allPicked ? 'Unselect all' : 'Select all'}
          </label>
          <span className="search-meta grow">
            {chosen.length} of {cards.length} selected
          </span>
        </div>
        <ul className="scan-list">
          {cards.map((c) => (
            <li key={c.key} className="scan-list-row">
              <label className="scan-list-main" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.has(c.key)} onChange={() => onToggle(c.key)} />
                {c.image ? <img className="scan-list-thumb" src={c.image} alt="" /> : <span className="scan-list-thumb" />}
                <span className="scan-list-info">
                  <strong>{c.name}</strong>
                  <span className="scan-printing">{c.sub}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="scan-confirm-actions">
          <button className="primary" disabled={busy} onClick={onConfirm}>
            {busy ? 'Applying…' : confirmLabel(chosenQty)}
          </button>
          <button onClick={onBack} disabled={busy}>
            {backLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
