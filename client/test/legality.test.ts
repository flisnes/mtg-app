import { describe, expect, it } from 'vitest';
import type { DeckBoard, OracleCard } from '@mtg/shared';
import { checkDeckLegality, type LegalityCard } from '../src/deck/legality.js';
import { boardForFormat, boardOptions } from '../src/deck/boards.js';

const card = (name: string, extra: Partial<OracleCard> = {}): OracleCard =>
  ({
    oracleId: name,
    name,
    typeLine: 'Creature — Human',
    oracleText: '',
    colorIdentity: ['W'],
    cmc: 1,
    legalities: { commander: 'legal' },
    ...extra,
  }) as unknown as OracleCard;

const lurrus = card('Lurrus of the Dream-Den', {
  typeLine: 'Legendary Creature — Cat Nightmare',
  oracleText: 'Companion — Each permanent card in your starting deck has mana value 2 or less.\nLifelink',
  cmc: 3,
});
const commander = card('Commander', { typeLine: 'Legendary Creature — Human' });
const plains = card('Plains', { typeLine: 'Basic Land — Plains', cmc: 0 });

const slot = (oracle: OracleCard, board: DeckBoard, quantity = 1): LegalityCard => ({
  oracleId: oracle.oracleId,
  quantity,
  board,
  oracle,
});

/** 1 commander + 99 Plains: exactly 100. */
const hundred = (): LegalityCard[] => [slot(commander, 'commander'), slot(plains, 'main', 99)];

describe('companion and considering', () => {
  it('a companion does not count toward the 100', () => {
    const report = checkDeckLegality('commander', [...hundred(), slot(lurrus, 'companion')]);
    expect(report.problems).toEqual([]);
  });

  it('considering counts toward nothing, not even singleton or banned checks', () => {
    const banned = card('Banned Thing', { legalities: { commander: 'banned' } as OracleCard['legalities'] });
    const report = checkDeckLegality('commander', [...hundred(), slot(banned, 'maybe', 3), slot(commander, 'maybe')]);
    expect(report.problems).toEqual([]);
  });

  it('checks the companion restriction against the starting deck', () => {
    const big = card('Big Permanent', { cmc: 3 });
    const rows = [slot(commander, 'commander'), slot(plains, 'main', 98), slot(big, 'main'), slot(lurrus, 'companion')];
    const report = checkDeckLegality('commander', rows);
    expect(report.problems.some((p) => p.includes('companion requirement'))).toBe(true);
  });

  it('refuses a non-companion in the companion zone', () => {
    const report = checkDeckLegality('commander', [...hundred(), slot(plains, 'companion')]);
    expect(report.problems.some((p) => p.includes('no Companion ability'))).toBe(true);
  });

  it('commander decks offer no sideboard, and companion only to companions', () => {
    const zones = (o: OracleCard) => boardOptions({ cards: [o], commanderDeck: true, commandZone: [], from: 'main' });
    expect(zones(plains).map((z) => z.board)).toEqual(['main', 'commander', 'maybe']);
    expect(zones(lurrus).find((z) => z.board === 'companion')?.refusal).toBeUndefined();
    const modern = boardOptions({ cards: [plains], commanderDeck: false, commandZone: [], from: 'main' });
    expect(modern.map((z) => z.board)).toEqual(['main', 'side', 'maybe']);
  });

  it('tidies a commander sideboard into companion and considering', () => {
    expect(boardForFormat('side', lurrus, true, false)).toBe('companion');
    expect(boardForFormat('side', lurrus, true, true)).toBe('maybe');
    expect(boardForFormat('side', plains, true, false)).toBe('maybe');
    expect(boardForFormat('companion', lurrus, false, false)).toBe('side');
    expect(boardForFormat('main', plains, true, false)).toBeUndefined();
  });
});
