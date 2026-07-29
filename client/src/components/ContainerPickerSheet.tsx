import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { CONTAINER_KINDS, type ContainerKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { formatLabel } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { createContainer } from '../db/dataAccess.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';

/**
 * Bottom-sheet that lists the user's decks, binders and boxes and reports the
 * picked one. Used for bulk "File away" from the collection (nothing else picks
 * a container — they're otherwise added to from inside their own search), and it
 * can create one on the spot so filing a selection never means backing out to
 * make the box first.
 */
export function ContainerPickerSheet({
  onPick,
  onClose,
}: {
  onPick: (containerId: string, kind: ContainerKind) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<ContainerKind>('deck');
  const [newName, setNewName] = useState('');
  const rows = useLiveQuery(() => db.decks.orderBy('updatedAt').reverse().toArray(), []);
  const shown = rows?.filter((r) => containerKind(r) === kind);
  const meta = CONTAINER_META[kind];

  async function createAndPick() {
    const id = await createContainer(newName, kind);
    setNewName('');
    onPick(id, kind);
  }

  return (
    <Sheet onClose={onClose} title="File away" label="Choose a deck, binder or box">
      <div className="seg-row" role="tablist" aria-label="Container kind">
        {CONTAINER_KINDS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? 'seg seg-active' : 'seg'}
            onClick={() => setKind(k)}
          >
            {CONTAINER_META[k].Plural}
          </button>
        ))}
      </div>

      {shown === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <p>No {meta.Plural.toLowerCase()} yet.</p>
          <p className="empty-phase">Name one below, or</p>
          <p className="empty-phase">
            <button className="linklike" onClick={() => navigate(meta.path)}>
              go to {meta.Plural}
            </button>
          </p>
        </div>
      ) : (
        <ul className="menu-list">
          {shown.map((row) => (
            <li key={row.id}>
              <button className="menu-item menu-item-btn" onClick={() => onPick(row.id, kind)}>
                <span className="menu-icon" aria-hidden>
                  <Icon name={meta.icon} />
                </span>
                <span className="deck-line">
                  <span className="deck-name">{row.name}</span>
                  {kind === 'deck' && (
                    <span className="deck-meta">
                      <span className="deck-format">{formatLabel(row.format ?? 'casual')}</span>
                    </span>
                  )}
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="list-toolbar">
        <input
          className="search-input grow"
          placeholder={`New ${meta.noun} name…`}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void createAndPick()}
          aria-label={`New ${meta.noun} name`}
        />
        <button className="primary" onClick={() => void createAndPick()}>
          Create &amp; add
        </button>
      </div>

      <div className="sheet-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
