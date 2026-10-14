import { describe, expect, it } from 'vitest';
import type { PriceHistory, UserEvent } from '@mtg/shared';
import { mergeHistories, monthlyBefore, readingsFor, recordDay, historyChange } from '../src/price/history.js';
import { costBasisOf } from '../src/price/costBasis.js';
import { buildCollectionValueSeries } from '../src/price/collectionValue.js';

// Foil lanes (v0.198.0) ride alongside the nonfoil pair in one row. These pin
// the rules every reader leans on: lanes stay day-aligned, a foil reads its
// own line or says it couldn't, and merging never mixes the two up.

const row = (over: Partial<PriceHistory> = {}): PriceHistory => ({
  scryfallId: 's1',
  startDay: '2026-10-01',
  eur: [100, 110, 120],
  usd: [90, 95, 99],
  ...over,
});

describe('recordDay', () => {
  it('creates a foil lane on its first reading, padded back to startDay', () => {
    const h = row();
    expect(recordDay(h, '2026-10-05', 130, 100, { eur: 500, usd: null })).toBe(true);
    expect(h.eur).toEqual([100, 110, 120, null, 130]);
    expect(h.eurFoil).toEqual([null, null, null, null, 500]);
    expect(h.usdFoil).toBeUndefined();
  });

  it('keeps an existing foil lane aligned on days without a foil reading', () => {
    const h = row({ eurFoil: [400, null, 410] });
    recordDay(h, '2026-10-04', 130, 100);
    expect(h.eurFoil).toEqual([400, null, 410, null]);
    expect(h.eurFoil!.length).toBe(h.eur.length);
  });
});

describe('readingsFor', () => {
  it('reads the foil lane for a foil copy when one is on record', () => {
    const h = row({ eurFoil: [null, 500, 520] });
    const lane = readingsFor(h, 'foil');
    expect(lane.foil).toBe(true);
    expect(lane.readings.eur).toEqual([null, 500, 520]);
    expect(historyChange(lane.readings)!.current).toBe(5.2);
  });

  it('falls back to the nonfoil line, and says so, with no foil reading', () => {
    expect(readingsFor(row({ eurFoil: [null, null, null] }), 'foil').foil).toBe(false);
    // One foil reading can't draw a line: the first day after a foil lane is
    // born keeps the nonfoil one.
    expect(readingsFor(row({ eurFoil: [null, null, 500] }), 'foil').foil).toBe(false);
    expect(readingsFor(row({ eurFoil: [null, 480], usdFoil: [null, null, 600] }), 'foil').foil).toBe(true);
    expect(readingsFor(row(), 'foil').readings.eur).toEqual([100, 110, 120]);
    // Etched isn't archived: it always reads nonfoil.
    expect(readingsFor(row({ eurFoil: [1, 2, 3] }), 'etched').foil).toBe(false);
  });
});

describe('mergeHistories', () => {
  it('merges foil lanes day-aligned, local winning ties', () => {
    const server = row({ startDay: '2026-09-29', eur: [80, 90, 100, 110], usd: [1, 1, 1, 1], eurFoil: [300, 310, 320, 330] });
    const local = row({ eurFoil: [null, 999, null] });
    const m = mergeHistories(server, local);
    expect(m.startDay).toBe('2026-09-29');
    expect(m.eur).toEqual([80, 90, 100, 110, 120]);
    expect(m.eurFoil).toEqual([300, 310, 320, 999, null]);
    expect(m.usdFoil).toBeUndefined();
  });

  it('a monthly-only server row does not stretch the daily window', () => {
    const server: PriceHistory = {
      scryfallId: 's1',
      startDay: '2024-02-01',
      eur: [],
      usd: [],
      monthly: { startMonth: '2024-02', usd: [500, 510] },
    };
    const m = mergeHistories(server, row());
    expect(m.startDay).toBe('2026-10-01');
    expect(m.eur).toEqual([100, 110, 120]);
    expect(m.monthly?.usd).toEqual([500, 510]);
  });
});

describe('monthlyBefore', () => {
  it('keeps only whole months before the daily series starts', () => {
    const pts = monthlyBefore({ startMonth: '2026-07', usd: [100, null, 300, 400] }, 'usd', '2026-09-20');
    expect(pts.map((p) => new Date(p.ts).toISOString().slice(0, 7))).toEqual(['2026-07']);
    expect(monthlyBefore({ startMonth: '2026-07', usd: [100, 200, 300] }, 'usd', '2026-10-01')).toHaveLength(3);
  });
});

describe('costBasisOf on a foil', () => {
  const add = (over: Partial<UserEvent>): UserEvent => ({
    id: 'e1',
    ts: Date.parse('2026-10-02T12:00:00Z'),
    updatedAt: 0,
    kind: 'collection.add',
    oracleId: 'o',
    scryfallId: 's1',
    finish: 'foil',
    ...over,
  });

  it('estimates off the foil line, not cross-finish, when there is one', () => {
    const b = costBasisOf([add({})], 's1', row({ eurFoil: [500, 510, 520] }), 'foil')!;
    expect(b.perCopy).toBe(5.1);
    expect(b.estimated).toBe(true);
    expect(b.crossFinish).toBe(false);
  });

  it('flags cross-finish when only the nonfoil line exists', () => {
    const b = costBasisOf([add({})], 's1', row(), 'foil')!;
    expect(b.perCopy).toBe(1.1);
    expect(b.crossFinish).toBe(true);
  });
});

describe('collection value on a foil copy', () => {
  it('uses the foil reading where there is one, nonfoil x premium before it', () => {
    // Today foil is 3x nonfoil; the foil lane starts on day 3.
    const h = row({ eur: [100, 100, 100], usd: [null, null, null], eurFoil: [null, null, 400] });
    const prices = new Map([['s1', { eur: 1, usd: null, eurFoil: 3, usdFoil: null, usdEtched: null, hasFoil: true }]]);
    const s = buildCollectionValueSeries([{ scryfallId: 's1', finish: 'foil', quantity: 1 }], [], [h], prices)!;
    expect(s.pts.map((p) => Math.round(p.total * 100) / 100)).toEqual([3, 3, 4]);
  });
});
