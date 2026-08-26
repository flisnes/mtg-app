import { compareCardTags, normalizeColors, type Color, type Finish, type OracleCard } from '@mtg/shared';
import { priceForFinish } from '../cardDb/prices.js';
import { UNTAGGED } from '../deck/tags.js';
import { getPrefs, type BaseCurrency } from '../prefs.js';
import { convertToDisplay, fmtConverted, fmtMoney } from '../price/rates.js';

// The pure half of the shared sort/group machinery: comparators, price
// resolution, grouping and land counting. No React, because the card-database
// search imports this and search.ts is reachable from a web worker — the hooks
// and the controls live next door in CardSorting.tsx.

export type SortKey = 'relevance' | 'name' | 'cmc' | 'price' | 'change' | 'changePct' | 'added' | 'updated';
export type SortDir = 'asc' | 'desc';
export type GroupKey = 'none' | 'type' | 'color' | 'tag';

export interface CardSortPrefs {
  key: SortKey;
  dir: SortDir;
  group: GroupKey;
}

export const DEFAULT_PREFS: CardSortPrefs = { key: 'name', dir: 'asc', group: 'none' };

// ---- Lists that aren't cards ----
// Sealed products and price movers sort by things no card row has (copies,
// release date, how notable a move is) and by nothing a card row does (mana
// value). They get their own key set and their own select rather than bending
// SortKey out of shape, but share the persistence and the direction button.

export interface ListSortPrefs<K extends string> {
  key: K;
  dir: SortDir;
}

// ---- Sorting ----

export interface SortFields {
  name?: string;
  cmc?: number;
  price?: number | null;
  /** Recorded price change (absolute / percent) — collection views only. */
  change?: number | null;
  changePct?: number | null;
  /** Epoch ms the card was added / last edited — collection views only. */
  added?: number | null;
  updated?: number | null;
}

/** The variant price fields carried on a joined (Priced) card row. */
interface FinishPriced {
  priceEur: number | null;
  priceUsd: number | null;
  priceEurFoil?: number | null;
  priceUsdFoil?: number | null;
  priceUsdEtched?: number | null;
  priceHasFoil?: boolean;
}

/**
 * Narrow a joined card row to the {priceEur, priceUsd} pair for a given finish,
 * so the sort/format/total helpers below show a foil entry its foil price
 * rather than the nonfoil one. Returns undefined for a missing row (the helpers
 * skip undefined sources). Nonfoil entries pass through unchanged.
 */
export function pricedForFinish<T extends FinishPriced>(
  row: T | undefined,
  finish: Finish,
): { priceEur: number | null; priceUsd: number | null } | undefined {
  if (!row) return undefined;
  const { eur, usd } = priceForFinish(
    {
      eur: row.priceEur,
      usd: row.priceUsd,
      eurFoil: row.priceEurFoil ?? null,
      usdFoil: row.priceUsdFoil ?? null,
      usdEtched: row.priceUsdEtched ?? null,
      hasFoil: row.priceHasFoil ?? false,
    },
    finish,
  );
  return { priceEur: eur, priceUsd: usd };
}

type PricedSource = { priceEur: number | null; priceUsd: number | null } | undefined;

/**
 * The first price available in the user's base currency, else the first in the
 * other one, tagged with which it is. Callers convert or format from there.
 */
function pickPrice(sources: PricedSource[]): { amount: number; currency: BaseCurrency } | null {
  const base = getPrefs().baseCurrency;
  const first = base === 'EUR' ? (s: NonNullable<PricedSource>) => s.priceEur : (s: NonNullable<PricedSource>) => s.priceUsd;
  const other = base === 'EUR' ? (s: NonNullable<PricedSource>) => s.priceUsd : (s: NonNullable<PricedSource>) => s.priceEur;
  const otherCurrency: BaseCurrency = base === 'EUR' ? 'USD' : 'EUR';
  for (const s of sources) if (s && first(s) != null) return { amount: first(s)!, currency: base };
  for (const s of sources) if (s && other(s) != null) return { amount: other(s)!, currency: otherCurrency };
  return null;
}

