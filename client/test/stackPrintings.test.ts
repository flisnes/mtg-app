import { describe, expect, it } from 'vitest';
import type { CollectionEntry, OracleCard, Priced, Printing } from '@mtg/shared';
import type { JoinedEntry } from '../src/db/queries.js';
import { stackEntries, stackSortFields } from '../src/components/stackPrintings.js';
import { pickOwnedPrinting } from '../src/cardDb/preferredPrinting.js';

// Stacking printings is pure bookkeeping over joined rows, so it tests
// without a browser: fold rows, check the sums, check which edition stands
// for the pile under each printing preference.

const bolt: Priced<OracleCard> = {
  oracleId: 'bolt',
  name: 'Lightning Bolt',
  cmc: 1,
  defaultScryfallId: 'm10',
  priceEur: 1,
  priceUsd: 1,
} as unknown as Priced<OracleCard>;

const printing = (id: string, releasedAt: string, eur: number, extra: Partial<Printing> = {}): Priced<Printing> =>
  ({
    scryfallId: id,
    oracleId: 'bolt',
    set: id,
    setName: id.toUpperCase(),
    collectorNumber: '1',
    lang: 'en',
    releasedAt,
    finishes: ['nonfoil', 'foil'],
    imageSmall: `${id}.jpg`,
    imageNormal: `${id}.jpg`,
    priceEur: eur,
    priceUsd: eur,
    priceEurFoil: eur * 3,
    priceUsdFoil: eur * 3,
    priceHasFoil: true,
    ...extra,
  }) as unknown as Priced<Printing>;

const beta = printing('leb', '1993-10-04', 400);
const mm2 = printing('mm2', '2015-05-22', 2);
const m10 = printing('m10', '2009-07-17', 1.5);
const promo = printing('pbolt', '2020-01-01', 5, { promo: true });

let seq = 0;
const row = (p: Priced<Printing>, qty: number, extra: Partial<CollectionEntry> = {}): JoinedEntry => ({
  entry: {
    id: `e${++seq}`,
    oracleId: 'bolt',
    scryfallId: p.scryfallId,
    quantity: qty,
    quantityForTrade: 0,
    condition: 'NM',
    finish: 'nonfoil',
    lang: 'en',
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    ...extra,
  } as CollectionEntry,
  oracle: bolt,
  printing: p,
});

const prefs = { printing: 'latest' as const, baseCurrency: 'EUR' as const };

describe('pickOwnedPrinting', () => {
  it('latest = the newest printing you own, not the newest in existence', () => {
    expect(pickOwnedPrinting([beta, m10], prefs, null)?.scryfallId).toBe('m10');
  });
  it('first = the oldest you own', () => {
    expect(pickOwnedPrinting([mm2, m10], { ...prefs, printing: 'first' }, null)?.scryfallId).toBe('m10');
  });
  it('cheapest reads the printing prices', () => {
    expect(pickOwnedPrinting([beta, mm2, m10], { ...prefs, printing: 'cheapest' }, null)?.scryfallId).toBe('m10');
  });
  it('latestNonPromo skips the promo even when it is newest', () => {
    expect(pickOwnedPrinting([promo, mm2], { ...prefs, printing: 'latestNonPromo' }, null)?.scryfallId).toBe('mm2');
  });
  // Locke, Treasure Hunter in FIC, as Scryfall has it: the plain #87 is tagged
  // surgefoil (its foils are), #475 is a borderless chase card dated months later.
  const fic = (num: string, releasedAt: string, extra: Partial<Printing>) =>
    printing(`fic${num}`, releasedAt, 1, { set: 'fic', collectorNumber: num, ...extra });
  const locke87 = fic('87', '2025-06-13', { variants: ['specialfoil'] });
  const locke177 = fic('177', '2025-06-13', { variants: ['extendedart', 'boosterfun'] });
  const locke475 = fic('475', '2025-12-05', { variants: ['borderless', 'inverted', 'specialfoil'], finishes: ['foil'] });
  it('latestNonPromo: a printing that comes nonfoil is plain even when its foils are surge foils', () => {
    expect(pickOwnedPrinting([locke475, locke177, locke87], { ...prefs, printing: 'latestNonPromo' }, null)?.scryfallId).toBe('fic87');
  });
  it('latestNonPromo: among variants of one set, the lowest collector number wins over a later date', () => {
    const v87 = { ...locke87, variants: ['showcase' as const] };
    expect(pickOwnedPrinting([locke475, locke177, v87], { ...prefs, printing: 'latestNonPromo' }, null)?.scryfallId).toBe('fic87');
  });
  // Grim Hireling: The List reprinted it in 2024 as "AFC-25", after CLB #755.
  it('latestNonPromo: a lettered collector number (The List) loses to a plain-numbered printing', () => {
    const clb = printing('clb', '2022-06-10', 1, { collectorNumber: '755' });
    const plst = printing('plst', '2024-08-02', 1, { collectorNumber: 'AFC-25' });
    expect(pickOwnedPrinting([plst, clb], { ...prefs, printing: 'latestNonPromo' }, null)?.scryfallId).toBe('clb');
  });
  it('first: a lettered original (Homelands #30a) still counts as the first printing', () => {
    const hml = printing('hml', '1995-10-01', 1, { collectorNumber: '30a' });
    const ed5 = printing('5ed', '1997-03-24', 1, { collectorNumber: '97' });
    expect(pickOwnedPrinting([ed5, hml], { ...prefs, printing: 'first' }, null)?.scryfallId).toBe('hml');
  });
  it('falls back to a non-English copy rather than nothing', () => {
    const jp = printing('jp', '2021-01-01', 1, { lang: 'ja' });
    expect(pickOwnedPrinting([jp], prefs, null)?.scryfallId).toBe('jp');
  });
});

