import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.js';

export interface BulkAction {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

// How many actions sit on the bar itself. Callers list their actions most-used
// first; anything past this goes behind "More".
const INLINE = 2;

/**
 * Fixed bar shown while a card list is in selection mode. Presentational only:
 * the parent owns the selection state (useMultiSelect) and supplies the
 * context-appropriate actions. Portals to <body> so it floats above the tab bar
 * regardless of the list's stacking context. Nothing selected: just the head
 * line, so a phone screen stays usable. Once something is: the first two
 * actions show inline, the rest behind "More".
 */
export function BulkActionBar({
  count,
  allSelected,
  onToggleAll,
  onCancel,
  actions,
}: {
  count: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onCancel: () => void;
  actions: BulkAction[];
}) {
  const [more, setMore] = useState(false);
  const showActions = count > 0 && actions.length > 0;
  // A lone extra action isn't worth a "More" button: show it.
  const inline = actions.length <= INLINE + 1 ? actions : actions.slice(0, INLINE);
  const rest = actions.slice(inline.length);
  const button = (a: BulkAction) => (
    <button key={a.label} className={a.danger ? 'danger-outline' : ''} onClick={a.onClick} disabled={a.disabled}>
      {a.icon && <Icon name={a.icon} size={16} />} {a.label}
    </button>
  );
  return createPortal(
    <div className={showActions ? 'bulk-bar' : 'bulk-bar collapsed'} role="toolbar" aria-label="Bulk actions">
      <div className="bulk-bar-head">
        <button className="bulk-cancel" onClick={onCancel} aria-label="Cancel selection">
          <Icon name="close" size={20} />
        </button>
        <span className="bulk-count">
          <strong>{count}</strong> selected
        </span>
        <button className="linklike bulk-selectall" onClick={onToggleAll}>
          {allSelected ? 'Clear' : 'Select all'}
        </button>
      </div>
      {showActions && (
        <div className="bulk-actions">
          {inline.map(button)}
          {rest.length > 0 && (
            <button className="bulk-more" onClick={() => setMore((v) => !v)} aria-expanded={more}>
              <Icon name="more" size={16} /> {more ? 'Less' : 'More'}
            </button>
          )}
        </div>
      )}
      {showActions && more && rest.length > 0 && <div className="bulk-more-actions">{rest.map(button)}</div>}
    </div>,
    document.body,
  );
}
