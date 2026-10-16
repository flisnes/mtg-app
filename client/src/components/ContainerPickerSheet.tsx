import { useState } from 'react';
import { useContainersByRecent } from '../db/collectionSnapshot.js';
import { useNavigate } from 'react-router-dom';
import { CONTAINER_KINDS, type ContainerKind } from '@mtg/shared';
import { formatLabel } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { createContainer } from '../db/dataAccess.js';
import { Emblem } from './Emblem.js';
import { Sheet } from './Sheet.js';
import { ListPicker } from './ListPicker.js';

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
  ...body
}: ContainerPickerProps & {
  onClose: () => void;
  title?: string;
  label?: string;
}) {
  return (
    <Sheet onClose={onClose} title={title} label={label} className="container-picker">
      <ContainerPickerBody onPick={onPick} onCancel={onClose} {...body} />
    </Sheet>
  );
}

interface ContainerPickerProps {
  onPick: (containerId: string, kind: ContainerKind) => void;
  /** Container to leave out — the one you're already looking at. */
  excludeId?: string;
  /** Restrict the list to these container ids (and show them as one flat list). */
  only?: Set<string>;
  /** Extra line under a container's name, e.g. "holds 3 of these". */
  noteFor?: (containerId: string) => string | undefined;
  /** Shown instead of the list when nothing qualifies. */
  emptyText?: string;
}

/**
 * The picker without its sheet: kind tabs, the list, and the create field. The
 * intake questionnaire shows it as its "where do these live?" step inside its
 * own sheet (give that sheet the `container-picker` class so only the list
 * scrolls).
 */
export function ContainerPickerBody({
  onPick,
  excludeId,
  only,
  noteFor,
  emptyText,
  onCancel,
}: ContainerPickerProps & { onCancel?: () => void }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<ContainerKind>('deck');
  const rows = useContainersByRecent();
  const meta = CONTAINER_META[kind];
  const restricted = !!only;
  const shown = rows
    ?.filter((r) => r.id !== excludeId)
    .filter((r) => (only ? only.has(r.id) : containerKind(r) === kind));

  return (
    <ListPicker
      items={shown}
      itemKey={(row) => row.id}
      onPick={(row) => onPick(row.id, containerKind(row))}
      render={(row) => {
        const rowMeta = CONTAINER_META[containerKind(row)];
        const note = noteFor?.(row.id);
        return {
          icon: <Emblem emblem={row.emblem} kind={rowMeta.kind} size={28} />,
          label: row.name,
          meta: (rowMeta.kind === 'deck' || note) && (
            <>
              {rowMeta.kind === 'deck' && <span className="deck-format">{formatLabel(row.format ?? 'casual')}</span>}
              {note && <span className="search-meta">{note}</span>}
            </>
          ),
        };
      }}
      head={
        !restricted && (
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
        )
      }
      // Only the list scrolls: a shelf of thirty decks used to push the kind
      // tabs off the top of the sheet, and binders and boxes looked as if they
      // weren't on offer at all.
      scrollClassName="container-picker-list"
      empty={
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
      }
      create={
        restricted
          ? undefined
          : {
              placeholder: `New ${meta.noun} name…`,
              label: 'Create & add',
              what: `create the ${kind}`,
              onCreate: async (name) => onPick(await createContainer(name, kind), kind),
            }
      }
      onCancel={onCancel}
    />
  );
}
