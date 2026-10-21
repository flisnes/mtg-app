import { traitsLine, type CollectionEntry, type Priced, type Printing } from '@mtg/shared';
import { SetSymbol } from '../SetSymbol.js';
import type { DeckSlotEdit } from './types.js';

/**
 * One chip per copy (or slot) stacked under the tile the sheet opened from:
 * edition, what the copy is, how many. The current one is lit; tapping another
 * hands the form over to it. Scrolls sideways past a handful, since a Bolt
 * collector can hold a dozen kinds.
 */
export function CopyStrip({
  copies,
  printings,
  currentId,
  onPick,
}: {
  copies: readonly (CollectionEntry | DeckSlotEdit)[];
  printings: Priced<Printing>[];
  currentId: string;
  onPick: (id: string) => void;
}) {
  const byId = new Map(printings.map((p) => [p.scryfallId, p]));
  return (
    <div className="copy-strip" role="tablist" aria-label="Your copies of this card">
      {copies.map((c) => {
        const p = c.scryfallId ? byId.get(c.scryfallId) : undefined;
        const detail = traitsLine(c);
        const current = c.id === currentId;
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={current}
            className={current ? 'copy-chip copy-chip-current' : 'copy-chip'}
            onClick={() => onPick(c.id)}
            title={p ? `${p.setName} #${p.collectorNumber}` : 'Any printing'}
          >
            <span className="copy-chip-edition">
              {p ? (
                <>
                  <SetSymbol set={p.set} title={p.setName} /> {p.set.toUpperCase()}
                </>
              ) : (
                'Any'
              )}
            </span>
            {detail && <span className="copy-chip-detail">{detail}</span>}
            <span className="copy-chip-qty">×{c.quantity}</span>
          </button>
        );
      })}
    </div>
  );
}
