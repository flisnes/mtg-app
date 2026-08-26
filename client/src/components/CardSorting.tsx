import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';
import {
  DEFAULT_PREFS,
  type CardSortPrefs,
  type GroupKey,
  type ListSortPrefs,
  type ExtraLand,
  type SortDir,
  type SortKey,
} from './cardSort.js';

// Sort/group controls, and the per-view persistence behind them. Every card
// list in the app (decks, collection, tradelist, wishlist, card search) renders
// these; each persists its own preference under `cardSort:<key>`
// (localStorage, synchronous — same pattern as useViewMode). The comparators
// and grouping they drive live in cardSort.ts.

export * from './cardSort.js';

// Two components can be holding the same key at once — a list page and the
// search overlay scoped into that very list, which is stacked on top of it.
// Writes are broadcast so the one underneath isn't left showing the old order
// when the overlay closes.
const listeners = new Map<string, Set<(v: never) => void>>();

/** Read-through localStorage state; a stored partial is merged over the initial. */
function usePersisted<T extends object>(full: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(full);
      if (raw) return { ...initial, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      /* ignore */
    }
    return initial;
  });

  useEffect(() => {
    const peers = listeners.get(full) ?? new Set();
    peers.add(setValue as (v: never) => void);
    listeners.set(full, peers);
    return () => {
      peers.delete(setValue as (v: never) => void);
      if (peers.size === 0) listeners.delete(full);
    };
  }, [full]);

  const set = (v: T) => {
    setValue(v);
    // Own setter is in the set too once the effect has run; skip it rather than
    // queue the same update twice.
    for (const peer of listeners.get(full) ?? []) if (peer !== (setValue as unknown)) (peer as (x: T) => void)(v);
    try {
      localStorage.setItem(full, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  };
  return [value, set];
}

export function useCardSort(storageKey: string, defaults?: Partial<CardSortPrefs>): [CardSortPrefs, (p: CardSortPrefs) => void] {
  return usePersisted(`cardSort:${storageKey}`, { ...DEFAULT_PREFS, ...defaults });
}

export function useListSort<K extends string>(
  storageKey: string,
  defaults: ListSortPrefs<K>,
): [ListSortPrefs<K>, (p: ListSortPrefs<K>) => void] {
  return usePersisted(`listSort:${storageKey}`, defaults);
}

// ---- UI ----

// Card-database search only: how well the card matches what was typed. Owned
// lists have no query to be relevant to, so they never offer it.
const RELEVANCE_OPTION: [SortKey, string] = ['relevance', 'Sort: Best match'];
const SORT_OPTIONS: [SortKey, string][] = [
  ['name', 'Sort: Name'],
  ['cmc', 'Sort: Mana value'],
  ['price', 'Sort: Price'],
];
// Only where recorded price history is wired up (collection/tradelist).
const CHANGE_OPTIONS: [SortKey, string][] = [
  ['change', 'Sort: Price change'],
  ['changePct', 'Sort: Price change %'],
];
// Only where entries carry createdAt/updatedAt (collection/tradelist).
const DATE_OPTIONS: [SortKey, string][] = [
  ['added', 'Sort: Date added'],
  ['updated', 'Sort: Last edited'],
];
const GROUP_OPTIONS: [GroupKey, string][] = [
  ['none', 'Group: None'],
  ['type', 'Group: Card type'],
  ['color', 'Group: Color'],
];
// Only where the rows carry slot tags (your own containers — not a shared deck).
const TAG_GROUP_OPTION: [GroupKey, string] = ['tag', 'Group: Tag'];

export function SortControls({
  prefs,
  onChange,
  groups = false,
  tagGroups = false,
  withRelevance = false,
  withChange = false,
  withDates = false,
}: {
  prefs: CardSortPrefs;
  onChange: (p: CardSortPrefs) => void;
  /** Show the group-by select (deck views). */
  groups?: boolean;
  /** Also offer group-by-tag (views that hand groupCards a getTags accessor). */
  tagGroups?: boolean;
  /** Offer best-match sorting (card-database search, which has a query to rank against). */
  withRelevance?: boolean;
  /** Offer price-change sorts (views that supply SortFields.change). */
  withChange?: boolean;
  /** Offer date-added / last-edited sorts (views that supply SortFields.added/updated). */
  withDates?: boolean;
}) {
  const sortOptions = [
    ...(withRelevance ? [RELEVANCE_OPTION] : []),
    ...SORT_OPTIONS,
    ...(withChange ? CHANGE_OPTIONS : []),
    ...(withDates ? DATE_OPTIONS : []),
  ];
  const groupOptions = tagGroups ? [...GROUP_OPTIONS, TAG_GROUP_OPTION] : GROUP_OPTIONS;
  return (
    <div className="sort-controls" role="group" aria-label="Sort and group">
      {groups && (
        <select value={prefs.group} onChange={(e) => onChange({ ...prefs, group: e.target.value as GroupKey })} aria-label="Group by">
          {groupOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
      <select value={prefs.key} onChange={(e) => onChange({ ...prefs, key: e.target.value as SortKey })} aria-label="Sort by">
        {sortOptions.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <SortDirButton dir={prefs.dir} onChange={(dir) => onChange({ ...prefs, dir })} />
    </div>
  );
}

/** The same sort select + direction button, for a list with its own key set. */
export function ListSortControls<K extends string>({
  prefs,
  onChange,
  options,
}: {
  prefs: ListSortPrefs<K>;
  onChange: (p: ListSortPrefs<K>) => void;
  options: [K, string][];
}) {
  return (
    <div className="sort-controls" role="group" aria-label="Sort">
      <select value={prefs.key} onChange={(e) => onChange({ ...prefs, key: e.target.value as K })} aria-label="Sort by">
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <SortDirButton dir={prefs.dir} onChange={(dir) => onChange({ ...prefs, dir })} />
    </div>
  );
}

function SortDirButton({ dir, onChange }: { dir: SortDir; onChange: (d: SortDir) => void }) {
  const asc = dir === 'asc';
  return (
    <button
      className="sort-dir"
      onClick={() => onChange(asc ? 'desc' : 'asc')}
      title={asc ? 'Ascending' : 'Descending'}
      aria-label={asc ? 'Sort ascending' : 'Sort descending'}
    >
      {asc ? '↑' : '↓'}
    </button>
  );
}

/**
 * A group heading's count. The Land heading gets a second number behind it when
 * the deck has land sources filed under other types — "24 (26)" reads as "24
 * cards in the Land pile, 26 things that can make a land drop" — and the (i)
 * names them, so the bigger number isn't magic.
 */
export function GroupCountBadge({ quantity, extras }: { quantity: number; extras?: ExtraLand[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const extraQty = (extras ?? []).reduce((s, e) => s + e.quantity, 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (extraQty === 0) return <span className="badge">{quantity}</span>;
  return (
    <>
      <span className="badge">{quantity}</span>{' '}
      <span className="land-extra" ref={ref}>
        <button
          className="land-extra-info"
          aria-label="What else counts as a land"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="What else counts as a land"
        >
          ({quantity + extraQty}
          <Icon name="about" size={13} />)
        </button>
        {open && (
          <span className="land-extra-pop" role="tooltip">
            <span className="land-extra-pop-title">Also counted</span>
            {(extras ?? []).map((e) => (
              <span key={e.name} className="land-extra-pop-row">
                {e.quantity > 1 && <span className="land-extra-pop-qty">{e.quantity}×</span>}
                {e.name}
              </span>
            ))}
          </span>
        )}
      </span>
    </>
  );
}