/**
 * Numeric price for sorting. Everything is normalised into the display currency
 * so a list mixing EUR-only and USD-only cards sorts by real value rather than
 * by which currency each card happened to be priced in.
 */
export function priceValue(...sources: PricedSource[]): number | null {
  const picked = pickPrice(sources);
  if (!picked) return null;
  return convertToDisplay(picked.amount, picked.currency) ?? picked.amount;
}

/** Display price in the user's currency; falls back to the raw quote when no rate is available. */
export function formatPrice(...sources: PricedSource[]): string | undefined {
  const picked = pickPrice(sources);
  if (!picked) return undefined;
  return fmtConverted(picked.amount, picked.currency) ?? fmtMoney(picked.amount, picked.currency);
}

// ---- Value totals ----
// Sums are kept per source currency, because a card may only be priced in one
// of the two. Formatting converts both into the display currency and adds them
// up; without a rate it falls back to reporting the two buckets side by side,
// which is what the app did before conversion existed.
export interface PriceTotal {
  eur: number;
  usd: number;
}

/** Add qty × per-card value into the matching currency bucket. */
export function addToTotal(total: PriceTotal, qty: number, ...sources: PricedSource[]): void {
  const picked = pickPrice(sources);
  if (!picked) return;
  if (picked.currency === 'EUR') total.eur += picked.amount * qty;
  else total.usd += picked.amount * qty;
}

/** Format a value total: one converted figure, or the raw buckets joined by "+". */
export function formatTotal({ eur, usd }: PriceTotal): string {
  if (eur <= 0 && usd <= 0) return '—';
  const convertedEur = eur > 0 ? convertToDisplay(eur, 'EUR') : 0;
  const convertedUsd = usd > 0 ? convertToDisplay(usd, 'USD') : 0;
  if (convertedEur != null && convertedUsd != null) {
    return fmtMoney(convertedEur + convertedUsd, getPrefs().displayCurrency);
  }
  // No usable rate — show what we know rather than nothing.
  const parts: string[] = [];
  if (eur > 0) parts.push(fmtMoney(eur, 'EUR'));
  if (usd > 0) parts.push(fmtMoney(usd, 'USD'));
  return parts.join(' + ');
}

export function sortCards<T>(items: T[], get: (t: T) => SortFields, prefs: Pick<CardSortPrefs, 'key' | 'dir'>): T[] {
  const mul = prefs.dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const fa = get(a);
    const fb = get(b);
    let cmp = 0;
    if (prefs.key === 'cmc') cmp = compareNullable(fa.cmc, fb.cmc, mul);
    else if (prefs.key === 'price') cmp = compareNullable(fa.price, fb.price, mul);
    else if (prefs.key === 'change') cmp = compareNullable(fa.change, fb.change, mul);
    else if (prefs.key === 'changePct') cmp = compareNullable(fa.changePct, fb.changePct, mul);
    else if (prefs.key === 'added') cmp = compareNullable(fa.added, fb.added, mul);
    else if (prefs.key === 'updated') cmp = compareNullable(fa.updated, fb.updated, mul);
    if (cmp === 0) {
      cmp = (fa.name ?? '').localeCompare(fb.name ?? '');
      if (prefs.key === 'name') cmp *= mul;
    }
    return cmp;
  });
}

