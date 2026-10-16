import { describe, expect, it } from 'vitest';
import { sortRows } from '../src/components/cardSort.js';

// The one sort behind the lists with their own keys (sealed shelf, price
// movers, the deck list). The rules are the card list's: missing values last
// either way, ties by name A to Z, direction on the name only when it is the key.

interface Row {
  name: string;
  price: number | null;
  set: string | null;
}

const rows: Row[] = [
  { name: 'Ornithopter', price: null, set: 'atq' },
  { name: 'Black Lotus', price: 20000, set: null },
  { name: 'Mox Pearl', price: 5000, set: 'lea' },
  { name: 'Mox Jet', price: 5000, set: 'leb' },
];

const names = (r: Row[]) => r.map((x) => x.name);
const valueOf = (r: Row, key: 'name' | 'price' | 'set') => (key === 'price' ? r.price : key === 'set' ? r.set : null);

describe('sortRows', () => {
  it('sorts numbers, missing last, ties by name ascending', () => {
    expect(names(sortRows(rows, { key: 'price', dir: 'asc' }, valueOf, (r) => r.name))).toEqual([
      'Mox Jet',
      'Mox Pearl',
      'Black Lotus',
      'Ornithopter',
    ]);
    expect(names(sortRows(rows, { key: 'price', dir: 'desc' }, valueOf, (r) => r.name))).toEqual([
      'Black Lotus',
      'Mox Jet',
      'Mox Pearl',
      'Ornithopter',
    ]);
  });

  it('sorts strings as text, missing last', () => {
    expect(names(sortRows(rows, { key: 'set', dir: 'desc' }, valueOf, (r) => r.name))).toEqual([
      'Mox Jet',
      'Mox Pearl',
      'Ornithopter',
      'Black Lotus',
    ]);
  });

  it('applies the direction to the name only when name is the key', () => {
    expect(names(sortRows(rows, { key: 'name', dir: 'desc' }, valueOf, (r) => r.name))).toEqual([
      'Ornithopter',
      'Mox Pearl',
      'Mox Jet',
      'Black Lotus',
    ]);
  });

  it('leaves the input alone', () => {
    const before = names(rows);
    sortRows(rows, { key: 'price', dir: 'asc' }, valueOf, (r) => r.name);
    expect(names(rows)).toEqual(before);
  });
});
