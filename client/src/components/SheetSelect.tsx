import { useEffect, useRef } from 'react';
import { Icon } from './icons.js';

// The card sheet's own dropdown. A native <select> is the obvious control here
// and it was the wrong one: the platform renders it as an overlay, which on
// Android lands a centred modal over the sheet and on desktop a panel floating
// off the field — two different shapes for one control, neither of them part of
// the sheet you're filling in. This opens *in* the sheet instead, in flow, so
// the sheet grows by the height of the list and everything stays where it was.
//
// The trigger and the list are separate pieces because they sit in different
// places: the trigger is one of four quarter-width fields on the traits row,
// and the list needs the whole row (a quarter of a phone wraps "Crimped"). The
// caller therefore owns which field is open — and only one ever is.

export interface SheetSelectOption {
  value: string;
  label: string;
}

/** The closed field: its label and the current answer, tappable. */
export function SheetSelectField({
  label,
  summary,
  muted = false,
  open,
  onToggle,
}: {
  label: string;
  summary: string;
  /** Nothing chosen yet ("None", "Any") — the answer reads dim. */
  muted?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`field sheet-picker${open ? ' open' : ''}`}>
      <span>{label}</span>
      <button
        type="button"
        className="sheet-picker-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}: ${summary}`}
        onClick={onToggle}
      >
        <span className={muted ? 'sheet-picker-summary sheet-picker-summary-none' : 'sheet-picker-summary'}>
          {summary}
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
    </div>
  );
}

/**
 * The open list, rendered by the caller under the whole row of fields.
 *
 * `multi` is the difference between "which condition is this copy in" and
 * "what's remarkable about it": a card can be both signed and altered, so
 * those stay open as you tick them, where picking a condition is done.
 */
export function SheetSelectList({
  label,
  options,
  selected,
  multi = false,
  onPick,
}: {
  label: string;
  options: SheetSelectOption[];
  selected: readonly string[];
  multi?: boolean;
  onPick: (value: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Two scrolls, in this order and for different reasons: bring the list itself
  // into view in the sheet (it just pushed the form down), then put the current
  // answer in front of the reader — eleven languages don't fit the five rows
  // the list is capped at, and "en" is not always among the first five.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollIntoView({ block: 'nearest' });
    const row = list.querySelector<HTMLElement>('.sheet-picker-row-on');
    if (row && list.scrollHeight > list.clientHeight) {
      list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
    }
  }, []);

  return (
    <div
      className="sheet-picker-list"
      role={multi ? 'group' : 'listbox'}
      aria-label={label}
      ref={listRef}
    >
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={on ? 'sheet-picker-row sheet-picker-row-on' : 'sheet-picker-row'}
            role={multi ? 'checkbox' : 'option'}
            aria-checked={multi ? on : undefined}
            aria-selected={multi ? undefined : on}
            onClick={() => onPick(o.value)}
          >
            {/* Every row leads with the same fixed slot, ticked or not, so a
                list of checkboxes and a list of choices have identical rows. */}
            {multi ? (
              <span className={`select-box${on ? ' checked' : ''}`} aria-hidden>
                {on && <Icon name="check" size={13} />}
              </span>
            ) : (
              <span className="sheet-picker-mark" aria-hidden>
                {on && <Icon name="check" size={14} />}
              </span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
