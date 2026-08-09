import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MAX_CARD_TAG_LENGTH } from '@mtg/shared';
import { db } from '../db/schema.js';
import { deleteDeckCardTag, renameDeckCardTag, tagDeckCards } from '../db/dataAccess.js';
import { deckTags, hasTag } from '../deck/tags.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';

/**
 * Tag the selected cards. Every tag this container already uses is listed with
 * a tri-state box: filled means all of the selection carries it, half means
 * some do. Tapping applies it to everything selected, tapping a full one takes
 * it off — so mixed selections resolve in one tap rather than card by card.
 *
 * Writes land immediately (no Save button): tagging is the whole point of the
 * sheet, and the list behind it updates live as you go. "Manage" reveals the
 * container-wide rename/delete, which rewrite every slot carrying the tag —
 * tags exist only because slots carry them, so that *is* the operation.
 */
export function TagSheet({
  deckId,
  slotIds,
  onClose,
}: {
  deckId: string;
  /** The selected slots (deckCards ids) the toggles apply to. */
  slotIds: string[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const rows = useLiveQuery(() => db.deckCards.where('deckId').equals(deckId).toArray(), [deckId]);

  const picked = useMemo(() => new Set(slotIds), [slotIds]);
  const all = rows ?? [];
  const selected = all.filter((r) => picked.has(r.id));
  const tags = deckTags(all);
  const n = selected.length;

  async function toggle(tag: string, allHaveIt: boolean) {
    await tagDeckCards(slotIds, allHaveIt ? { remove: [tag] } : { add: [tag] });
  }

  async function addDraft() {
    const tag = draft.trim();
    if (!tag) return;
    setDraft('');
    await tagDeckCards(slotIds, { add: [tag] });
  }

  async function commitRename(from: string) {
    const to = renameDraft.trim();
    setRenaming(null);
    if (to && to.toLocaleLowerCase() !== from.toLocaleLowerCase()) await renameDeckCardTag(deckId, from, to);
  }

  async function remove(tag: string) {
    const held = all.filter((r) => hasTag(r, tag)).length;
    if (!window.confirm(`Remove the tag “${tag}” from ${held} card${held === 1 ? '' : 's'}?`)) return;
    await deleteDeckCardTag(deckId, tag);
  }

  return (
    <Sheet onClose={onClose} title="Tags" label={`Tag ${n} card${n === 1 ? '' : 's'}`}>
      <p className="fine-print">
        Tagging <strong>{n}</strong> card{n === 1 ? '' : 's'}. Tags stay with this list and sync to your other
        devices.
      </p>

      {tags.length === 0 ? (
        <p className="search-meta">No tags here yet. Name one below — “Ramp”, “Removal”, “Turn-3 play”.</p>
      ) : (
        <ul className="menu-list">
          {tags.map((tag) => {
            const held = selected.filter((r) => hasTag(r, tag)).length;
            const state = held === 0 ? 'none' : held === n ? 'all' : 'some';
            if (renaming === tag) {
              return (
                <li key={tag}>
                  <div className="tag-row tag-row-edit">
                    <input
                      className="search-input grow"
                      value={renameDraft}
                      maxLength={MAX_CARD_TAG_LENGTH}
                      autoFocus
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(tag);
                        else if (e.key === 'Escape') setRenaming(null);
                      }}
                      aria-label={`Rename tag ${tag}`}
                    />
                    <button className="primary" onClick={() => void commitRename(tag)}>
                      Rename
                    </button>
                  </div>
                </li>
              );
            }
            return (
              <li key={tag}>
                <div className="tag-row">
                  <button className="menu-item menu-item-btn" onClick={() => void toggle(tag, state === 'all')}>
                    <span
                      className={`select-box${state === 'all' ? ' checked' : ''}${state === 'some' ? ' partial' : ''}`}
                      aria-hidden
                    >
                      {state === 'all' && <Icon name="check" size={14} />}
                    </span>
                    <span className="deck-name">{tag}</span>
                    <span className="badge">
                      {held}/{n}
                    </span>
                  </button>
                  {managing && (
                    <>
                      <button
                        className="tag-manage-btn"
                        title={`Rename “${tag}” everywhere`}
                        aria-label={`Rename tag ${tag}`}
                        onClick={() => {
                          setRenaming(tag);
                          setRenameDraft(tag);
                        }}
                      >
                        <Icon name="edit" size={15} />
                      </button>
                      <button
                        className="tag-manage-btn tag-manage-danger"
                        title={`Delete “${tag}” everywhere`}
                        aria-label={`Delete tag ${tag}`}
                        onClick={() => void remove(tag)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="list-toolbar">
        <input
          className="search-input grow"
          placeholder="New tag…"
          value={draft}
          maxLength={MAX_CARD_TAG_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addDraft()}
          aria-label="New tag"
        />
        <button className="primary" disabled={!draft.trim()} onClick={() => void addDraft()}>
          Add
        </button>
      </div>

      <div className="sheet-actions">
        {tags.length > 0 && (
          <button className="linklike" onClick={() => setManaging((v) => !v)}>
            {managing ? 'Done managing' : 'Manage tags'}
          </button>
        )}
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
