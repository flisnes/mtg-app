import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { createDeckFolder } from '../db/dataAccess.js';
import { ListPickerSheet } from './ListPicker.js';
import { MenuRow } from './MenuRow.js';

/**
 * Bottom-sheet that lists deck folders and reports the picked one (or
 * undefined for "No folder"), with an inline "name it, create it" toolbar so
 * moving a deck into a brand-new folder never means backing out to the sidebar
 * to make it first.
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
  const folders = useLiveQuery(() => db.deckFolders.orderBy('name').toArray(), []);
  const current = <span className="badge">Current</span>;

  return (
    <ListPickerSheet
      onClose={onClose}
      title="Move to folder"
      label={`Move “${deckName}” to a folder`}
      items={folders}
      itemKey={(f) => f.id}
      onPick={(f) => onPick(f.id)}
      render={(f) => ({
        icon: 'folder',
        label: f.name,
        end: f.id === currentFolderId && current,
        disabled: f.id === currentFolderId,
        chevron: false,
      })}
      lead={
        <li>
          <MenuRow
            icon={<span />}
            label="No folder"
            end={!currentFolderId && current}
            disabled={!currentFolderId}
            chevron={false}
            onClick={() => onPick(undefined)}
          />
        </li>
      }
      create={{
        placeholder: 'New folder name…',
        label: 'Create & move',
        what: 'create the folder',
        onCreate: async (name) => onPick(await createDeckFolder(name)),
      }}
    />
  );
}
