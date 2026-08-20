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
 * picked one. Used for bulk "File away" from the collection and for the
 * multi-select actions inside a container ("also file these there", "take these
 * out of there"). It can create one on the spot so filing a selection never
 * means backing out to make the box first.
 *
 * Pass `only` to narrow the list to specific containers — the "take these out of
 * there" case, where offering a container that holds none of the selection would
 * just be a dead end. That mode drops the kind tabs (the answer can be a deck
 * *and* a box) and the create field (there's nothing to create).
 */
export function ContainerPickerSheet({
  onPick,
  onClose,
  title = 'File away',
  label = 'Choose a deck, binder or box',
  excludeId,
  only,
  noteFor,
  emptyText,
}: {
  onPick: (containerId: string, kind: ContainerKind) => void;
  onClose: () => void;
  title?: string;
  label?: string;
  /** Container to leave out — the one you're already looking at. */
  excludeId?: string;
  /** Restrict the list to these container ids (and show them as one flat list). */
  only?: Set<string>;
  /** Extra line under a container's name, e.g. "holds 3 of these". */
  noteFor?: (containerId: string) => string | undefined;
  /** Shown instead of the list when nothing qualifies. */
  emptyText?: string;
}) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<ContainerKind>('deck');
  const [newName, setNewName] = useState('');
  const rows = useLiveQuery(() => db.decks.orderBy('updatedAt').reverse().toArray(), []);
  const meta = CONTAINER_META[kind];
  const restricted = !!only;
  const shown = rows
    ?.filter((r) => r.id !== excludeId)
    .filter((r) => (only ? only.has(r.id) : containerKind(r) === kind));

  async function createAndPick() {
    const id = await createContainer(newName, kind);
    setNewName('');
    onPick(id, kind);
  }

  return (
    <Sheet onClose={onClose} title={title} label={label} className="container-picker">
      {!restricted && (
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
      )}

      {/* Only the list scrolls: a shelf of thirty decks used to push the kind
          tabs off the top of the sheet, and binders and boxes looked as if they
          weren't on offer at all. */}
      <div className="container-picker-list">
        {shown === undefined ? (
          <p className="search-meta">Loading…</p>
        ) : shown.length === 0 ? (
          restricted ? (
            <div className="empty-state">
              <p>{emptyText ?? 'Nowhere else holds these.'}</p>
            </div>
          ) : (
            <div className="empty-state">
              <p>No {meta.Plural.toLowerCase()} yet.</p>
              <p className="empty-phase">Name one below, or</p>
              <p className="empty-phase">
                <button className="linklike" onClick={() => navigate(meta.path)}>
                  go to {meta.Plural}
                </button>
              </p>
            </div>
          )
        ) : (
          <ul className="menu-list">
            {shown.map((row) => {
              const rowMeta = CONTAINER_META[containerKind(row)];
              const note = noteFor?.(row.id);
              return (
                <li key={row.id}>
                  <button
                    className="menu-item menu-item-btn"
                    onClick={() => onPick(row.id, containerKind(row))}
                  >
                    <span className="menu-icon" aria-hidden>
                      <Icon name={rowMeta.icon} />
                    </span>
                    <span className="deck-line">
                      <span className="deck-name">{row.name}</span>
                      {(rowMeta.kind === 'deck' || note) && (
                        <span className="deck-meta">
                          {rowMeta.kind === 'deck' && (
                            <span className="deck-format">{formatLabel(row.format ?? 'casual')}</span>
                          )}
                          {note && <span className="search-meta">{note}</span>}
                        </span>
                      )}
                    </span>
                    <span className="menu-chevron" aria-hidden>
                      ›
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!restricted && (
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
      )}

      <div className="sheet-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