describe('stackEntries', () => {
  it('off: one stack per row, keyed by the row id, in order', () => {
    const rows = [row(beta, 2), row(mm2, 3)];
    const out = stackEntries(rows, { stack: false, prefs, setTypes: null });
    expect(out.map((s) => s.key)).toEqual(rows.map((r) => r.entry.id));
    expect(out.map((s) => s.quantity)).toEqual([2, 3]);
  });

  it('on: 2 Beta + 3 MM2 + 5 M10 is one x10 stack wearing the preferred owned printing', () => {
    const rows = [row(beta, 2), row(mm2, 3, { quantityForTrade: 1 }), row(m10, 5, { finish: 'foil' })];
    const [s] = stackEntries(rows, { stack: true, prefs, setTypes: null });
    expect(s).toBeDefined();
    expect(s!.key).toBe('s:bolt');
    expect(s!.quantity).toBe(10);
    expect(s!.quantityForTrade).toBe(1);
    expect(s!.printingCount).toBe(3);
    expect(s!.printing?.scryfallId).toBe('mm2'); // latest owned
    expect(s!.members[0]!.entry.scryfallId).toBe('mm2'); // the copy the sheet opens on
    expect(s!.members).toHaveLength(3);
    expect(s!.foil).toBe(true);
    // 2×400 + 3×2 + 5×(1.5 foil ×3)
    expect(s!.value.eur).toBeCloseTo(800 + 6 + 22.5);
  });

  it('keeps a lone row in a stack list keyed as a stack', () => {
    const [s] = stackEntries([row(beta, 1)], { stack: true, prefs, setTypes: null });
    expect(s!.key).toBe('s:bolt');
    expect(s!.members).toHaveLength(1);
  });

  it('merges languages and special conditions across members', () => {
    const rows = [row(m10, 1, { lang: 'de' }), row(m10, 1, { special: ['signed'] }), row(mm2, 1, { lang: 'ja', special: ['altered'] })];
    const [s] = stackEntries(rows, { stack: true, prefs, setTypes: null });
    expect(s!.langs).toEqual(['de', 'en', 'ja'].sort((a, b) => s!.langs.indexOf(a) - s!.langs.indexOf(b)));
    expect(new Set(s!.special)).toEqual(new Set(['signed', 'altered']));
  });

  it('sort fields: a stack sorts by its total value, earliest add and latest edit', () => {
    const rows = [row(beta, 1), row(m10, 4)];
    const [s] = stackEntries(rows, { stack: true, prefs, setTypes: null });
    const f = stackSortFields(s!, {});
    expect(f.price).toBeCloseTo(400 + 6);
    expect(f.added).toBe(Math.min(...rows.map((r) => r.entry.createdAt)));
    expect(f.updated).toBe(Math.max(...rows.map((r) => r.entry.updatedAt)));
    expect(f.set).toBe('m10'); // release of the shown (latest owned) printing
  });

  it('sort fields: a single-row stack sorts by one copy, not qty × price', () => {
    const [s] = stackEntries([row(beta, 3)], { stack: false, prefs, setTypes: null });
    expect(stackSortFields(s!, {}).price).toBeCloseTo(400);
  });
});
