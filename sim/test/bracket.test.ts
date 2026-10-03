import { expect, test } from 'vitest';
// Rebuild plan D1: the bracket report, counted off the cards with the criteria
// in bracketCriteria.json. Plus the step 1 leftover readers (symmetric tax,
// chosen color, board-dependent mana amounts) on the cards that named them.
//
//   npx vitest run sim/test/bracket.test.ts
import type { OracleCard } from '../../shared/src/card.js';
import { bracketReport, extraTurnWhy, massLandDenialWhy } from '../src/bracket.js';
import { buildSimDeck, printedChosenColor, printedManaAmount, printedSymmetricTax, type DeckRow } from '../src/simDeck.js';

let seq = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${seq++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{G}',
    oracleText: o.oracleText ?? null,
    colorIdentity: ['G'],
    colors: ['G'],
    rarity: 'common',
    ...o,
  }) as OracleCard;
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
// Tag 7 is "tutor" in this vocabulary.
const tags = (slug: string) => (slug === 'tutor' ? new Set([7]) : null);
const noTags = () => null;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

const FOREST = card({ name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0] });
const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const ARMAGEDDON = card({ name: 'Armageddon', typeLine: 'Sorcery', oracleText: 'Destroy all lands.' });
const WARP = card({ name: 'Time Warp', typeLine: 'Sorcery', oracleText: 'Target player takes an extra turn after this one.' });
const MASTERY = card({ name: 'Temporal Mastery', typeLine: 'Sorcery', oracleText: 'Take an extra turn after this one. Exile Temporal Mastery.\nMiracle {1}{U}' });
const TUTOR = card({ name: 'Worldly Tutor', typeLine: 'Instant', oracleText: 'Search your library for a creature card...', tags: [7] });
const GC = (name: string) => card({ name, typeLine: 'Creature — Elf', gameChanger: true });

// ---------------------------------------------------------------------------
console.log('\n=== the detectors ===');
{
  check(massLandDenialWhy(ARMAGEDDON) === 'Destroy all lands', 'Armageddon is mass land denial');
  check(massLandDenialWhy(card({ name: 'Blood Moon', oracleText: 'Nonbasic lands are Mountains.' })) !== null, 'Blood Moon is');
  check(massLandDenialWhy(card({ name: 'Winter Orb', oracleText: "As long as this artifact is untapped, players can't untap more than one land during their untap steps." })) !== null, 'Winter Orb is');
  check(massLandDenialWhy(card({ name: 'Wildfire', oracleText: 'Each player sacrifices four lands of their choice. Wildfire deals 4 damage to each creature.' })) !== null, 'Wildfire is');
  check(massLandDenialWhy(card({ name: 'Tremble', oracleText: 'Each player sacrifices a land of their choice.' })) === null, 'one land each is not mass');
  check(massLandDenialWhy(card({ name: 'Ajani Vengeant', oracleText: '−7: Destroy all lands target player controls.' })) === null, 'a targeted Armageddon is not');
  check(massLandDenialWhy(card({ name: 'Stoic Angel', oracleText: "Players can't untap more than one creature during their untap steps." })) === null, 'creatures not untapping is not');
  check(massLandDenialWhy(card({ name: 'Cataclysm', oracleText: 'Each player chooses from among the permanents they control an artifact, a creature, an enchantment, and a land, then sacrifices the rest.' })) !== null, 'Cataclysm is, by name');
  check(extraTurnWhy(WARP) !== null, 'Time Warp is an extra turn (you are the target player)');
  check(extraTurnWhy(MASTERY) !== null, 'Temporal Mastery is');
  check(extraTurnWhy(card({ name: 'Stitch', oracleText: 'Each player takes an extra turn after this one.' })) === null, 'everyone taking one is not');
  check(extraTurnWhy(card({ name: 'Trap', oracleText: 'Target opponent takes an extra turn after this one.' })) === null, 'an opponent taking one is not');
}

