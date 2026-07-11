import { useState } from 'react';
import type { Color, OracleCard } from '@mtg/shared';

// Shared sort/group machinery for every card list in the app (decks,
// collection, tradelist, wishlist). Views adapt their row shape via a small
// accessor instead of conforming to one interface, and each view persists its
// own preference under `cardSort:<key>` (localStorage, synchronous — same
// pattern as useViewMode).

export type SortKey = 'name' | 'cmc' | 'price';
export type SortDir = 'asc' | 'desc';
export type GroupKey = 'none' | 'type' | 'color';

export interface CardSortPrefs {
  key: SortKey;
  dir: SortDir;
  group: GroupKey;
}

const DEFAULT_PREFS: CardSortPrefs = { key: 'name', dir: 'asc', group: 'none' };

export function useCardSort(storageKey: string, defaults?: Partial<CardSortPrefs>): [CardSortPrefs, (p: CardSortPrefs) => void] {
  const full = `cardSort:${storageKey}`;
  const [prefs, setPrefs] = useState<CardSortPrefs>(() => {
    try {
      const raw = localStorage.getItem(full);
      if (raw) return { ...DEFAULT_PREFS, ...defaults, ...(JSON.parse(raw) as Partial<CardSortPrefs>) };
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_PREFS, ...defaults };
  });
  const set = (p: CardSortPrefs) => {
    setPrefs(p);
    try {
      localStorage.setItem(full, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  };
  return [prefs, set];
}

// ---- Sorting ----

export interface SortFields {
  name?: string;
  cmc?: number;
  price?: number | null;
}

/** Numeric price for sorting/display: EUR from any source, else USD (matches priceOf). */
export function priceValue(...sources: ({ priceEur: number | null; priceUsd: number | null } | undefined)[]): number | null {
  for (const s of sources) if (s?.priceEur != null) return s.priceEur;
  for (const s of sources) if (s?.priceUsd != null) return s.priceUsd;
  return null;
}

export function sortCards<T>(items: T[], get: (t: T) => SortFields, prefs: Pick<CardSortPrefs, 'key' | 'dir'>): T[] {
  const mul = prefs.dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const fa = get(a);
    const fb = get(b);
    let cmp = 0;
    if (prefs.key === 'cmc') cmp = compareNullable(fa.cmc, fb.cmc, mul);
    else if (prefs.key === 'price') cmp = compareNullable(fa.price, fb.price, mul);
    if (cmp === 0) {
      cmp = (fa.name ?? '').localeCompare(fb.name ?? '');
      if (prefs.key === 'name') cmp *= mul;
    }
    return cmp;
  });
}

// Missing values sort last regardless of direction.
function compareNullable(a: number | null | undefined, b: number | null | undefined, mul: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * mul;
}

// ---- Grouping ----

type GroupableCard = Pick<OracleCard, 'colors' | 'typeLine'>;

// Classification checks Land before Artifact/Enchantment so "Artifact Land"
// lands in Land, but after Creature so Dryad Arbor stays a creature.
const TYPE_PRIORITY = ['Creature', 'Planeswalker', 'Battle', 'Land', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'];
const TYPE_GROUP_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];

const COLOR_NAMES: Record<Color, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const COLOR_GROUP_ORDER = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Colorless', 'Land', 'Other'];

export function typeGroup(typeLine: string | undefined): string {
  if (!typeLine) return 'Other';
  const front = typeLine.split('//')[0]!;
  for (const t of TYPE_PRIORITY) if (front.includes(t)) return t;
  return 'Other';
}

export function colorGroup(card: GroupableCard | undefined): string {
  if (!card) return 'Other';
  if (card.colors.length > 1) return 'Multicolor';
  if (card.colors.length === 1) return COLOR_NAMES[card.colors[0]!];
  return card.typeLine.split('//')[0]!.includes('Land') ? 'Land' : 'Colorless';
}

/** Partition into labelled groups in canonical order; empty groups are omitted. */
export function groupCards<T>(
  items: T[],
  getCard: (t: T) => GroupableCard | undefined,
  group: Exclude<GroupKey, 'none'>,
): { label: string; items: T[] }[] {
  const order = group === 'type' ? TYPE_GROUP_ORDER : COLOR_GROUP_ORDER;
  const labelOf = group === 'type' ? (t: T) => typeGroup(getCard(t)?.typeLine) : (t: T) => colorGroup(getCard(t));
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const label = labelOf(it);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(it);
    else buckets.set(label, [it]);
  }
  return order.filter((l) => buckets.has(l)).map((l) => ({ label: l, items: buckets.get(l)! }));
}

// ---- UI ----

const SORT_OPTIONS: [SortKey, string][] = [
  ['name', 'Sort: Name'],
  ['cmc', 'Sort: Mana value'],
  ['price', 'Sort: Price'],
];
const GROUP_OPTIONS: [GroupKey, string][] = [
  ['none', 'Group: None'],
  ['type', 'Group: Card type'],
  ['color', 'Group: Color'],
];

export function SortControls({
  prefs,
  onChange,
  groups = false,
}: {
  prefs: CardSortPrefs;
  onChange: (p: CardSortPrefs) => void;
  /** Show the group-by select (deck views). */
  groups?: boolean;
}) {
  const asc = prefs.dir === 'asc';
  return (
    <div className="sort-controls" role="group" aria-label="Sort and group">
      {groups && (
        <select value={prefs.group} onChange={(e) => onChange({ ...prefs, group: e.target.value as GroupKey })} aria-label="Group by">
          {GROUP_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
      <select value={prefs.key} onChange={(e) => onChange({ ...prefs, key: e.target.value as SortKey })} aria-label="Sort by">
        {SORT_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        className="sort-dir"
        onClick={() => onChange({ ...prefs, dir: asc ? 'desc' : 'asc' })}
        title={asc ? 'Ascending — tap for descending' : 'Descending — tap for ascending'}
        aria-label={asc ? 'Sort ascending' : 'Sort descending'}
      >
        {asc ? '↑' : '↓'}
      </button>
    </div>
  );
}
