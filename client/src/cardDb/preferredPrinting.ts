import type { Priced, Printing, SetTypeMap } from '@mtg/shared';
import { isVariantPrinting } from '@mtg/shared';
import { db } from '../db/schema.js';
import type { OwnershipIndex } from '../db/useOwnership.js';
import { getPrefs, type Prefs, type PrintingPref } from '../prefs.js';
import { getPricesByIds, withPrices } from './prices.js';
import { isPromoPrinting, loadSetTypes } from './setTypes.js';

// Which printing stands in for a card when the user hasn't picked one.
//
// The card DB already bakes one representative per oracle card into
// OracleCard.imageSmall/defaultScryfallId — the newest English printing with an
// image (pipeline/src/slim.ts betterRepresentative). That's the 'latest'
// preference, and it costs nothing because it's already on the row we have.
//
// Any other preference has to look at the actual printings, so it costs one
// indexed query over the oracle ids on screen. That's why the default path
// short-circuits to an empty map: users who never touch the setting pay nothing.
//
// This resolves what a card *displays as* and what a quick-add *records*.
// Entries that already carry a scryfallId keep it — that's the specific card the
// user owns, and a display preference has no business rewriting it.
//
// No React here: the import resolve worker imports this module. The
// useDisplayPrintings hook lives in useDisplayPrintings.ts.

/** Only printings a person would want shown: English, and with art to show. */
function isDisplayable(p: Printing): boolean {
  return p.lang === 'en' && !!(p.imageNormal ?? p.imageSmall);
}

/** Newer first; scryfallId breaks ties so the choice is stable across devices. */
function byNewest(a: Printing, b: Printing): number {
  if (a.releasedAt !== b.releasedAt) return a.releasedAt > b.releasedAt ? -1 : 1;
  return a.scryfallId <= b.scryfallId ? -1 : 1;
}

function byOldest(a: Printing, b: Printing): number {
  if (a.releasedAt !== b.releasedAt) return a.releasedAt < b.releasedAt ? -1 : 1;
  return a.scryfallId <= b.scryfallId ? -1 : 1;
}

/** True when this preference needs the printings table at all. */
export function needsPrintingLookup(pref: PrintingPref, preferOwned: boolean): boolean {
  return pref !== 'latest' || preferOwned;
}

/** True when this preference wants "the ordinary version", so it needs set types. */
function wantsOrdinary(pref: PrintingPref): boolean {
  return pref === 'latestNonPromo' || pref === 'first';
}

/**
 * The printings a "normal printing" rule should choose between: no promos, and
 * none of the cosmetic variants a modern set stacks on top of a card
 * (borderless, showcase, extended art, retro frames, chase foils, serialized).
 *
 * Gives up one criterion at a time rather than all at once, so a card that only
 * ever appeared as a showcase still avoids the prerelease stamp, and a Secret
 * Lair exclusive still resolves to something instead of nothing.
 */
function ordinaryPrintings(pool: Printing[], setTypes: SetTypeMap | null): Printing[] {
  const nonPromo = pool.filter((p) => !isPromoPrinting(p, setTypes));
  const plain = nonPromo.filter((p) => !isVariantPrinting(p));
  if (plain.length) return plain;
  if (nonPromo.length) return nonPromo;
  return pool;
}

interface ResolveOptions {
  pref: PrintingPref;
  /** Printings the collection holds, or null when the preference doesn't care. */
  ownedIds: Set<string> | null;
  setTypes: SetTypeMap | null;
  /** Base-currency price per scryfallId, for the 'cheapest' rule. */
  priceOf?: (scryfallId: string) => number | null;
}

function pickOne(candidates: Printing[], opts: ResolveOptions): Printing | undefined {
  // Nothing English-with-art (some cards only exist in other languages) — let
  // the oracle default stand rather than showing a blank tile.
  const pool = candidates.filter(isDisplayable);
  if (!pool.length) return undefined;

  if (opts.ownedIds) {
    const mine = pool.filter((p) => opts.ownedIds!.has(p.scryfallId));
    if (mine.length) return [...mine].sort(byNewest)[0];
  }

  switch (opts.pref) {
    // Both of these mean "the ordinary version of the card", so both skip
    // promos and variants — they only disagree on which end of history to take.
    // Without that, "first printing" of a card from a modern set was decided by
    // a UUID comparison between the prerelease foil, the showcase and the plain
    // one, all of which share a release date.
    case 'first':
      return [...ordinaryPrintings(pool, opts.setTypes)].sort(byOldest)[0];
    case 'latestNonPromo':
      return [...ordinaryPrintings(pool, opts.setTypes)].sort(byNewest)[0];
    case 'cheapest': {
      const priced = pool
        .map((p) => ({ p, price: opts.priceOf?.(p.scryfallId) ?? null }))
        .filter((x): x is { p: Printing; price: number } => x.price != null && x.price > 0);
      if (!priced.length) return undefined; // no prices yet — keep the default
      priced.sort((a, b) => a.price - b.price || byNewest(a.p, b.p));
      return priced[0]!.p;
    }
    case 'latest':
      // Only reachable via preferOwned, which didn't match — the oracle row's
      // representative already *is* the latest, so change nothing.
      return undefined;
  }
}

