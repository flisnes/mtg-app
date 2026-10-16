import type { ReactNode } from 'react';
import { ScanListRow } from './ScanListRow.js';
import { Sheet } from './Sheet.js';
import { plural } from '../util/format.js';

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
  return (
    <Sheet
      onClose={onBack}
      dismiss={busy ? null : onBack}
      className="scan-list-sheet"
      label="Add these cards to your collection"
      title="Add to collection?"
      closeButton={{ label: backLabel }}
    >
      <p className="fine-print">
        {intro ?? (
          <>
            {cards.length} {plural(cards.length, 'card')} here {cards.length === 1 ? "isn't" : "aren't"} in your
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
          <ScanListRow
            key={c.key}
            image={c.image}
            name={c.name}
            sub={c.sub}
            check={{ checked: picked.has(c.key), onChange: () => onToggle(c.key) }}
          />
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
    </Sheet>
  );
}
