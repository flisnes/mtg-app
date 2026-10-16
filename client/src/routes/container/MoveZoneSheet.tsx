import type { DeckBoard } from '@mtg/shared';
import type { BoardOption } from '../../deck/boards.js';
import { Sheet } from '../../components/Sheet.js';
import { Icon } from '../../components/icons.js';
import { plural } from '../../util/format.js';

/**
 * "Move to…" for a multi-selection: the deck's zones, with the ones this
 * selection can't go to greyed out and saying why rather than missing. Deck
 * brewing is mostly moving cards between these four piles, so it's a list of
 * plain rows, not a dropdown you have to open first.
 */
export function MoveZoneSheet({
  zones,
  count,
  onPick,
  onClose,
}: {
  zones: BoardOption[];
  count: number;
  onPick: (board: DeckBoard) => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} title={`Move ${count} ${plural(count, 'card')} to`} className="zone-sheet">
      <ul className="zone-list">
        {zones.map((z) => (
          <li key={z.board}>
            <button className="zone-option" onClick={() => onPick(z.board)} disabled={!!z.refusal}>
              <Icon name="moveTo" size={16} />
              <span className="zone-option-label">{z.label}</span>
              {z.refusal && <span className="zone-option-why">{z.refusal}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
