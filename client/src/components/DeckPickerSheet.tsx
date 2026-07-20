import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/schema.js';
import { formatLabel } from '../deck/legality.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';

/**
 * Bottom-sheet that lists the user's decks and reports the picked deck's id.
 * Used for bulk "Add to deck" from the collection (no other deck picker exists
 * in the app — decks are otherwise only added to from inside their own search).
 */
export function DeckPickerSheet({ onPick, onClose }: { onPick: (deckId: string) => void; onClose: () => void }) {
  const navigate = useNavigate();
  const decks = useLiveQuery(() => db.decks.orderBy('updatedAt').reverse().toArray(), []);

  return (
    <Sheet onClose={onClose} title="Add to deck" label="Choose a deck">
      {decks === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : decks.length === 0 ? (
        <div className="empty-state">
          <p>No decks yet.</p>
          <p className="empty-phase">
            <button className="linklike" onClick={() => navigate('/decks')}>
              Create a deck
            </button>{' '}
            first.
          </p>
        </div>
      ) : (
        <ul className="menu-list">
          {decks.map((deck) => (
            <li key={deck.id}>
              <button className="menu-item menu-item-btn" onClick={() => onPick(deck.id)}>
                <span className="menu-icon" aria-hidden>
                  <Icon name="decks" />
                </span>
                <span className="deck-line">
                  <span className="deck-name">{deck.name}</span>
                  <span className="deck-meta">
                    <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>
                  </span>
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sheet-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