// ---------------------------------------------------------------------------
console.log('\n=== the report: the lowest bracket the counts fit ===');
{
  const plain = bracketReport([main(60, FOREST), main(39, BEAR), cmd(BEAR)], tags);
  check(plain.level.id === 2 && plain.reasons.length === 0, `Forests and Bears: Bracket ${plain.level.id} ${plain.level.name}, no reasons`);
  check(plain.tutors !== null && plain.tutors.length === 0 && plain.gameChangers.length === 0, 'nothing counted');

  const three = bracketReport([main(60, FOREST), main(36, BEAR), main(1, GC('A')), main(1, GC('B')), main(1, GC('C')), cmd(BEAR)], tags);
  check(three.level.id === 3 && three.gameChangers.length === 3 && /3 Game Changers/.test(three.reasons.join()), `three Game Changers: Bracket ${three.level.id}, because of ${three.reasons.join(' and ')}`);

  const four = bracketReport([main(60, FOREST), main(35, BEAR), main(1, GC('A')), main(1, GC('B')), main(1, GC('C')), main(1, GC('D')), cmd(BEAR)], tags);
  check(four.level.id === 4 && /more than 3 Game Changers/.test(four.reasons.join()), `four Game Changers: Bracket ${four.level.id}`);

  const geddon = bracketReport([main(60, FOREST), main(38, BEAR), main(1, ARMAGEDDON), cmd(BEAR)], tags);
  check(geddon.level.id === 4 && geddon.massLandDenial[0]?.why === 'Destroy all lands', `one Armageddon: Bracket ${geddon.level.id}, "${geddon.massLandDenial[0]?.why}"`);

  const oneWarp = bracketReport([main(60, FOREST), main(38, BEAR), main(1, WARP), cmd(BEAR)], tags);
  const twoWarps = bracketReport([main(60, FOREST), main(37, BEAR), main(1, WARP), main(1, MASTERY), cmd(BEAR)], tags);
  check(oneWarp.level.id === 2 && twoWarps.level.id === 4, `one extra turn stays Bracket ${oneWarp.level.id}; two read as chaining, Bracket ${twoWarps.level.id}`);

  const tutors = bracketReport([main(60, FOREST), main(35, BEAR), main(4, TUTOR), cmd(BEAR)], tags);
  check(tutors.tutors?.length === 1 && tutors.level.id === 2, `four copies of one tutor count once (${tutors.tutors?.length}), still Bracket ${tutors.level.id}`);
  const manyTutors = bracketReport([main(60, FOREST), main(35, BEAR), ...[1, 2, 3, 4].map((k) => main(1, card({ name: `Tutor ${k}`, tags: [7] }))), cmd(BEAR)], tags);
  check(manyTutors.level.id === 3 && /4 tutors/.test(manyTutors.reasons.join()), `four different tutors: Bracket ${manyTutors.level.id}, because of ${manyTutors.reasons.join()}`);
  const untagged = bracketReport([main(60, FOREST), main(35, BEAR), main(4, TUTOR), cmd(BEAR)], noTags);
  check(untagged.tutors === null && untagged.level.id === 2, 'without the tag vocabulary the tutor count is null and does not move the bracket');
  const commanderGc = bracketReport([main(60, FOREST), main(39, BEAR), cmd(GC('Boss'))], tags);
  check(commanderGc.gameChangers.length === 1 && commanderGc.gameChangers[0]!.commander, 'a Game Changer in the command zone counts');
}

