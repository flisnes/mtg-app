import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.js';

export interface BulkAction {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Fixed bar shown while a card list is in selection mode. Presentational only:
 * the parent owns the selection state (useMultiSelect) and supplies the
 * context-appropriate actions. Portals to <body> so it floats above the tab bar
 * regardless of the list's stacking context.
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
  return createPortal(
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-bar-head">
        <button className="bulk-cancel" onClick={onCancel} aria-label="Cancel selection">
          <Icon name="close" size={18} />
        </button>
        <span className="bulk-count">
          <strong>{count}</strong> selected
        </span>
        <button className="linklike bulk-selectall" onClick={onToggleAll}>
          {allSelected ? 'Clear' : 'Select all'}
        </button>
      </div>
      <div className="bulk-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className={a.danger ? 'danger-outline' : ''}
            onClick={a.onClick}
            disabled={a.disabled || count === 0}
          >
            {a.icon && <Icon name={a.icon} size={16} />} {a.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
