import type { OracleCard } from '@mtg/shared';
import { canJoinCommandZone, isCompanion } from '../../deck/legality.js';
import { Icon } from '../icons.js';
import type { ModeFlags } from './modeFlags.js';
import type { CardSheetActionFns } from './save.js';
import { LIST_META, LIST_ORDER, addLabel, type ListKind } from './types.js';

/**
 * The bottom of the sheet: the quick-adds into your own lists (for the modes
 * that aren't about them), then the action row, whose shape depends on the mode.
 */
export function CardSheetActions({
  flags,
  oracleCard,
  commandZone,
  busy,
  added,
  editMode,
  onEdit,
  onFileAway,
  hideRemove,
  applyLabel,
  actions,
  onClose,
}: {
  flags: ModeFlags;
  oracleCard: OracleCard;
  commandZone: readonly OracleCard[];
  busy: boolean;
  added: { list: ListKind } | null;
  editMode: boolean;
  onEdit: () => void;
  onFileAway: () => void;
  hideRemove: boolean;
  applyLabel?: string;
  actions: CardSheetActionFns;
  onClose: () => void;
}) {
  const { mode, addTo, deckAdd, listAddKind } = flags;
  const { save, startAdd } = actions;
  // The deck-board buttons only make sense adding a real card into a real deck;
  // Commander swaps the sideboard for the command zone and the companion.
  const deckBoards = flags.deckAddIsDeck && !flags.cardIsToken;
  const commanderAdd = deckBoards && addTo.kind === 'deck' && addTo.format === 'commander';

  return (
    <>
      {/* File-into-your-lists affordance, for the modes that aren't about your
          lists: a container slot (yours or not). Each opens that list's real
          add form — the copy is yours to describe, not ours to guess. */}
      {(mode === 'deck' || deckAdd) && (
        <div className="sheet-quickadd">
          <div className="sheet-quickadd-btns">
            <button onClick={() => startAdd('collection')} disabled={busy} title="Add to collection">
              <Icon name="collection" size={16} /> Add to collection
            </button>
            <button onClick={() => startAdd('wishlist')} disabled={busy} title="Add to wishlist">
              <Icon name="wishlist" size={16} /> Add to wishlist
            </button>
          </div>
        </div>
      )}
      {mode === 'wish' && (
        <div className="sheet-quickadd">
          <span className="sheet-quickadd-label">Got it?</span>
          <div className="sheet-quickadd-btns">
            <button onClick={() => startAdd('collection')} disabled={busy} title="Add to collection">
              <Icon name="collection" size={16} /> Add to collection
            </button>
          </div>
        </div>
      )}

      {added ? (
        // Where the +List button was a moment ago: the same shape, answered.
        <div className="sheet-actions">
          <p className="sheet-added" role="status">
            <Icon name="check" size={16} /> Added to {LIST_META[added.list].label.toLowerCase()}{' '}
            <Icon name={LIST_META[added.list].icon} size={16} />
          </p>
        </div>
      ) : mode === 'info' ? (
        // Nothing to save, so the row holds what someone actually came for.
        <div className="sheet-actions sheet-actions-pair">
          <button onClick={() => startAdd('wishlist')} disabled={busy} title="Add to wishlist">
            <Icon name="wishlist" size={16} /> Add to wishlist
          </button>
          <button className="primary" onClick={() => startAdd('collection')} disabled={busy} title="Add to collection">
            <Icon name="collection" size={16} /> Add to collection
          </button>
        </div>
      ) : mode === 'edit' && !editMode ? (
        // A copy you own, not being edited: filing it somewhere is as likely as
        // changing it, so both are buttons.
        <div className="sheet-actions sheet-actions-pair">
          <button onClick={onFileAway} disabled={busy} title="File into a deck, binder or box">
            <Icon name="binder" size={16} /> File away
          </button>
          <button className="primary" onClick={onEdit}>
            <Icon name="edit" size={16} /> Edit
          </button>
        </div>
      ) : (
        <div className={listAddKind ? 'sheet-actions sheet-actions-lists' : 'sheet-actions'}>
          {mode !== 'add' && !hideRemove && (
            <button className="danger-outline" onClick={() => void actions.del()} disabled={busy}>
              Remove
            </button>
          )}
          {/* The three list adds need the whole row at 393px, so they leave
              Cancel to the header's close button (and Back, when the add was
              stepped into from another mode, sits beside the name). */}
          {!listAddKind && (
            <button onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          {commanderAdd && canJoinCommandZone(oracleCard, commandZone) && (
            <button onClick={() => void save('commander')} disabled={busy}>
              {commandZone.length === 1 ? 'Add as second commander' : 'Add as commander'}
            </button>
          )}
          {commanderAdd && isCompanion(oracleCard) && (
            <button onClick={() => void save('companion')} disabled={busy}>
              Set as companion
            </button>
          )}
          {/* Commander has no sideboard: its companion has the button above. */}
          {deckBoards && !commanderAdd && (
            <button onClick={() => void save('side')} disabled={busy}>
              Add to sideboard
            </button>
          )}
          {deckBoards && (
            <button onClick={() => void save('maybe')} disabled={busy}>
              Add to considering
            </button>
          )}
          {flags.canSetCompanion && (
            <button onClick={() => void actions.saveAsCompanion()} disabled={busy}>
              Set as companion
            </button>
          )}
          {flags.deckAddIsDeck && flags.cardIsToken ? (
            <button className="primary" onClick={() => void save('token')} disabled={busy}>
              Add to tokens
            </button>
          ) : listAddKind ? (
            <>
              {LIST_ORDER.filter((k) => k !== listAddKind).map((k) => (
                <button key={k} className="add-alt" title={LIST_META[k].title} onClick={() => void save('main', k)} disabled={busy}>
                  + {LIST_META[k].short}
                </button>
              ))}
              <button className="primary add-primary" onClick={() => void save('main', listAddKind)} disabled={busy}>
                {LIST_META[listAddKind].title}
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => void save()} disabled={busy}>
              {mode === 'add' ? addLabel(addTo) : mode === 'session' ? applyLabel ?? 'Apply' : 'Save'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
