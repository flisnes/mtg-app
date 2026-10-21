import { describe, expect, it } from 'vitest';
import { clipSlot, groupSlots, type Row } from '../src/routes/container/rows.js';
import { rowToFilingCopy } from '../src/deck/filing.js';
import { describeFilingResult } from '../src/deck/useFiling.js';

const row = (extra: Partial<Row> = {}): Row => ({
  id: 's1',
  oracleId: 'bolt',
  quantity: 2,
  board: 'main',
  owned: 2,
  ...extra,
});

describe('rowToFilingCopy', () => {
  it('carries the printing and only the wants the slot names', () => {
    expect(rowToFilingCopy(row({ scryfallId: 'm10', finish: 'foil' }), 'side', { label: 'Lightning Bolt' })).toEqual({
      oracleId: 'bolt',
      quantity: 2,
      board: 'side',
      scryfallId: 'm10',
      wants: { finish: 'foil' },
      label: 'Lightning Bolt',
    });
  });

  it('a lands-box basic names no edition and wants nothing', () => {
    expect(rowToFilingCopy(row({ anyBasic: true }), 'main')).toEqual({ oracleId: 'bolt', quantity: 2, board: 'main', anyBasic: true });
  });

  it('takes a clipboard slot the same way as a row', () => {
    const slot = clipSlot(row({ scryfallId: 'm10', lang: 'ja', condition: 'NM', tags: ['burn'] }));
    expect(rowToFilingCopy(slot, 'main')).toEqual({
      oracleId: 'bolt',
      quantity: 2,
      board: 'main',
      scryfallId: 'm10',
      wants: { condition: 'NM', lang: 'ja' },
    });
  });
});

describe('groupSlots', () => {
  it('one tile per slot when not stacking', () => {
    const rows = [row(), row({ id: 's2', scryfallId: 'b' })];
    expect(groupSlots(rows, null).map((g) => g.rows.length)).toEqual([1, 1]);
  });
});

describe('describeFilingResult', () => {
  it('says what went in, not what was asked for', () => {
    expect(describeFilingResult({ mode: 'copy', filed: 0 }, 'deck')).toBe('Already in that deck');
    expect(describeFilingResult({ mode: 'move', filed: 1 }, 'binder')).toBe('Moved 1 card to binder');
    expect(describeFilingResult({ mode: 'copy', filed: 3 }, 'box')).toBe('Added 3 cards to box');
  });
});
