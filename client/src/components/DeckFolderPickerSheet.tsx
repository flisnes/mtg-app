import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { createDeckFolder } from '../db/dataAccess.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';
import { useAsyncAction } from './useAsyncAction.js';

/**
 * Bottom-sheet that lists deck folders and reports the picked one (or
 * undefined for "No folder"). Mirrors ContainerPickerSheet's shape — a list
 * plus an inline "name it, create it" toolbar — so moving a deck into a
 * brand-new folder never means backing out to the sidebar to make it first.
 */
export function DeckFolderPickerSheet({
  deckName,
  currentFolderId,
  onPick,
  onClose,
}: {
  deckName: string;
  currentFolderId?: string;
  onPick: (folderId: string | undefined) => void;
  onClose: () => void;
}) {
  const action = useAsyncAction();
  const [newName, setNewName] = useState('');
  const folders = useLiveQuery(() => db.deckFolders.orderBy('name').toArray(), []);

  async function createAndPick() {
    const id = await createDeckFolder(newName);
    setNewName('');
    onPick(id);
  }

  return (
    <Sheet onClose={onClose} title="Move to folder" label={`Move “${deckName}” to a folder`}>
      <ul className="menu-list">
        <li>
          <button className="menu-item menu-item-btn" disabled={!currentFolderId} onClick={() => onPick(undefined)}>
            <span className="menu-icon" aria-hidden />
            <span className="deck-name">No folder</span>
            {!currentFolderId && <span className="badge">Current</span>}
          </button>
        </li>
        {folders === undefined ? (
          <li>
            <p className="search-meta">Loading…</p>
          </li>
        ) : (
          folders.map((f) => (
            <li key={f.id}>
              <button
                className="menu-item menu-item-btn"
                disabled={f.id === currentFolderId}
                onClick={() => onPick(f.id)}
              >
                <span className="menu-icon" aria-hidden>
                  <Icon name="folder" />
                </span>
                <span className="deck-name">{f.name}</span>
                {f.id === currentFolderId && <span className="badge">Current</span>}
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="list-toolbar">
        <input
          className="search-input grow"
          placeholder="New folder name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void createAndPick()}
          aria-label="New folder name"
        />
        <button className="primary" onClick={() => action.run('create the folder', createAndPick)}>
          Create &amp; move
        </button>
      </div>

      <div className="sheet-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
