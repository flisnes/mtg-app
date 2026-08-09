import { useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MAX_CARD_TAG_LENGTH, normalizeCardTags } from '@mtg/shared';
import { db } from '../db/schema.js';
import { deckTags } from '../deck/tags.js';
import { Icon } from './icons.js';

/**
 * One slot's tags, edited as chips. The tags already used elsewhere in the same
 * container are offered as a datalist, so the second card you label "Ramp" gets
 * the same spelling as the first (grouping folds case anyway, but a tidy list
 * beats a tidy-ish one). Purely controlled — the sheet's Save writes them, so
 * Cancel drops tag edits along with everything else.
 */
export function TagField({
  deckId,
  tags,
  onChange,
}: {
  deckId: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const rows = useLiveQuery(() => db.deckCards.where('deckId').equals(deckId).toArray(), [deckId]);
  const used = new Set(tags.map((t) => t.toLocaleLowerCase()));
  const suggestions = deckTags(rows ?? []).filter((t) => !used.has(t.toLocaleLowerCase()));

  function add(value: string) {
    const next = normalizeCardTags([...tags, value]) ?? [];
    setDraft('');
    onChange(next);
  }

  return (
    <div className="field tag-field">
      <span>Tags</span>
      {tags.length > 0 && (
        <div className="tag-chips">
          {tags.map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button
                type="button"
                className="tag-chip-x"
                aria-label={`Remove tag ${t}`}
                onClick={() => onChange(tags.filter((x) => x !== t))}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="tag-add-row">
        <input
          type="text"
          list={listId}
          className="grow"
          placeholder="Add a tag…"
          value={draft}
          maxLength={MAX_CARD_TAG_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Don't let Enter fall through to the sheet's save-on-enter.
            e.preventDefault();
            e.stopPropagation();
            if (draft.trim()) add(draft);
          }}
          aria-label="Add a tag"
        />
        <datalist id={listId}>
          {suggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button type="button" disabled={!draft.trim()} onClick={() => add(draft)}>
          Add
        </button>
      </div>
    </div>
  );
}
