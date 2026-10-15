import { describe, expect, it } from 'vitest';
import { collectorRangesHave, encodeCollectorRanges, type SealedProduct } from '@mtg/shared';
import { boostersContaining, packsContaining } from '../src/sealed/product.js';

describe('collector ranges', () => {
  it('collapses integer runs and keeps odd numbers as is', () => {
    expect(encodeCollectorRanges(['3', '1', '2', '5', '12a', '★7', '2', '10', '11'])).toBe('1-3,5,10-11,12a,★7');
  });

  it('round-trips membership', () => {
    const r = encodeCollectorRanges(['1', '2', '3', '261', '314', '300a']);
    for (const n of ['1', '2', '3', '261', '314', '300a']) expect(collectorRangesHave(r, n)).toBe(true);
    for (const n of ['0', '4', '262', '300', '313', '315', '3a', '']) expect(collectorRangesHave(r, n)).toBe(false);
  });

  it('does not read a leading-zero number as an integer', () => {
    expect(collectorRangesHave('1-10', '007')).toBe(false);
    expect(collectorRangesHave(encodeCollectorRanges(['007']), '007')).toBe(true);
  });
});

describe('booster lookup', () => {
  // Experimental Confectioner (WOE #314) is on Set Booster sheets, not Draft.
  const boosters = {
    'woe:draft': { woe: '1-276', wot: '1-63' },
    'woe:set': { woe: '1-276,314', plst: '1-50' },
  };
  const product = (id: string, packs: string[] | undefined, releaseDate = '2023-09-08'): SealedProduct => ({
    id,
    name: id,
    set: 'woe',
    releaseDate,
    cards: [],
    ...(packs ? { packs } : {}),
  });

  it('finds the booster types a printing can come from', () => {
    expect([...boostersContaining(boosters, [{ set: 'woe', collectorNumber: '314' }])]).toEqual(['woe:set']);
    expect([...boostersContaining(boosters, [{ set: 'woe', collectorNumber: '10' }])].sort()).toEqual(['woe:draft', 'woe:set']);
    expect(boostersContaining(boosters, [{ set: 'woe', collectorNumber: '400' }]).size).toBe(0);
  });

  it('names products opening into those boosters, minus fixed hits, newest first', () => {
    const products = [
      product('draft box', ['woe:draft']),
      product('set box', ['woe:set']),
      product('bundle', ['woe:set'], '2023-09-09'),
      product('precon', undefined),
      product('already listed', ['woe:set']),
    ];
    const hits = packsContaining(products, new Set(['woe:set']), new Set(['already listed']));
    expect(hits.map((p) => p.id)).toEqual(['bundle', 'set box']);
  });
});