/** The slice of preferences that decides a printing. */
export type PrintingPrefs = Pick<Prefs, 'printing' | 'preferOwnedPrinting' | 'baseCurrency'>;

export interface DisplayPrintingOptions {
  /**
   * An already-built ownership index, for callers that hold one. Without it the
   * collection is read directly, so one-shot callers (a quick-add handler, the
   * CSV importer) still honour prefer-owned.
   */
  owned?: OwnershipIndex;
  /**
   * Explicit preferences, for contexts that can't reach localStorage — namely
   * web workers, which get the snapshot passed in with their request.
   */
  prefs?: PrintingPrefs;
}

/**
 * The printing to show/record for each of these oracle cards. Oracle ids absent
 * from the result keep the card DB's own representative printing. Returns an
 * empty map for the default preference, without querying anything.
 */
export async function resolveDisplayPrintings(
  oracleIds: string[],
  { owned, prefs }: DisplayPrintingOptions = {},
): Promise<Map<string, Priced<Printing>>> {
  const { printing: pref, preferOwnedPrinting: preferOwned, baseCurrency } = prefs ?? getPrefs();
  const out = new Map<string, Priced<Printing>>();
  if (!needsPrintingLookup(pref, preferOwned)) return out;

  const ids = [...new Set(oracleIds)].filter(Boolean);
  if (!ids.length) return out;

  const [rows, setTypes, ownedByOracle] = await Promise.all([
    db.printings.where('oracleId').anyOf(ids).toArray(),
    // Only the "ordinary version" rules need set types; don't fetch an artifact
    // for the preferences that can't use it.
    wantsOrdinary(pref) ? loadSetTypes() : Promise.resolve(null),
    preferOwned ? ownedPrintingsFor(ids, owned) : Promise.resolve(null),
  ]);

  const byOracle = new Map<string, Printing[]>();
  for (const p of rows) {
    const list = byOracle.get(p.oracleId);
    if (list) list.push(p);
    else byOracle.set(p.oracleId, [p]);
  }

  let priceOf: ((id: string) => number | null) | undefined;
  if (pref === 'cheapest') {
    // Reads the same 16 in-memory price shards the search path already warmed.
    const prices = await getPricesByIds(rows.map((p) => p.scryfallId));
    priceOf = (id) => {
      const p = prices.get(id);
      if (!p) return null;
      return (baseCurrency === 'EUR' ? p.eur ?? p.usd : p.usd ?? p.eur) ?? null;
    };
  }

  const picks: Printing[] = [];
  byOracle.forEach((candidates, oracleId) => {
    const picked = pickOne(candidates, {
      pref,
      ownedIds: ownedByOracle?.get(oracleId) ?? null,
      setTypes,
      priceOf,
    });
    if (picked) picks.push(picked);
  });

  // The chosen printing carries its own price, which is usually not the one
  // baked onto the oracle row (an Alpha Lightning Bolt is not a M10 one).
  for (const p of await withPrices(picks, (p) => p.scryfallId)) out.set(p.oracleId, p);
  return out;
}

/** oracleId → the scryfallIds the collection holds, for the prefer-owned rule. */
async function ownedPrintingsFor(
  oracleIds: string[],
  owned?: OwnershipIndex,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (owned) {
    for (const id of oracleIds) {
      const ids = owned.ownedPrintings(id);
      if (ids.length) out.set(id, new Set(ids));
    }
    return out;
  }
  // No shared index to hand (one-shot callers): read the entries for these
  // oracle cards straight from the indexed collection table.
  const entries = await db.collection.where('oracleId').anyOf(oracleIds).toArray();
  for (const e of entries) {
    const set = out.get(e.oracleId);
    if (set) set.add(e.scryfallId);
    else out.set(e.oracleId, new Set([e.scryfallId]));
  }
  return out;
}

/** Shared empty result, so a no-op render doesn't churn a new Map each time. */
export const NO_DISPLAY_PRINTINGS: Map<string, Priced<Printing>> = new Map();

/**
 * The scryfallId to record when adding this card without an explicit printing
 * choice. Callers that already have a resolved map should read it directly; this
 * is for the one-shot paths (quick-add buttons, import review fix-ups).
 */
export async function preferredScryfallId(card: {
  oracleId: string;
  defaultScryfallId: string;
}): Promise<string> {
  const map = await resolveDisplayPrintings([card.oracleId]);
  return map.get(card.oracleId)?.scryfallId ?? card.defaultScryfallId;
}
