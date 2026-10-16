import type { MissingCard } from '../../db/queries.js';
import { addToWishlistBulk } from '../../db/dataAccess.js';
import { Sheet } from '../../components/Sheet.js';
import { useToast } from '../../components/Toast.js';
import { useKeySet } from '../../components/useKeySet.js';
import { plural } from '../../util/format.js';

/**
 * "Add what's missing to your wishlist": the deck's unowned, unwished cards,
 * all ticked. It shows up on the way out of a deck (`leaving`), and on demand
 * from the options menu; same sheet, but asking for it deliberately shouldn't
 * also walk you off the page, so the caller decides what `onDone` does.
 */
export function MissingWishSheet({
  cards,
  deckName,
  leaving,
  onDone,
}: {
  cards: MissingCard[];
  deckName: string;
  leaving: boolean;
  /** Added, skipped or cancelled: the sheet is finished either way. */
  onDone: () => void;
}) {
  const toast = useToast();
  const picked = useKeySet(cards.map((c) => c.oracleId));
  const keys = cards.map((c) => c.oracleId);
  const allPicked = picked.all(keys);
  const chosen = cards.filter((c) => picked.has(c.oracleId));

  async function add() {
    // One batch so the whole add is a single (undoable) edit-history entry. The
    // wish inherits what the deck's slots asked for, so a deck wanting a foil
    // doesn't go shopping for a nonfoil.
    await addToWishlistBulk(
      chosen.map((c) => ({
        oracleId: c.oracleId,
        scryfallId: null,
        quantity: c.addQty,
        ...(c.condition ? { condition: c.condition } : {}),
        ...(c.finish ? { finish: c.finish } : {}),
        ...(c.lang ? { lang: c.lang } : {}),
      })),
      { source: 'manual', label: deckName },
    );
    toast(`Added ${chosen.length} ${plural(chosen.length, 'card')} to wishlist`);
    onDone();
  }

  return (
    <Sheet onClose={onDone} label="Add missing cards to wishlist" title="Add missing cards to wishlist?">
      <p className="fine-print">
        This deck needs {cards.reduce((s, c) => s + c.addQty, 0)} {plural(cards.length, 'card')} you don’t own and
        haven’t wishlisted. Pick which to add:
      </p>
      <div className="list-toolbar">
        <label className="chip" style={{ alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={allPicked} onChange={() => picked.toggleAll(keys)} />{' '}
          {allPicked ? 'Unselect all' : 'Select all'}
        </label>
        <span className="search-meta grow">
          {chosen.length} of {cards.length} selected
        </span>
      </div>
      <ul className="result-list" style={{ maxHeight: '40dvh', overflowY: 'auto' }}>
        {cards.map((c) => (
          <li key={c.oracleId} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
            <label className="result-main" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(c.oracleId)} onChange={() => picked.toggle(c.oracleId)} />
              <span className="result-name">
                {c.name} {c.addQty !== 1 && <span className="badge">×{c.addQty}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        <button onClick={onDone}>{leaving ? 'Skip' : 'Cancel'}</button>
        <button className="primary" disabled={chosen.length === 0} onClick={() => void add()}>
          Add {chosen.length} to wishlist
        </button>
      </div>
    </Sheet>
  );
}
