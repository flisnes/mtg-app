import type { OracleCard, Priced, Printing, SpecialCondition } from '@mtg/shared';
import { normalizeSpecialConditions, type SetTypeMap } from '@mtg/shared';
import { pickOwnedPrinting } from '../cardDb/preferredPrinting.js';
import type { JoinedEntry } from '../db/queries.js';
import type { PlacementIndex, PlacementInfo } from '../db/usePlacements.js';
import type { Prefs } from '../prefs.js';
import { valueKeyOf } from '../price/collectionValue.js';
import { convertToDisplay } from '../price/rates.js';
import { addToTotal, pricedForFinish, releaseFields, type PriceTotal, type SortFields } from './cardSort.js';
import type { EntrySortData } from './useEntrySort.js';

// Stacking printings: the collection's rows are one per piece of cardboard
// (printing × condition × finish × language × special), and that is what the
// list shows by default. With the stack toggle on, every row of one card folds
// into a single EntryStack keyed by oracleId, so ten Lightning Bolts across
// Beta, Modern Masters and M10 read as "×10" on one tile.
//
// Pure: no React, no Dexie. The rows already carry their printing, so the
// edition a stack shows is picked from those (pickOwnedPrinting) and nothing
// extra is read. The stack keeps its member rows, in shown-printing-first
// order, so tapping it opens the copy on the tile and the sheet can step to
// the others, and so the bulk actions can fan a selected stack back out into
// the rows they actually write.
//
// With the toggle off the same function hands back one stack per row, keyed
// by the row id: the list renders one shape either way and nothing downstream
// has to know which mode it is in.

export interface EntryStack {
  /** The row id when it stands for one row; `s:<oracleId>` for a real stack. */
  key: string;
  oracleId: string;
  oracle?: Priced<OracleCard>;
  /** The edition on the tile: the preferred one among those you own. */
  printing?: Priced<Printing>;
  /** Every row folded in, the shown printing's rows first. Never empty. */
  members: JoinedEntry[];
  /** Copies, summed over the members. */
  quantity: number;
  quantityForTrade: number;
  /** Distinct editions among the members. */
  printingCount: number;
  /** At least one member is a foil or etched copy. */
  foil: boolean;
  /** Languages held, in first-seen order. */
  langs: string[];
  /** Union of the members' special conditions. */
  special: SpecialCondition[];
  /** What all the copies are worth, qty × each copy's own finish price. */
  value: PriceTotal;
  /** Earliest added and latest edited across the members. */
  added: number | null;
  updated: number | null;
}

interface StackOptions {
  /** Off: one stack per row, in the given order. */
  stack: boolean;
  prefs: Pick<Prefs, 'printing' | 'baseCurrency'>;
  /** For the "ordinary printing" rules' promo check; null falls back to the per-card flag. */
  setTypes: SetTypeMap | null;
}

function single(r: JoinedEntry): EntryStack {
  const value: PriceTotal = { eur: 0, usd: 0 };
  addToTotal(value, r.entry.quantity, pricedForFinish(r.printing, r.entry.finish), r.oracle);
  return {
    key: r.entry.id,
    oracleId: r.entry.oracleId,
    oracle: r.oracle,
    printing: r.printing,
    members: [r],
    quantity: r.entry.quantity,
    quantityForTrade: r.entry.quantityForTrade,
    printingCount: 1,
    foil: r.entry.finish !== 'nonfoil',
    langs: [r.entry.lang],
    special: r.entry.special ?? [],
    value,
    added: r.entry.createdAt ?? null,
    updated: r.entry.updatedAt ?? null,
  };
}

/** Fold joined collection rows into stacks (or wrap each as its own). */
export function stackEntries(rows: JoinedEntry[], opts: StackOptions): EntryStack[] {
  if (!opts.stack) return rows.map(single);
  const byOracle = new Map<string, JoinedEntry[]>();
  for (const r of rows) {
    const list = byOracle.get(r.entry.oracleId);
    if (list) list.push(r);
    else byOracle.set(r.entry.oracleId, [r]);
  }
  const out: EntryStack[] = [];
  byOracle.forEach((members, oracleId) => {
    if (members.length === 1) {
      out.push({ ...single(members[0]!), key: `s:${oracleId}` });
      return;
    }
    const printings = new Map<string, Priced<Printing>>();
    for (const m of members) if (m.printing) printings.set(m.printing.scryfallId, m.printing);
    const shown = pickOwnedPrinting([...printings.values()], opts.prefs, opts.setTypes);
    // The shown printing's rows lead, so members[0] is the copy on the tile.
    const ordered = shown
      ? [...members.filter((m) => m.entry.scryfallId === shown.scryfallId), ...members.filter((m) => m.entry.scryfallId !== shown.scryfallId)]
      : members;
    const value: PriceTotal = { eur: 0, usd: 0 };
    const langs: string[] = [];
    let special: SpecialCondition[] = [];
    let quantity = 0;
    let quantityForTrade = 0;
    let foil = false;
    let added: number | null = null;
    let updated: number | null = null;
    for (const m of ordered) {
      quantity += m.entry.quantity;
      quantityForTrade += m.entry.quantityForTrade;
      if (m.entry.finish !== 'nonfoil') foil = true;
      if (!langs.includes(m.entry.lang)) langs.push(m.entry.lang);
      if (m.entry.special?.length) special = normalizeSpecialConditions([...special, ...m.entry.special]) ?? special;
      addToTotal(value, m.entry.quantity, pricedForFinish(m.printing, m.entry.finish), m.oracle);
      const c = m.entry.createdAt ?? null;
      const u = m.entry.updatedAt ?? null;
      if (c != null && (added == null || c < added)) added = c;
      if (u != null && (updated == null || u > updated)) updated = u;
    }
    out.push({
      key: `s:${oracleId}`,
      oracleId,
      oracle: ordered[0]!.oracle,
      printing: shown ?? ordered[0]!.printing,
      members: ordered,
      quantity,
      quantityForTrade,
      printingCount: new Set(members.map((m) => m.entry.scryfallId)).size,
      foil,
      langs,
      special,
      value,
      added,
      updated,
    });
  });
  return out;
}

