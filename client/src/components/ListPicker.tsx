import { useState, type ReactNode } from 'react';
import { Loading } from './Loading.js';
import { MenuRow, type MenuRowProps } from './MenuRow.js';
import { Sheet } from './Sheet.js';
import { useAsyncAction } from './useAsyncAction.js';

/**
 * The pick-one-from-a-list shape the container, folder, set and card pickers
 * all share: an optional search box, a scrolling `.menu-list` of rows, an
 * optional "name it, create it" toolbar, and an action row ending in Cancel.
 * The caller owns the data and the query; this owns the layout.
 */
export interface ListPickerProps<T> {
  /** undefined while loading. */
  items: readonly T[] | undefined;
  itemKey: (item: T) => string;
  /** The row for one item; ListPicker supplies the click. */
  render: (item: T) => Omit<MenuRowProps, 'onClick' | 'to'>;
  onPick: (item: T) => void;
  search?: { value: string; onChange: (q: string) => void; placeholder: string; autoFocus?: boolean };
  /** Between the search box and the list (kind tabs, a color row). */
  head?: ReactNode;
  /** Fixed rows above the items, as `<li>`s ("No folder"). */
  lead?: ReactNode;
  /** Shown instead of the list when there are no items. */
  empty?: ReactNode;
  /** Class on the scrolling wrapper around the list. */
  scrollClassName?: string;
  /** A "name it, create it" toolbar under the list. */
  create?: {
    placeholder: string;
    /** The button ("Create & move"). */
    label: string;
    /** For the error toast: "create the folder". */
    what: string;
    onCreate: (name: string) => Promise<void>;
  };
  /** Buttons before Cancel. */
  actions?: ReactNode;
  /** Renders the action row with a Cancel button; leave out when the host has its own. */
  onCancel?: () => void;
  cancelLabel?: string;
}

export function ListPicker<T>({
  items,
  itemKey,
  render,
  onPick,
  search,
  head,
  lead,
  empty,
  scrollClassName,
  create,
  actions,
  onCancel,
  cancelLabel = 'Cancel',
}: ListPickerProps<T>) {
  return (
    <>
      {search && (
        <input
          className="search-input"
          type="search"
          placeholder={search.placeholder}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          aria-label={search.placeholder.replace(/…$/, '')}
          autoFocus={search.autoFocus}
        />
      )}
      {head}
      <div className={scrollClassName}>
        {items === undefined ? (
          <Loading />
        ) : items.length === 0 && !lead ? (
          empty
        ) : (
          <ul className="menu-list">
            {lead}
            {items.map((item) => (
              <li key={itemKey(item)}>
                <MenuRow {...render(item)} onClick={() => onPick(item)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {create && <CreateToolbar {...create} />}
      {(actions || onCancel) && (
        <div className="sheet-actions">
          {actions}
          {onCancel && <button onClick={onCancel}>{cancelLabel}</button>}
        </div>
      )}
    </>
  );
}

function CreateToolbar({ placeholder, label, what, onCreate }: NonNullable<ListPickerProps<unknown>['create']>) {
  const action = useAsyncAction();
  const [name, setName] = useState('');
  const submit = () =>
    action.run(what, async () => {
      await onCreate(name);
      setName('');
    });
  return (
    <div className="list-toolbar">
      <input
        className="search-input grow"
        placeholder={placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        aria-label={placeholder.replace(/…$/, '')}
      />
      <button className="primary" onClick={submit}>
        {label}
      </button>
    </div>
  );
}

/** ListPicker in its own sheet, Cancel closing it. */
export function ListPickerSheet<T>({
  title,
  label,
  className,
  onClose,
  ...picker
}: Omit<ListPickerProps<T>, 'onCancel'> & {
  title: ReactNode;
  label?: string;
  className?: string;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} title={title} label={label} className={className}>
      <ListPicker {...picker} onCancel={onClose} />
    </Sheet>
  );
}
