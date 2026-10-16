import { describe, expect, it } from 'vitest';
import { wishCountMatcher, type CollectionEntry, type Priced, type Printing, type TradeLine } from '@mtg/shared';
import type { JoinedEntry } from '../src/db/queries.js';
import { foldPicks, ownTradeLines } from '../src/trade/board.js';

// The trade pickers' bookkeeping: own rows as tradelist lines, wishlist
// counting, and the per-card fold the quick-pick list uses when stacking.

const line = (scryfallId: string, quantity: number, extra: Partial<TradeLine> = {}): TradeLine => ({
  oracleId: 'bolt',
  scryfallId,
  name: 'Lightning Bolt',
  quantity,
  condition: 'NM',
  finish: 'nonfoil',
  lang: 'en',
  ...extra,
});

const printing = (id: string, releasedAt: string): Priced<Printing> =>
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
    priceEur: 1,
  }) as unknown as Priced<Printing>;

const prefs = { printing: 'latest', baseCurrency: 'EUR' } as const;
const none = () => 0;

describe('wishCountMatcher', () => {
  it('sums the wishes a copy meets and skips a pinned other printing', () => {
    const wanted = wishCountMatcher([
      { oracleId: 'bolt', scryfallId: null, quantity: 2 },
      { oracleId: 'bolt', scryfallId: 'm10', quantity: 1 },
      { oracleId: 'bolt', scryfallId: null, quantity: 4, finish: 'foil' },
    ]);
    expect(wanted(line('m10', 1))).toBe(3);
    expect(wanted(line('beta', 1))).toBe(2);
    expect(wanted(line('beta', 1, { finish: 'foil' }))).toBe(6);
    expect(wanted(line('x', 1, { oracleId: 'other' }))).toBe(0);
  });
});

describe('ownTradeLines', () => {
  const row = (id: string, e: Partial<CollectionEntry>): JoinedEntry =>
    ({
      entry: { id, oracleId: 'bolt', scryfallId: 'm10', quantity: 4, quantityForTrade: 0, condition: 'NM', finish: 'nonfoil', lang: 'en', ...e },
      oracle: { name: 'Lightning Bolt' },
    }) as unknown as JoinedEntry;

  it('keeps for-trade rows only, quantity = for-trade count, special variants merged', () => {
    const lines = ownTradeLines([
      row('a', { quantityForTrade: 2 }),
      row('b', { quantityForTrade: 1, special: ['altered'] }),
      row('c', { quantityForTrade: 0, scryfallId: 'beta' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ scryfallId: 'm10', quantity: 3, name: 'Lightning Bolt' });
  });
});

describe('foldPicks', () => {
  const lines = [line('m10', 1), line('beta', 3), line('m10', 2, { condition: 'LP' }), line('x', 1, { oracleId: 'shock', name: 'Shock' })];
  const printMap = new Map([
    ['m10', printing('m10', '2009-07-17')],
    ['beta', printing('beta', '1993-10-04')],
  ]);

  it('one row per line with stacking off', () => {
    const rows = foldPicks(lines, none, { stack: false, printMap, prefs, setTypes: null });
    expect(rows.map((r) => r.quantity)).toEqual([1, 3, 2, 1]);
  });

  it('folds by card, leads with the preferred printing, most copies of it first', () => {
    const rows = foldPicks(lines, none, { stack: true, printMap, prefs, setTypes: null });
    expect(rows).toHaveLength(2);
    const bolt = rows.find((r) => r.key === 's:bolt')!;
    expect(bolt.quantity).toBe(6);
    expect(bolt.editions).toBe(2);
    // "latest" picks M10 over Beta; of the two M10 lines, the LP one has more copies.
    expect(bolt.lead).toMatchObject({ scryfallId: 'm10', condition: 'LP' });
    expect(bolt.members[0]).toBe(bolt.lead);
    expect(rows.find((r) => r.key === 's:shock')!.members).toHaveLength(1);
  });

  it('wishlist matches sort first', () => {
    const wanted = (l: { oracleId: string }) => (l.oracleId === 'shock' ? 1 : 0);
    const rows = foldPicks(lines, wanted, { stack: true, printMap, prefs, setTypes: null });
    expect(rows[0]!.key).toBe('s:shock');
    expect(rows[0]!.wanted).toBe(1);
  });
});
