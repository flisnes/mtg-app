import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';
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
//
// One button per toolbar, reading "Price ↓" (or "Price ↓ · Type" when grouped),
// that opens a sheet of chip rows: sort key, direction, group, and whatever
// filter the list adds. Three selects and an arrow used to sit in the toolbar
// itself and ate two rows of a phone screen above the first card; the toolbar
// now spends that space on the cards and the sheet spells the choices out in
// full when they're wanted.

// Card-database search only: how well the card matches what was typed. Owned
// lists have no query to be relevant to, so they never offer it.
const RELEVANCE_OPTION: [SortKey, string] = ['relevance', 'Best match'];
const SORT_OPTIONS: [SortKey, string][] = [
  ['name', 'Name'],
  ['cmc', 'Mana value'],
  ['price', 'Price'],
];
// Only where recorded price history is wired up (collection/tradelist). Called
// "value change" rather than "price change" because it isn't the card's move on
// the market, it's what your copies have done since they cost you what they
// cost: the same figure the card sheet shows. Market moves over a comparable
// window live on the Price movers page.
const CHANGE_OPTIONS: [SortKey, string][] = [
  ['change', 'Value change'],
  ['changePct', 'Value change %'],
];
// Only where entries carry createdAt/updatedAt (collection/tradelist).
const DATE_OPTIONS: [SortKey, string][] = [
  ['added', 'Date added'],
  ['updated', 'Last edited'],
];
// When the cardboard came out. Every list that shows a printing can offer it,
// including the card database — there it means the card's debut rather than the
// printing you hold, which is the only release date a card you don't own has.
const RELEASE_OPTION: [SortKey, string] = ['released', 'Release date'];
const GROUP_OPTIONS: [GroupKey, string][] = [
  ['none', 'None'],
  ['type', 'Card type'],
  ['color', 'Color'],
];
// Only where the rows carry slot tags (your own containers — not a shared deck).
const TAG_GROUP_OPTION: [GroupKey, string] = ['tag', 'Tag'];

const DIR_OPTIONS: [SortDir, string][] = [
  ['asc', '↑ Ascending'],
  ['desc', '↓ Descending'],
];

/** One row of the sort sheet: a label and a set of chips, one of them lit. */
export function OptionChips<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (v: V) => void;
}) {
  return (
    <div className="opt-row" role="radiogroup" aria-label={label}>
      <span className="opt-label">{label}</span>
      <div className="opt-chips">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            className={`opt-chip${value === v ? ' active' : ''}`}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The toolbar button and the sheet it opens. `summary` is what the button
 * reads; `filtering` lights it the way a filter-on select used to light up, so
 * a short list is never a mystery. The rows are the children.
 */
function SortSheetButton({
  summary,
  filtering = false,
  children,
}: {
  summary: ReactNode;
  filtering?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`sort-btn${filtering ? ' filter-on' : ''}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Sort and filter"
      >
        <Icon name="sliders" size={15} />
        <span className="sort-btn-text">{summary}</span>
      </button>
      {open && (
        <Sheet onClose={() => setOpen(false)} title="Sort and filter" className="sort-sheet">
          {children}
          <div className="sheet-actions">
            <button type="button" className="primary" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function labelFor<K extends string>(options: readonly (readonly [K, string])[], key: K): string {
  return options.find(([k]) => k === key)?.[1] ?? key;
}

export function SortControls({
  prefs,
  onChange,
  groups = false,
  tagGroups = false,
  withRelevance = false,
  withChange = false,
  withDates = false,
  withRelease = false,
  filtering = false,
  filters,
}: {
  prefs: CardSortPrefs;
  onChange: (p: CardSortPrefs) => void;
  /** Show the group-by row (deck views). */
  groups?: boolean;
  /** Also offer group-by-tag (views that hand groupCards a getTags accessor). */
  tagGroups?: boolean;
  /** Offer best-match sorting (card-database search, which has a query to rank against). */
  withRelevance?: boolean;
  /** Offer price-change sorts (views that supply SortFields.change). */
  withChange?: boolean;
  /** Offer date-added / last-edited sorts (views that supply SortFields.added/updated). */
  withDates?: boolean;
  /** Offer the release-date sort (views that supply SortFields.released). */
  withRelease?: boolean;
  /** A filter in `filters` is hiding rows: the button says so. */
  filtering?: boolean;
  /** The list's own filter rows (OptionChips), shown above the sort rows. */
  filters?: ReactNode;
}) {
  const sortOptions = [
    ...(withRelevance ? [RELEVANCE_OPTION] : []),
    ...SORT_OPTIONS,
    ...(withChange ? CHANGE_OPTIONS : []),
    ...(withDates ? DATE_OPTIONS : []),
    ...(withRelease ? [RELEASE_OPTION] : []),
  ];
  const groupOptions = tagGroups ? [...GROUP_OPTIONS, TAG_GROUP_OPTION] : GROUP_OPTIONS;
  const grouped = groups && prefs.group !== 'none';
  const summary = (
    <>
      {labelFor(sortOptions, prefs.key)} {prefs.dir === 'asc' ? '↑' : '↓'}
      {grouped && <span className="sort-btn-group"> · {labelFor(groupOptions, prefs.group)}</span>}
    </>
  );
  return (
    <SortSheetButton summary={summary} filtering={filtering}>
      {filters}
      <OptionChips label="Sort by" value={prefs.key} options={sortOptions} onChange={(key) => onChange({ ...prefs, key })} />
      <OptionChips label="Direction" value={prefs.dir} options={DIR_OPTIONS} onChange={(dir) => onChange({ ...prefs, dir })} />
      {groups && (
        <OptionChips label="Group by" value={prefs.group} options={groupOptions} onChange={(group) => onChange({ ...prefs, group })} />
      )}
    </SortSheetButton>
  );
}

/** The same button and sheet, for a list with its own key set. */
export function ListSortControls<K extends string>({
  prefs,
  onChange,
  options,
}: {
  prefs: ListSortPrefs<K>;
  onChange: (p: ListSortPrefs<K>) => void;
  options: [K, string][];
}) {
  const summary = (
    <>
      {labelFor(options, prefs.key)} {prefs.dir === 'asc' ? '↑' : '↓'}
    </>
  );
  return (
    <SortSheetButton summary={summary}>
      <OptionChips label="Sort by" value={prefs.key} options={options} onChange={(key) => onChange({ ...prefs, key })} />
      <OptionChips label="Direction" value={prefs.dir} options={DIR_OPTIONS} onChange={(dir) => onChange({ ...prefs, dir })} />
    </SortSheetButton>
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