/** A value total as one number in the display currency, for sorting. */
function totalValueNumber({ eur, usd }: PriceTotal): number | null {
  if (eur <= 0 && usd <= 0) return null;
  const e = eur > 0 ? convertToDisplay(eur, 'EUR') ?? eur : 0;
  const u = usd > 0 ? convertToDisplay(usd, 'USD') ?? usd : 0;
  return e + u;
}

/**
 * Sort fields for a stack. A single-row stack sorts exactly as its row did
 * (price is one copy's price, not qty × price), so turning stacking off
 * changes nothing about the order. A real stack sorts by what the whole pile
 * is worth, when the first of it arrived, when any of it was last touched,
 * and the release of the edition on the tile.
 */
export function stackSortFields(s: EntryStack, data: EntrySortData): SortFields {
  if (s.members.length === 1) {
    const r = s.members[0]!;
    const change = data.changes?.get(valueKeyOf(r.entry.scryfallId, r.entry.finish));
    return {
      name: r.oracle?.name,
      cmc: r.oracle?.cmc,
      price: priceOfOne(r),
      change: change?.delta ?? null,
      changePct: change?.pct ?? null,
      added: r.entry.createdAt,
      updated: r.entry.updatedAt,
      ...releaseFields(r.printing),
    };
  }
  // Value change: each copy's recorded change times the copies held, summed;
  // the percent is the copies-weighted mean so a stack of one pricey mover and
  // nine bulk copies doesn't read as a 40% jump.
  let delta: number | null = null;
  let pctSum = 0;
  let pctWeight = 0;
  for (const m of s.members) {
    const c = data.changes?.get(valueKeyOf(m.entry.scryfallId, m.entry.finish));
    if (!c) continue;
    delta = (delta ?? 0) + c.delta * m.entry.quantity;
    if (c.pct != null) {
      pctSum += c.pct * m.entry.quantity;
      pctWeight += m.entry.quantity;
    }
  }
  return {
    name: s.oracle?.name,
    cmc: s.oracle?.cmc,
    price: totalValueNumber(s.value),
    change: delta,
    changePct: pctWeight > 0 ? pctSum / pctWeight : null,
    added: s.added,
    updated: s.updated,
    ...releaseFields(s.printing),
  };
}

function priceOfOne(r: JoinedEntry): number | null {
  const t: PriceTotal = { eur: 0, usd: 0 };
  addToTotal(t, 1, pricedForFinish(r.printing, r.entry.finish), r.oracle);
  return totalValueNumber(t);
}

/**
 * Where a stack's copies are filed, as one PlacementInfo: every member's own
 * lookup (narrowed to that piece of cardboard) merged by container, so the
 * badge counts containers once and the ⚠ fires if any copy is over-filed.
 */
export function stackPlacement(s: EntryStack, placements: PlacementIndex | undefined): PlacementInfo | undefined {
  if (!placements) return undefined;
  const lookups = s.members.map((m) =>
    placements.lookup(m.entry.oracleId, m.entry.scryfallId, {
      condition: m.entry.condition,
      finish: m.entry.finish,
      lang: m.entry.lang,
    }),
  );
  if (lookups.length === 1) return lookups[0];
  const byContainer = new Map<string, PlacementInfo['places'][number]>();
  let claimed = 0;
  let owned = 0;
  let over = false;
  for (const info of lookups) {
    claimed += info.claimed;
    owned += info.owned;
    over ||= info.over;
    for (const p of info.places) {
      const have = byContainer.get(p.containerId);
      if (have) byContainer.set(p.containerId, { ...have, quantity: have.quantity + p.quantity, backed: have.backed + p.backed });
      else byContainer.set(p.containerId, { ...p });
    }
  }
  return { places: [...byContainer.values()], claimed, owned, over };
}