// ---------------------------------------------------------------------------
console.log('\n=== step 1 leftovers: the readers ===');
{
  check(printedSymmetricTax('First strike\nNoncreature spells cost {1} more to cast.') === 'Noncreature spells cost {1} more to cast', 'Thalia');
  check(printedSymmetricTax("Each player can't cast more than one spell each turn.") !== null, 'Rule of Law');
  check(printedSymmetricTax('Noncreature spells your opponents cast cost {1} more to cast.') === null, 'an opponents-only tax is not symmetric');
  check(printedSymmetricTax("Tap target creature. Those creatures don't untap during their controllers' untap steps.") === null, 'a targeted lock is not');
  check(printedChosenColor('As Coldsteel Heart enters, choose a color.\n{T}: Add one mana of the chosen color.'), 'Coldsteel Heart chooses');
  check(!printedChosenColor('{T}: Add one mana of any color.'), 'Birds does not');
  const archdruid = printedManaAmount('Other Elf creatures you control get +1/+1.\n{T}: Add {G} for each Elf you control.');
  check(archdruid?.kind === 'matching' && archdruid.q === 't:elf', `Archdruid: ${JSON.stringify(archdruid)}`);
  const priest = printedManaAmount('{T}: Add {G} for each Elf on the battlefield.');
  check(priest?.kind === 'matching' && priest.q === 't:elf', 'Priest of Titania: yours is the floor of everyone\'s');
  const cradle = printedManaAmount('{T}: Add {G} for each creature you control.');
  check(cradle?.kind === 'matching' && cradle.q === 't:creature', 'Gaea\'s Cradle');
  check(printedManaAmount('{T}: Add {C}.\n{2}, {T}: Choose a color. Add an amount of mana of that color equal to your devotion to that color.') === null, 'Nykthos has two Add lines, so nothing is read onto the plain {C}');
  check(printedManaAmount('{T}: Add {C} for each charge counter on it.')?.kind === 'counters', 'Chalice reads its counters');
  check(printedManaAmount('{T}: For each color among permanents you control, add one mana of that color.') === null, 'Bloom Tender stays floored');
}

// ---------------------------------------------------------------------------
console.log('\n=== the readers in a deck ===');
{
  // Elvish Archdruid in a deck of Forests: it taps for the Elves out, zero
  // with none. The database floored it at one.
  const ARCHDRUID = card({ name: 'Elvish Archdruid', typeLine: 'Creature — Elf Druid', manaCost: '{1}{G}{G}', cmc: 3, power: '2', toughness: '2', produces: 'G', mana: [2, 1, 20], oracleText: 'Other Elf creatures you control get +1/+1.\n{T}: Add {G} for each Elf you control.' });
  const deck = buildSimDeck([main(60, FOREST), main(38, BEAR), main(1, ARCHDRUID)]);
  const druid = deck.cards.find((c) => c.name === 'Elvish Archdruid')!;
  check(druid.manaAmount?.kind === 'matching' && druid.manaAmount.q === 't:elf', 'the Archdruid\'s amount is the Elves out');
  check(deck.filters.some((f) => f.q === 't:elf'), 'and the deck compiled a filter for it');
  // Coldsteel Heart in a mono-green deck is a green rock, not a five-color one.
  const HEART = card({ name: 'Coldsteel Heart', typeLine: 'Snow Artifact', manaCost: '{2}', cmc: 2, colors: [], colorIdentity: [], produces: 'WUBRG', mana: [1, 1, 1], oracleText: 'Coldsteel Heart enters tapped.\nAs Coldsteel Heart enters, choose a color.\n{T}: Add one mana of the chosen color.' });
  const green = buildSimDeck([main(60, FOREST), main(38, BEAR), main(1, HEART)]);
  const heart = green.cards.find((c) => c.name === 'Coldsteel Heart')!;
  check(heart.mask === deck.cards.find((c) => c.name === 'Forest')!.mask, `the Heart's mask is the deck's color (${heart.mask})`);
  // Thalia is flagged, and counted.
  const THALIA = card({ name: 'Thalia', typeLine: 'Legendary Creature — Human Soldier', manaCost: '{1}{W}', power: '2', toughness: '1', oracleText: 'First strike\nNoncreature spells cost {1} more to cast.' });
  const stax = buildSimDeck([main(60, FOREST), main(38, BEAR), main(1, THALIA)]);
  check(stax.coverage.stax === 1 && stax.cards.find((c) => c.name === 'Thalia')!.stax !== null, `Thalia flagged: coverage.stax = ${stax.coverage.stax}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('bracket: every check passes', () => {
  expect(failures).toBe(0);
});
