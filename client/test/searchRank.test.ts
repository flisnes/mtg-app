import { describe, expect, it } from 'vitest';
import { normalizeName } from '@mtg/shared';
import { phraseScore } from '../src/cardDb/search.js';

// Best-match tiers for a bare name search. The bug this pins: "bolt" ranked
// Bolt Bend, Bolt Hound and Bolt of Keranos (prefix) above Lightning Bolt
// (word at the end), so the card you meant fell off the first page.

const rank = (query: string, names: string[]) =>
  [...names].sort(
    (a, b) =>
      phraseScore(normalizeName(b), normalizeName(query)) - phraseScore(normalizeName(a), normalizeName(query)) ||
      a.localeCompare(b),
  );

describe('phraseScore', () => {
  it('orders exact > whole word > prefix > word start > substring > scattered', () => {
    const s = (name: string) => phraseScore(normalizeName(name), 'bolt');
    expect(s('Bolt')).toBe(6);
    expect(s('Lightning Bolt')).toBe(5);
    expect(s('Bolt Hound')).toBe(5);
    expect(s('Boltwave')).toBe(4);
    expect(s('Thunder Boltz')).toBe(3);
    expect(s('Firebolt')).toBe(2);
    expect(phraseScore(normalizeName('Shock'), 'bolt')).toBe(1);
  });

  it('takes the best occurrence, not the first', () => {
    // "sol" first appears inside "solemn", then as its own word.
    expect(phraseScore('solemn sol', 'sol')).toBe(5);
  });

  it('puts whole-word names ahead of bare prefixes', () => {
    expect(rank('bolt', ['Boltwave', 'Firebolt', 'Lightning Bolt', 'Bolt Hound'])).toEqual([
      'Bolt Hound',
      'Lightning Bolt',
      'Boltwave',
      'Firebolt',
    ]);
    expect(rank('path', ['Pathbreaker Ibex', 'Path to Exile', 'Warpath'])[0]).toBe('Path to Exile');
    expect(rank('sol', ['Solemn Simulacrum', 'Sol Ring', 'Consolidate'])[0]).toBe('Sol Ring');
  });
});