// Missing values sort last regardless of direction.
export function compareNullable(a: number | null | undefined, b: number | null | undefined, mul: number): number {
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

export const COLOR_NAMES: Record<Color, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const COLOR_GROUP_ORDER = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Colorless', 'Land', 'Other'];

function typeGroup(typeLine: string | undefined): string {
  if (!typeLine) return 'Other';
  const front = typeLine.split('//')[0]!;
  for (const t of TYPE_PRIORITY) if (front.includes(t)) return t;
  return 'Other';
}

function colorGroup(card: GroupableCard | undefined): string {
  if (!card) return 'Other';
  // Normalized here too: card DBs built before the DFC dedupe store a
  // mono-colored double-faced card as e.g. ['G','G'].
  const colors = normalizeColors(card.colors);
  if (colors.length > 1) return 'Multicolor';
  if (colors.length === 1) return COLOR_NAMES[colors[0]!];
  return card.typeLine.split('//')[0]!.includes('Land') ? 'Land' : 'Colorless';
}

/**
 * Group by the slot's own tags. A card wearing three tags shows up under all
 * three: a tag is a set the card is genuinely a member of (which is exactly
 * what the hypergeometric sample sizes will read), so hiding it from two of
 * them would lie about the deck. The consequence is that group counts add up to
 * more than the list when tags overlap — the boards say so out loud rather than
 * quietly reconciling it. Untagged cards land in one heading at the bottom.
 */
function groupByTag<T>(items: T[], getTags?: (t: T) => string[] | undefined): { label: string; items: T[] }[] {
  const buckets = new Map<string, { label: string; items: T[] }>();
  const untagged: T[] = [];
  for (const it of items) {
    const tags = getTags?.(it) ?? [];
    if (tags.length === 0) {
      untagged.push(it);
      continue;
    }
    for (const t of tags) {
      const key = t.toLocaleLowerCase();
      const bucket = buckets.get(key);
      if (bucket) bucket.items.push(it);
      else buckets.set(key, { label: t, items: [it] });
    }
  }
  const groups = [...buckets.values()].sort((a, b) => compareCardTags(a.label, b.label));
  if (untagged.length) groups.push({ label: UNTAGGED, items: untagged });
  return groups;
}

/** Partition into labelled groups in canonical order; empty groups are omitted. */
export function groupCards<T>(
  items: T[],
  getCard: (t: T) => GroupableCard | undefined,
  group: Exclude<GroupKey, 'none'>,
  /** Slot tags, required for group === 'tag' (views without tags never offer it). */
  getTags?: (t: T) => string[] | undefined,
): { label: string; items: T[] }[] {
  if (group === 'tag') return groupByTag(items, getTags);
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

// ---- Land counting ----

/** Enough of a card to tell whether it can make a land drop. */
type LandishCard = Pick<OracleCard, 'name' | 'typeLine'> & { layout?: string };

/** One extra land source, aggregated by name across the board's rows. */
export interface ExtraLand {
  name: string;
  quantity: number;
}

/**
 * A land the type grouping filed somewhere else: Dryad Arbor sitting under
 * Creature, or the back half of a modal double-faced card (Malakir Mire). Both
 * still make land drops, so the Land heading counts them in its second number.
 * Transform backs (Itlimoc, Cradle of the Sun) do not — you cast the front, you
 * never play those as a land.
 */
export function isExtraLand(card: LandishCard | undefined): boolean {
  if (!card) return false;
  // Anything the heading already counted isn't extra.
  if (typeGroup(card.typeLine) === 'Land') return false;
  const faces = card.typeLine.split('//');
  if (/\bLand\b/.test(faces[0]!)) return true;
  // layout is absent on card DBs built before it existed; count the back face
  // then rather than silently dropping every MDFC land.
  if (card.layout && card.layout !== 'modal_dfc') return false;
  return faces.slice(1).some((f) => /\bLand\b/.test(f));
}

/** The extra land sources among these rows, by name, most copies first. */
export function extraLands<T>(
  items: T[],
  getCard: (t: T) => LandishCard | undefined,
  getQty: (t: T) => number,
): ExtraLand[] {
  const byName = new Map<string, number>();
  for (const it of items) {
    const card = getCard(it);
    if (!isExtraLand(card)) continue;
    // Full name, both faces — same as the row in the list, and the land face is
    // the half that earns the card its place here.
    byName.set(card!.name, (byName.get(card!.name) ?? 0) + getQty(it));
  }
  return [...byName]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}
