import { expect, test } from 'vitest';
// Slice 1 of §12: does an authored behavior actually play out, and does the
// grammar say the same thing the pipeline's own reading says?
//
// The first check is the one that matters. `behaviorFromEffect` renders an
// EffectProfile as rules so the editor can open on the card database's answer;
// if that round trip is not exact, then opening the editor and pressing Save
// without touching anything silently changes the deck. Same synthetic cards as
// effect-sim.ts, same seed, so the two runs are comparable by construction.
//
// Run with:
//   npx tsx notes/checks/behavior-sim.ts
import {
  applyAmountOp,
  behaviorFromEffect,
  compileBehavior,
  describeBehavior,
  describeFetch,
  describeLandRamp,
  queryHasX,
  sanitizeCardBehavior,
  substituteQueryX,
  X_VARIANTS,
  MAX_BEHAVIOR_AMOUNT,
  type BehaviorAmount,
  type BehaviorAmountKind,
  type BehaviorAmountOp,
  type BehaviorStep,
  type CardBehavior,
} from '../../shared/src/behavior.js';
import { decodeEffectProfile, decodeFetchProfile, decodeManaProfile, type OracleCard } from '../../shared/src/card.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate } from '../src/simulate.js';

let n = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${n++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{U}',
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;

const ISLAND = card({ name: 'Island', typeLine: 'Basic Land — Island', cmc: 0, manaCost: '', produces: 'U', mana: [0, 1, 0] });
const BLANK = card({ name: 'Blank Spell', manaCost: '{1}{U}', cmc: 2 });
const DIVINATION = card({ name: 'Divination', manaCost: '{2}{U}', cmc: 3, effect: [0, 2] });
const LOOTING = card({ name: 'Faithless Looting', manaCost: '{U}', cmc: 1, effect: [0, 2, 2] });
const ARENA = card({ name: 'Phyrexian Arena', typeLine: 'Enchantment', manaCost: '{1}{U}{U}', cmc: 3, effect: [1, 1] });
const BIG_SCORE = card({ name: 'Big Score', manaCost: '{2}{U}', cmc: 3, effect: [0, 0, 1, 0, 0, 0, 2] });

const deckOf = (spell: OracleCard, copies: number): DeckRow[] => [
  { quantity: 40 - copies, board: 'main', oracle: ISLAND },
  { quantity: copies, board: 'main', oracle: spell },
  { quantity: 20, board: 'main', oracle: BLANK },
];

const GAMES = 4000;
const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>) => {
  const deck = buildSimDeck(rows, behaviors);
  const r = simulate(deck, { ...defaultSimOptions('commander', true), games: GAMES });
  return { deck, r };
};

const line = (label: string, xs: number[]) => `${label.padEnd(24)} ${xs.slice(1, 7).map((v) => v.toFixed(2)).join('  ')}`;
const same = (a: number[], b: number[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One bucket holds these steps and every other bucket is empty, whatever
 * buckets the grammar has grown since a check was written. Empty means [] for
 * the lists, null for tap/tapCond, 0 for dredge.
 */
const onlyBucket = (compiled: unknown, bucket: string, steps: unknown): boolean => {
  if (!compiled || typeof compiled !== 'object') return false;
  const c = compiled as Record<string, unknown>;
  if (JSON.stringify(c[bucket]) !== JSON.stringify(steps)) return false;
  return Object.entries(c).every(
    ([k, v]) => k === bucket || (Array.isArray(v) ? v.length === 0 : v === null || v === 0),
  );
};

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// 1. The round trip: the derived profile, re-authored, plays out identically
// ---------------------------------------------------------------------------
console.log('\n=== derived profile == the same profile rendered as rules ===');
for (const spell of [DIVINATION, LOOTING, ARENA, BIG_SCORE]) {
  const rows = deckOf(spell, 20);
  const derived = run(rows);
  const authored = behaviorFromEffect(decodeEffectProfile(spell.effect));
  if (!authored) {
    check(`${spell.name}: renders as rules`, false, 'behaviorFromEffect returned null');
    continue;
  }
  const asRules = run(rows, new Map([[spell.oracleId, authored]]));
  const ok =
    same(derived.r.cardsSeenByTurn, asRules.r.cardsSeenByTurn) &&
    same(derived.r.handSizeByTurn, asRules.r.handSizeByTurn) &&
    same(derived.r.manaByTurn, asRules.r.manaByTurn);
  check(`${spell.name}: "${describeBehavior(authored).join('. ')}"`, ok);
  if (!ok) {
    console.log(line('  seen derived', derived.r.cardsSeenByTurn));
    console.log(line('  seen authored', asRules.r.cardsSeenByTurn));
    console.log(line('  hand derived', derived.r.handSizeByTurn));
    console.log(line('  hand authored', asRules.r.handSizeByTurn));
  }
  check(`${spell.name}: counted as authored`, asRules.deck.coverage.authored === 20, `authored=${asRules.deck.coverage.authored}`);
}

// ---------------------------------------------------------------------------
// 2. A blank stops being one
// ---------------------------------------------------------------------------
console.log('\n=== a blank the user teaches to draw ===');
{
  const rows = deckOf(BLANK, 20);
  const before = run(rows);
  const after = run(
    rows,
    new Map([[BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] } as CardBehavior]]),
  );
  console.log(line('seen  blank', before.r.cardsSeenByTurn));
  console.log(line('seen  draws 2', after.r.cardsSeenByTurn));
  check('the curve moves up', (after.r.cardsSeenByTurn[6] ?? 0) > (before.r.cardsSeenByTurn[6] ?? 0));
  check('blanks reclassified', before.deck.coverage.blanks > after.deck.coverage.blanks,
    `${before.deck.coverage.blanks} -> ${after.deck.coverage.blanks}`);
}

// ---------------------------------------------------------------------------
// 3. Amounts that read the game state, and the order they read it in
// ---------------------------------------------------------------------------
console.log('\n=== state-reading amounts ===');
{
  const rows = deckOf(BLANK, 20);
  // "Draw cards equal to the lands you control" on a three-mana spell: by the
  // turn it is cast there are lands out, so it has to beat a flat draw-1.
  const byLands = run(
    rows,
    new Map([[BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'lands' } }] }] } as CardBehavior]]),
  );
  const byOne = run(
    rows,
    new Map([[BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior]]),
  );
  console.log(line('seen  draw 1', byOne.r.cardsSeenByTurn));
  console.log(line('seen  draw = lands', byLands.r.cardsSeenByTurn));
  check('lands you control beats a flat 1', (byLands.r.cardsSeenByTurn[6] ?? 0) > (byOne.r.cardsSeenByTurn[6] ?? 0));

  // Order matters and each amount is read as its own step runs: discard your
  // hand *then* draw for it, and there is nothing left to draw for.
  const discardThenDraw = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'play',
              steps: [
                { op: 'discard', x: { kind: 'hand' } },
                { op: 'draw', x: { kind: 'hand' } },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  const drawThenDiscard = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'play',
              steps: [
                { op: 'draw', x: { kind: 'hand' } },
                { op: 'discard', x: { kind: 'hand' } },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  console.log(line('seen  discard->draw', discardThenDraw.r.cardsSeenByTurn));
  console.log(line('seen  draw->discard', drawThenDiscard.r.cardsSeenByTurn));
  check(
    'the same two steps in the other order differ',
    !same(discardThenDraw.r.cardsSeenByTurn, drawThenDiscard.r.cardsSeenByTurn),
  );
  check(
    'discard-then-draw-for-your-hand sees nothing extra',
    (discardThenDraw.r.cardsSeenByTurn[6] ?? 0) <= (byOne.r.cardsSeenByTurn[6] ?? 0),
  );
}

// ---------------------------------------------------------------------------
// 4. An upkeep rule recurs, and a card can carry both triggers
// ---------------------------------------------------------------------------
console.log('\n=== upkeep ===');
{
  const ROCK = card({ name: 'Durdle Engine', typeLine: 'Enchantment', manaCost: '{1}{U}', cmc: 2 });
  const rows: DeckRow[] = [
    { quantity: 20, board: 'main', oracle: ISLAND },
    { quantity: 20, board: 'main', oracle: ROCK },
    { quantity: 20, board: 'main', oracle: BLANK },
  ];
  const once = run(
    rows,
    new Map([[ROCK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior]]),
  );
  const every = run(
    rows,
    new Map([[ROCK.oracleId, { v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior]]),
  );
  const both = run(
    rows,
    new Map([
      [
        ROCK.oracleId,
        {
          v: 1,
          rules: [
            { on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] },
            { on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  console.log(line('seen  once on entry', once.r.cardsSeenByTurn));
  console.log(line('seen  every upkeep', every.r.cardsSeenByTurn));
  console.log(line('seen  both', both.r.cardsSeenByTurn));
  check('an upkeep rule outdraws a one-shot by turn 6', (every.r.cardsSeenByTurn[6] ?? 0) > (once.r.cardsSeenByTurn[6] ?? 0));
  check('both rules beat either alone', (both.r.cardsSeenByTurn[6] ?? 0) > (every.r.cardsSeenByTurn[6] ?? 0));
}

// ---------------------------------------------------------------------------
// 5. The invariant the trajectory chart's labels rest on
// ---------------------------------------------------------------------------
console.log('\n=== spent never exceeds available ===');
{
  const rows = deckOf(BLANK, 20);
  const treasure = run(
    rows,
    new Map([[BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'treasure', x: { kind: 'turn' } }] }] } as CardBehavior]]),
  );
  let crossed = 0;
  for (let t = 1; t <= 6; t++) {
    if ((treasure.r.manaSpentByTurn[t] ?? 0) > (treasure.r.manaByTurn[t] ?? 0) + 1e-9) crossed++;
  }
  console.log(line('mana  available', treasure.r.manaByTurn));
  console.log(line('mana  spent', treasure.r.manaSpentByTurn));
  check('the two lines never cross', crossed === 0);
}

// ---------------------------------------------------------------------------
// 6. Sanitization and compilation, which is what survives a sync
// ---------------------------------------------------------------------------
console.log('\n=== sanitize and compile ===');
{
  const good: CardBehavior = {
    v: 1,
    rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }],
  };
  check('a round trip through JSON survives', JSON.stringify(sanitizeCardBehavior(JSON.parse(JSON.stringify(good)))) === JSON.stringify(good));
  check('a future version is refused whole', sanitizeCardBehavior({ ...good, v: 2 }) === null);
  check('junk is refused', sanitizeCardBehavior({ v: 1, rules: 'nope' }) === null);
  check(
    'an unreadable step is dropped, the rest kept',
    JSON.stringify(
      sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'explode', x: { kind: 'fixed', n: 1 } }, good.rules[0]!.steps[0]] }] }),
    ) === JSON.stringify(good),
  );
  check('a fixed amount is clamped', sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 9999 } }] }] })?.rules[0]?.steps[0]?.x.n === MAX_BEHAVIOR_AMOUNT);
  check('a rule with no readable step is dropped', sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'explode', x: { kind: 'fixed', n: 1 } }] }] }) === null);
  check('compiling splits by trigger', onlyBucket(compileBehavior(good), 'play', good.rules[0]!.steps));
  check('compiling nothing is null', compileBehavior(null) === null);
}

// ---------------------------------------------------------------------------
// 7. Moving cards between zones, and the criteria that says which
// ---------------------------------------------------------------------------
console.log('\n=== move ===');
{
  const BOMB = card({ name: 'Crucible of Worlds', typeLine: 'Artifact', manaCost: '{3}', cmc: 3 });
  const rows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 20, board: 'main', oracle: BLANK },
    { quantity: 1, board: 'main', oracle: BOMB },
  ];
  const bombOdds = (r: ReturnType<typeof run>) => r.r.cards.find((c) => c.oracleId === BOMB.oracleId)?.heldByTurn[6] ?? 0;

  const plain = run(rows);
  const tutor = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'hand', q: 'crucible' }] }] } as CardBehavior,
      ],
    ]),
  );
  console.log(`held  one-of by t6      ${(plain.r.cards.find((c) => c.oracleId === BOMB.oracleId)?.heldByTurn[6] ?? 0).toFixed(3)}`);
  console.log(`held  with a tutor      ${bombOdds(tutor).toFixed(3)}`);
  check('a tutor finds the card it names', bombOdds(tutor) > bombOdds(plain) * 2, `${bombOdds(plain).toFixed(3)} -> ${bombOdds(tutor).toFixed(3)}`);
  check('one criteria string, one filter', tutor.deck.filters.length === 1 && tutor.deck.filters[0]!.q === 'crucible');
  check(
    'the filter matches exactly one card in the deck',
    tutor.deck.filters[0]!.match.reduce((a: number, b: number) => a + b, 0) === 1,
  );

  // Criteria nobody in the deck answers: the step runs and finds nothing,
  // which has to be indistinguishable from not writing it.
  const nothing = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'hand', q: 't:dinosaur' }] }] } as CardBehavior,
      ],
    ]),
  );
  check('criteria matching nothing changes nothing', same(nothing.r.cardsSeenByTurn, plain.r.cardsSeenByTurn));

  // Ramp: a basic out of the library onto the battlefield, tapped.
  const ramp = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'battlefield', q: 't:basic' }] }] } as CardBehavior,
      ],
    ]),
  );
  console.log(line('mana  no ramp', plain.r.manaByTurn));
  console.log(line('mana  ramps a basic', ramp.r.manaByTurn));
  check('ramping a land out of the library makes mana', (ramp.r.manaByTurn[6] ?? 0) > (plain.r.manaByTurn[6] ?? 0));

  // Regrowth: the yard has to be filled by milling before anything can come
  // back out of it, and what comes back is not a card "seen" off the library.
  const millOnly = run(
    rows,
    new Map([[BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'mill', x: { kind: 'fixed', n: 4 } }] }] } as CardBehavior]]),
  );
  const millBack = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'play',
              steps: [
                { op: 'mill', x: { kind: 'fixed', n: 4 } },
                { op: 'move', x: { kind: 'fixed', n: 2 }, from: 'graveyard', to: 'hand' },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  console.log(line('hand  mill 4', millOnly.r.handSizeByTurn));
  console.log(line('hand  mill 4, take 2 back', millBack.r.handSizeByTurn));
  check('cards come back out of the graveyard', (millBack.r.handSizeByTurn[6] ?? 0) > (millOnly.r.handSizeByTurn[6] ?? 0));
  // A mill counts as seen since the trajectory work (face up in the yard is a
  // card you know about), so millBack sees more: the spells it takes back get
  // cast and mill again. The claim that survives is that the *regrowth itself*
  // credits nothing: a rule that only takes cards back leaves the curve
  // exactly where the blank left it.
  const regrowthOnly = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 2 }, from: 'graveyard', to: 'hand' }] }] } as CardBehavior,
      ],
    ]),
  );
  check('a card off the yard is not a card seen off the library', same(regrowthOnly.r.cardsSeenByTurn, plain.r.cardsSeenByTurn));

  // "All that match", bounded by the zone rather than by a number.
  const allBack = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'play',
              steps: [
                { op: 'mill', x: { kind: 'fixed', n: 4 } },
                { op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand', q: 't:basic' },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  console.log(line('hand  mill 4, take all lands', allBack.r.handSizeByTurn));
  check('all beats a fixed two', (allBack.r.handSizeByTurn[6] ?? 0) > (millOnly.r.handSizeByTurn[6] ?? 0));

  // A spell that resolves is in the yard afterwards, so a rule can find it.
  const eatOwnYard = run(
    rows,
    new Map([
      [
        BLANK.oracleId,
        { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand' }] }] } as CardBehavior,
      ],
    ]),
  );
  console.log(line('hand  regrow your own yard', eatOwnYard.r.handSizeByTurn));
  check('a cast sorcery reaches the graveyard', (eatOwnYard.r.handSizeByTurn[6] ?? 0) > (plain.r.handSizeByTurn[6] ?? 0));
}

console.log('\n=== move: sanitize and describe ===');
{
  const moveStep = { op: 'move', x: { kind: 'fixed', n: 2 }, from: 'library', to: 'hand', q: 't:basic' };
  const ok = sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [moveStep] }] });
  check('a move survives sanitization', JSON.stringify(ok?.rules[0]?.steps[0]) === JSON.stringify(moveStep));
  check(
    'a move to nowhere is dropped',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library' }] }] }) === null,
  );
  check(
    'a move to the zone it came from is dropped',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ ...moveStep, to: 'library' }] }] }) === null,
  );
  check(
    '"all that match" is refused on anything but a move',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'all' } }] }] }) === null,
  );
  check(
    'criteria are trimmed and capped',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ ...moveStep, q: `  ${'x'.repeat(400)}  ` }] }] })?.rules[0]?.steps[0]?.q
      ?.length === 120,
  );
  check(
    'an empty criteria string is dropped rather than stored',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ ...moveStep, q: '   ' }] }] })?.rules[0]?.steps[0]?.q === undefined,
  );
  const said = describeBehavior({ v: 1, rules: [{ on: 'play', steps: [moveStep as never] }] })[0];
  console.log(`  reads as: ${said}`);
  check('it reads as a sentence', said === 'When you play it: move 2 cards matching t:basic from your library to your hand');
  const saidAll = describeBehavior({
    v: 1,
    rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'battlefield' } as never] }],
  })[0];
  console.log(`  reads as: ${saidAll}`);
  check('so does "all"', saidAll === 'When you play it: move everything from your graveyard to the battlefield, tapped');
}

// ---------------------------------------------------------------------------
// 8. X: the mana that went into it, and the [X] placeholder in a criteria
// ---------------------------------------------------------------------------
console.log('\n=== X spells ===');
{
  const FIREBALL = card({ name: 'Fireball', manaCost: '{X}{U}', cmc: 1 });
  // No other spell in it, so the turn's spare mana has exactly one place to go
  // and X is the whole question. A deck of cheap spells is the other half of
  // the policy and is checked below.
  const rows: DeckRow[] = [
    { quantity: 40, board: 'main', oracle: ISLAND },
    { quantity: 20, board: 'main', oracle: FIREBALL },
  ];
  const plain = run(rows);
  console.log(line('mana  available', plain.r.manaByTurn));
  console.log(line('mana  spent', plain.r.manaSpentByTurn));
  // Until X was worth anything a Fireball was a one-mana spell and the rest of
  // the turn sat there. The gap has to close, and it must not invert.
  check('an X spell spends the turn', (plain.r.manaSpentByTurn[6] ?? 0) > 1);
  let crossed = 0;
  for (let t = 1; t <= 6; t++) {
    if ((plain.r.manaSpentByTurn[t] ?? 0) > (plain.r.manaByTurn[t] ?? 0) + 1e-9) crossed++;
  }
  check('spent still never exceeds available', crossed === 0);

  // X read as a plain amount: draw cards equal to what you paid.
  const drawX = run(
    rows,
    new Map([[FIREBALL.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'xpaid' } }] }] } as CardBehavior]]),
  );
  const drawOne = run(
    rows,
    new Map([[FIREBALL.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior]]),
  );
  console.log(line('seen  draw 1', drawOne.r.cardsSeenByTurn));
  console.log(line('seen  draw = X', drawX.r.cardsSeenByTurn));
  check('"the mana you spent on X" beats a flat 1', (drawX.r.cardsSeenByTurn[6] ?? 0) > (drawOne.r.cardsSeenByTurn[6] ?? 0));
  // And it has to *scale*: a flat 1 draws the same card every turn, X draws
  // more of them as the lands come down.
  const growth = (xs: number[]) => (xs[6] ?? 0) - (xs[4] ?? 0);
  check('and it grows faster', growth(drawX.r.cardsSeenByTurn) > growth(drawOne.r.cardsSeenByTurn));

  // An upkeep rule has no X to read: nothing was cast to get there.
  const upkeepX = run(
    rows,
    new Map([[FIREBALL.oracleId, { v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'xpaid' } }] }] } as CardBehavior]]),
  );
  check('an upkeep rule reads X as zero', same(upkeepX.r.cardsSeenByTurn, plain.r.cardsSeenByTurn));

  // The other half of the policy: X spells go last, so a hand of cheap spells
  // still gets cast and the Fireball takes what is left rather than the lot.
  const mixed: DeckRow[] = [
    { quantity: 30, board: 'main', oracle: ISLAND },
    { quantity: 10, board: 'main', oracle: FIREBALL },
    { quantity: 20, board: 'main', oracle: BLANK },
  ];
  const withX = run(mixed);
  const noX = run([
    { quantity: 30, board: 'main', oracle: ISLAND },
    { quantity: 30, board: 'main', oracle: BLANK },
  ]);
  console.log(line('mana  spent, mixed', withX.r.manaSpentByTurn));
  console.log(line('mana  spent, no X', noX.r.manaSpentByTurn));
  check(
    'X soaks the late-turn mana the model used to waste',
    (withX.r.manaSpentByTurn[6] ?? 0) > (noX.r.manaSpentByTurn[6] ?? 0),
  );
}

console.log('\n=== the [X] placeholder ===');
{
  const CHEAP = card({ name: 'Copper Myr', typeLine: 'Artifact Creature — Myr', manaCost: '{2}', cmc: 2 });
  const DEAR = card({ name: 'Colossus of Akros', typeLine: 'Artifact Creature — Golem', manaCost: '{8}', cmc: 8 });
  const FIREBALL = card({ name: 'Fireball', manaCost: '{X}{U}', cmc: 1 });
  const rows: DeckRow[] = [
    { quantity: 30, board: 'main', oracle: ISLAND },
    { quantity: 10, board: 'main', oracle: FIREBALL },
    { quantity: 10, board: 'main', oracle: CHEAP },
    { quantity: 10, board: 'main', oracle: DEAR },
  ];
  const held = (r: ReturnType<typeof run>, o: OracleCard) => r.r.cards.find((c) => c.oracleId === o.oracleId)?.heldByTurn[6] ?? 0;

  // "Return every creature with mana value at most X from your graveyard."
  const byX = run(
    rows,
    new Map([
      [
        FIREBALL.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'play',
              steps: [
                { op: 'mill', x: { kind: 'fixed', n: 6 } },
                { op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand', q: 't:creature mv<=[X]', qx: { kind: 'xpaid' } },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  const f = byX.deck.filters[0]!;
  check('a [X] query compiles to a stack', f.varies && f.match.length === X_VARIANTS * byX.deck.cards.length, `len=${f.match.length}`);
  const rowSum = (x: number) => {
    let n = 0;
    const base = x * byX.deck.cards.length;
    for (let i = 0; i < byX.deck.cards.length; i++) n += f.match[base + i]!;
    return n;
  };
  console.log(`  matches at X=0: ${rowSum(0)}, X=2: ${rowSum(2)}, X=8: ${rowSum(8)}`);
  check('X=0 finds no creature', rowSum(0) === 0);
  check('X=2 finds the two-drop only', rowSum(2) === 1);
  check('X=8 finds both', rowSum(8) === 2);
  check('the rows really differ', rowSum(2) < rowSum(8));

  // Pinning the same criteria at a fixed 2 must find the cheap one and never
  // the eight-drop, however much mana the game had.
  const pinnedZero = run(
    rows,
    new Map([
      [
        FIREBALL.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'play',
              steps: [
                { op: 'mill', x: { kind: 'fixed', n: 6 } },
                { op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand', q: 't:creature mv<=[X]', qx: { kind: 'fixed', n: 0 } },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  console.log(line('hand  [X] = mana on X', byX.r.handSizeByTurn));
  console.log(line('hand  [X] pinned at 0', pinnedZero.r.handSizeByTurn));
  check(
    'the placeholder is read at run time, not baked in',
    (byX.r.handSizeByTurn[6] ?? 0) > (pinnedZero.r.handSizeByTurn[6] ?? 0),
  );
  console.log(`  held Copper Myr by t6: [X] = mana on X ${held(byX, CHEAP).toFixed(3)}, pinned at 0 ${held(pinnedZero, CHEAP).toFixed(3)}`);
  check('mv<=0 can never find a two-drop', held(byX, CHEAP) > held(pinnedZero, CHEAP));
}

console.log('\n=== [X]: substitution, sanitize and describe ===');
{
  check('plain text has no placeholder', !queryHasX('t:creature mv<=3'));
  check('[X] is spotted', queryHasX('t:creature mv<=[X]'));
  check('so is [x] and whitespace', queryHasX('mv<=[ x + 1 ]'));
  check('substitution', substituteQueryX('t:creature mv<=[X]', 5) === 't:creature mv<=5');
  check('an offset', substituteQueryX('mv<=[X-1]', 5) === 'mv<=4');
  check('a plus offset', substituteQueryX('mv<=[X+2]', 5) === 'mv<=7');
  check('it never goes below zero', substituteQueryX('mv<=[X-4]', 1) === 'mv<=0');
  check('every occurrence', substituteQueryX('mv>=[X] mv<=[X+1]', 3) === 'mv>=3 mv<=4');

  const moveX = { op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand', q: 't:creature mv<=[X]', qx: { kind: 'xpaid' } };
  const ok = sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [moveX] }] });
  check('a [X] move survives sanitization', JSON.stringify(ok?.rules[0]?.steps[0]) === JSON.stringify(moveX));
  check(
    'qx is dropped when the query has no placeholder',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ ...moveX, q: 't:creature' }] }] })?.rules[0]?.steps[0]?.qx ===
      undefined,
  );
  check(
    'qx cannot be "all that match"',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ ...moveX, qx: { kind: 'all' } }] }] })?.rules[0]?.steps[0]?.qx ===
      undefined,
  );
  check(
    '"the mana you spent on X" is refused as a move count',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'xpaid' } }] }] })?.rules[0]?.steps[0]?.x
      .kind === 'xpaid',
  );
  const said = describeBehavior({ v: 1, rules: [{ on: 'play', steps: [moveX as never] }] })[0];
  console.log(`  reads as: ${said}`);
  check(
    'it reads as a sentence',
    said ===
      'When you play it: move everything matching t:creature mv<=[X] from your graveyard to your hand, with [X] = the mana you spent on X',
  );
}

// ---------------------------------------------------------------------------
// 10. Where in the library a card goes back
// ---------------------------------------------------------------------------
console.log('\n=== top, bottom and a random spot ===');
{
  const BOMB = card({ name: 'Crucible of Worlds', typeLine: 'Artifact', manaCost: '{3}', cmc: 3 });
  const rows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 20, board: 'main', oracle: BLANK },
    { quantity: 1, board: 'main', oracle: BOMB },
  ];
  const bombOdds = (r: ReturnType<typeof run>) => r.r.cards.find((c) => c.oracleId === BOMB.oracleId)?.heldByTurn[6] ?? 0;
  const seek = (to: string) =>
    run(
      rows,
      new Map([
        [
          BLANK.oracleId,
          {
            v: 1,
            rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to, q: 'crucible' }] }],
          } as CardBehavior,
        ],
      ]),
    );
  const plain = run(rows);
  const toTop = seek('librarytop');
  const toBottom = seek('librarybottom');
  console.log(`held  one-of by t6      ${bombOdds(plain).toFixed(3)}`);
  console.log(`held  tutored to top    ${bombOdds(toTop).toFixed(3)}`);
  console.log(`held  tutored to bottom ${bombOdds(toBottom).toFixed(3)}`);
  // Mystical Tutor: it is not in your hand, it is the next card you draw.
  check('a tutor to the top puts the card in reach', bombOdds(toTop) > bombOdds(plain) * 2);
  // And the bottom is the other half of the same statement: a card put there
  // is out of the game for the eight turns this model watches.
  check('a tutor to the bottom buries it instead', bombOdds(toBottom) < bombOdds(plain));

  // The three destinations, ordered. Mill your own lands and hand them back to
  // three different places: the top is worth the most, the bottom nothing, and
  // a random spot lands in between by construction.
  //
  // Deliberately land-light. A deck with forty lands never misses a drop, so
  // handing it more lands measures nothing and the three numbers agree to two
  // decimals — which looked like a passing check and was really a blind one.
  const lands = (to: string) =>
    run(
      [
        { quantity: 18, board: 'main', oracle: ISLAND },
        { quantity: 42, board: 'main', oracle: BLANK },
      ],
      new Map([
        [
          BLANK.oracleId,
          {
            v: 1,
            rules: [
              {
                on: 'play',
                steps: [
                  { op: 'mill', x: { kind: 'fixed', n: 10 } },
                  { op: 'move', x: { kind: 'all' }, from: 'graveyard', to, q: 't:basic' },
                ],
              },
            ],
          } as CardBehavior,
        ],
      ]),
    );
  const top = lands('librarytop');
  const random = lands('library');
  const bottom = lands('librarybottom');
  console.log(line('mana  back on top', top.r.manaByTurn));
  console.log(line('mana  back at random', random.r.manaByTurn));
  console.log(line('mana  back on bottom', bottom.r.manaByTurn));
  const m = (r: ReturnType<typeof run>) => r.r.manaByTurn[6] ?? 0;
  check('the top beats a random spot', m(top) > m(random), `${m(top).toFixed(2)} vs ${m(random).toFixed(2)}`);
  check('a random spot beats the bottom', m(random) > m(bottom), `${m(random).toFixed(2)} vs ${m(bottom).toFixed(2)}`);

  // A seeded run has to stay a seeded run: the new shuffles draw from the same
  // generator, and a panel whose numbers move on a re-render is a slot machine.
  check('the same seed gives the same game twice', same(lands('library').r.manaByTurn, random.r.manaByTurn));
}

// ---------------------------------------------------------------------------
// 11. The card talking about itself
// ---------------------------------------------------------------------------
console.log('\n=== put this card into a zone ===');
{
  const GRABBER = card({ name: 'Grave Robber', manaCost: '{2}{U}', cmc: 3 });
  const rows: DeckRow[] = [
    { quantity: 30, board: 'main', oracle: ISLAND },
    { quantity: 15, board: 'main', oracle: BLANK },
    { quantity: 15, board: 'main', oracle: GRABBER },
  ];
  const grab = {
    v: 1,
    rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand' }] }],
  } as CardBehavior;
  const yardOnly = run(rows, new Map([[GRABBER.oracleId, grab]]));
  const exilesItself = run(
    rows,
    new Map<string, CardBehavior>([
      [GRABBER.oracleId, grab],
      [BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'exile' }] }] }],
    ]),
  );
  console.log(line('hand  blanks hit the yard', yardOnly.r.handSizeByTurn));
  console.log(line('hand  blanks exile themselves', exilesItself.r.handSizeByTurn));
  check(
    'a spell that exiles itself is not in the graveyard to recur',
    (exilesItself.r.handSizeByTurn[6] ?? 0) < (yardOnly.r.handSizeByTurn[6] ?? 0),
  );

  // Green Sun's Zenith: back into the deck instead of the yard, so it is a card
  // you can cast again. On the top it is a card you cast again *next turn*.
  const recurRows: DeckRow[] = [
    { quantity: 30, board: 'main', oracle: ISLAND },
    { quantity: 30, board: 'main', oracle: BLANK },
  ];
  const once = run(recurRows);
  const backOnTop = run(
    recurRows,
    new Map([
      [BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'librarytop' }] }] } as CardBehavior],
    ]),
  );
  console.log(line('spent one and done', once.r.manaSpentByTurn));
  console.log(line('spent shuffles back', backOnTop.r.manaSpentByTurn));
  check(
    'a spell that puts itself back on top is cast again',
    (backOnTop.r.manaSpentByTurn[6] ?? 0) > (once.r.manaSpentByTurn[6] ?? 0),
  );

  // On a permanent it comes off the battlefield, which for a land is the whole
  // of its contribution.
  const SELF_EXILE_LAND = card({
    name: 'Vanishing Isle',
    typeLine: 'Basic Land — Island',
    cmc: 0,
    manaCost: '',
    produces: 'U',
    mana: [0, 1, 0],
  });
  const landRows: DeckRow[] = [
    { quantity: 40, board: 'main', oracle: SELF_EXILE_LAND },
    { quantity: 20, board: 'main', oracle: BLANK },
  ];
  const staysDown = run(landRows);
  const leaves = run(
    landRows,
    new Map([
      [
        SELF_EXILE_LAND.oracleId,
        { v: 1, rules: [{ on: 'play', steps: [{ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'exile' }] }] } as CardBehavior,
      ],
    ]),
  );
  console.log(line('mana  lands stay down', staysDown.r.manaByTurn));
  console.log(line('mana  lands exile themselves', leaves.r.manaByTurn));
  check('a permanent that exiles itself stops making mana', (leaves.r.manaByTurn[6] ?? 0) === 0);

  // An upkeep rule that moves the card off the battlefield fires once and stops.
  const ENGINE = card({ name: 'Durdle Engine', typeLine: 'Enchantment', manaCost: '{1}{U}', cmc: 2 });
  const engineRows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 18, board: 'main', oracle: ENGINE },
    { quantity: 18, board: 'main', oracle: BLANK },
  ];
  const everyTurn = run(
    engineRows,
    new Map([[ENGINE.oracleId, { v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior]]),
  );
  const onceThenGone = run(
    engineRows,
    new Map([
      [
        ENGINE.oracleId,
        {
          v: 1,
          rules: [
            {
              on: 'upkeep',
              steps: [
                { op: 'draw', x: { kind: 'fixed', n: 1 } },
                { op: 'self', x: { kind: 'fixed', n: 1 }, to: 'graveyard' },
              ],
            },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  console.log(line('seen  every upkeep', everyTurn.r.cardsSeenByTurn));
  console.log(line('seen  once, then gone', onceThenGone.r.cardsSeenByTurn));
  check(
    'a card that bins itself at upkeep stops triggering',
    (onceThenGone.r.cardsSeenByTurn[6] ?? 0) < (everyTurn.r.cardsSeenByTurn[6] ?? 0),
  );
}

console.log('\n=== self and the library zones: sanitize and describe ===');
{
  const selfStep = { op: 'self', x: { kind: 'fixed', n: 1 }, to: 'exile' };
  check(
    'a self step survives sanitization',
    JSON.stringify(sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [selfStep] }] })?.rules[0]?.steps[0]) ===
      JSON.stringify(selfStep),
  );
  check(
    'its amount is normalized rather than kept',
    JSON.stringify(
      sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'self', x: { kind: 'hand' }, to: 'library' }] }] })?.rules[0]
        ?.steps[0],
    ) === JSON.stringify({ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'library' }),
  );
  check(
    'a self step with nowhere to go is dropped',
    sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'self', x: { kind: 'fixed', n: 1 } }] }] }) === null,
  );
  check(
    'nothing is ever moved out of the top of the library',
    sanitizeCardBehavior({
      v: 1,
      rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'librarytop', to: 'hand' }] }],
    }) === null,
  );
  check(
    'the library and its top are different zones',
    sanitizeCardBehavior({
      v: 1,
      rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'librarytop', q: 'bolt' }] }],
    }) !== null,
  );

  const said = (steps: unknown[]) => describeBehavior({ v: 1, rules: [{ on: 'play', steps: steps as never }] })[0];
  const selfSaid = said([selfStep]);
  console.log(`  reads as: ${selfSaid}`);
  check('a self step reads as a sentence', selfSaid === 'When you play it: put this card into exile');
  const shuffled = said([{ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'library' }]);
  console.log(`  reads as: ${shuffled}`);
  check('the plain library says it is random', shuffled === 'When you play it: put this card into a random spot in your library');
  const tutored = said([{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'librarytop', q: 't:instant' }]);
  console.log(`  reads as: ${tutored}`);
  check(
    'and so does a tutor to the top',
    tutored === 'When you play it: move 1 card matching t:instant from your library to the top of your library',
  );
  const onto = said([{ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'battlefield' }]);
  check('cards go onto the battlefield and into everything else', onto === 'When you play it: put this card onto the battlefield, tapped');
}

// ---------------------------------------------------------------------------
// 12. An authored rule replaces the derived land ramp, it does not add to it
// ---------------------------------------------------------------------------
console.log('\n=== authored rules vs the mana profile ===');
{
  // `mana` is [kind, adds, flags]; kind 3 is 'landramp' in MANA_KINDS.
  // {1}{U} rather than {1}{G}: the test deck is Islands, and a Rampant Growth
  // nobody can cast measures nothing. The first draft of this check passed on
  // four identical rows for exactly that reason.
  const GROWTH = card({ name: 'Rampant Growth', manaCost: '{1}{U}', cmc: 2, mana: [3, 1, 0] });
  const rows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 18, board: 'main', oracle: GROWTH },
    { quantity: 18, board: 'main', oracle: BLANK },
  ];
  check('the profile reads as land ramp', describeLandRamp(decodeManaProfile(GROWTH.mana)) !== null);
  check('a plain spell reads as nothing', describeLandRamp(decodeManaProfile(BLANK.mana)) === null);

  const derived = run(rows);
  // The same card written out by hand: one land out of the library, onto the
  // battlefield. It must ramp exactly as much, not twice as much.
  const written = {
    v: 1,
    rules: [
      {
        on: 'play',
        steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'battlefield', q: 't:basic' }],
      },
    ],
  } as CardBehavior;
  const authored = run(rows, new Map([[GROWTH.oracleId, written]]));
  console.log(line('mana  read as land ramp', derived.r.manaByTurn));
  console.log(line('mana  written out by hand', authored.r.manaByTurn));
  // Tight on purpose. A loose bound here would have passed the first draft,
  // where the authored version ran 6% *under* the derived one because a
  // filtered search off the library took the topmost match instead of a random
  // one — see takeFrom(). The two should now be the same model.
  const gap = (authored.r.manaByTurn[6] ?? 0) - (derived.r.manaByTurn[6] ?? 0);
  check('writing the ramp out does not double it', Math.abs(gap) < 0.15, `gap ${gap.toFixed(2)} mana at turn 6`);

  // And a rule that says nothing about lands still replaces the ramp, because
  // a behavior replaces the whole derived reading. The alternative is the bug:
  // the database's guess fires and then the user's rule fires on top.
  const drawsInstead = run(
    rows,
    new Map([
      [GROWTH.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior],
    ]),
  );
  console.log(line('mana  authored, no ramp step', drawsInstead.r.manaByTurn));
  check(
    'an authored rule with no ramp step gives up the ramp',
    (drawsInstead.r.manaByTurn[6] ?? 0) < (derived.r.manaByTurn[6] ?? 0),
  );

  // An upkeep rule is not the card's resolution, so it leaves the ramp be.
  // Measured against a twin with no mana profile and the *same* rule, because
  // an upkeep that draws a card is itself worth mana and comparing it to the
  // plain derived run measures the draws instead of the ramp.
  const TWIN = card({ name: 'Rampant Growth (no profile)', manaCost: '{1}{U}', cmc: 2 });
  const upkeepRule = {
    v: 1,
    rules: [{ on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }],
  } as CardBehavior;
  const withRamp = run(rows, new Map([[GROWTH.oracleId, upkeepRule]]));
  const noRamp = run(
    [
      { quantity: 24, board: 'main', oracle: ISLAND },
      { quantity: 18, board: 'main', oracle: TWIN },
      { quantity: 18, board: 'main', oracle: BLANK },
    ],
    new Map([[TWIN.oracleId, upkeepRule]]),
  );
  console.log(line('mana  upkeep rule, ramp card', withRamp.r.manaByTurn));
  console.log(line('mana  upkeep rule, plain card', noRamp.r.manaByTurn));
  check(
    'an upkeep-only rule leaves the ramp alone',
    (withRamp.r.manaByTurn[6] ?? 0) > (noRamp.r.manaByTurn[6] ?? 0) + 1,
    `${(withRamp.r.manaByTurn[6] ?? 0).toFixed(2)} vs ${(noRamp.r.manaByTurn[6] ?? 0).toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------------
// 13. Carrying a number forward, and doing arithmetic on it
// ---------------------------------------------------------------------------
console.log('\n=== "the previous X", and adjusting an amount ===');
{
  // Pure arithmetic first, because every curve below leans on it.
  const amt = (kind: BehaviorAmountKind, op?: BehaviorAmountOp, by?: number) =>
    (op ? { kind, op, by } : { kind }) as BehaviorAmount;
  check('no adjustment leaves the number alone', applyAmountOp(7, amt('hand')) === 7);
  check('plus', applyAmountOp(7, amt('hand', '+', 2)) === 9);
  check('minus', applyAmountOp(7, amt('hand', '-', 1)) === 6);
  check('times', applyAmountOp(7, amt('hand', '*', 2)) === 14);
  check('divided by rounds down', applyAmountOp(7, amt('hand', '/', 2)) === 3);
  check('the other one rounds up', applyAmountOp(7, amt('hand', '/^', 2)) === 4);
  check('and they agree when it divides evenly', applyAmountOp(6, amt('hand', '/^', 2)) === applyAmountOp(6, amt('hand', '/', 2)));
  check('minus can go negative before the floor sees it', applyAmountOp(1, amt('hand', '-', 4)) === -3);

  const said = (steps: BehaviorStep[]) => describeBehavior({ v: 1, rules: [{ on: 'play', steps }] } as CardBehavior).join('');
  const halfLib = said([{ op: 'draw', x: amt('library', '/', 2) }]);
  check(
    'an adjusted amount reads out',
    halfLib === 'When you play it: draw X (X = cards in your library ÷ 2, rounded down)',
    halfLib,
  );
  const upLib = said([{ op: 'draw', x: amt('library', '/^', 2) }]);
  check(
    'and says which way it rounds',
    upLib === 'When you play it: draw X (X = cards in your library ÷ 2, rounded up)',
    upLib,
  );
  const dark = said([
    { op: 'discard', x: amt('hand') },
    { op: 'draw', x: amt('prev', '-', 1) },
  ]);
  check(
    'Dark Deal reads out',
    dark === 'When you play it: discard X (X = cards in your hand), then draw X (X = the previous X - 1)',
    dark,
  );

  // Sanitization: an adjustment only survives where it means something, and it
  // survives *identically*, because saving the same rule twice has to be the
  // same bytes.
  const round = (x: unknown) => sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x }] }] });
  const xOf = (b: CardBehavior | null) => b?.rules[0]?.steps[0]?.x;
  const json = (x: unknown) => JSON.stringify(x);
  check('a fixed number never keeps an adjustment', json(xOf(round({ kind: 'fixed', n: 3, op: '*', by: 2 }))) === '{"kind":"fixed","n":3}');
  check('an adjustment of zero is dropped', json(xOf(round({ kind: 'hand', op: '+', by: 0 }))) === '{"kind":"hand"}');
  check('an operator nobody knows is dropped', json(xOf(round({ kind: 'hand', op: '%', by: 2 }))) === '{"kind":"hand"}');
  check('a real one survives', json(xOf(round({ kind: 'hand', op: '/', by: 2 }))) === '{"kind":"hand","op":"/","by":2}');
  check('so does the rounding-up one', json(xOf(round({ kind: 'hand', op: '/^', by: 2 }))) === '{"kind":"hand","op":"/^","by":2}');
  check(
    'and survives a second trip unchanged',
    json(xOf(round(xOf(round({ kind: 'hand', op: '/', by: 2 }))))) === '{"kind":"hand","op":"/","by":2}',
  );
  check('the adjustment is clamped too', xOf(round({ kind: 'hand', op: '*', by: 999 }))?.by === MAX_BEHAVIOR_AMOUNT);
  // compileBehavior is the other gate. An operator off a newer device drops the
  // whole step rather than running the number unmodified: an ignored "÷ 2"
  // doubles what the author asked for, which is the one direction §11.4 bars.
  const badOp = { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'hand', op: '^', by: 2 } }] }] } as unknown as CardBehavior;
  check('and the step goes with it at compile time', compileBehavior(badOp) === null);

  const rows = deckOf(BLANK, 20);
  const play = (steps: BehaviorStep[]) =>
    run(rows, new Map([[BLANK.oracleId, { v: 1, rules: [{ on: 'play', steps }] } as CardBehavior]]));
  const seen = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[6] ?? 0;
  const blank = run(rows);

  // Windfall, which is the whole point. The same two steps reading `hand` twice
  // draw nothing, because the hand they are counting is already in the yard.
  const windfall = play([
    { op: 'discard', x: amt('hand') },
    { op: 'draw', x: amt('prev') },
  ]);
  const naive = play([
    { op: 'discard', x: amt('hand') },
    { op: 'draw', x: amt('hand') },
  ]);
  const darkDeal = play([
    { op: 'discard', x: amt('hand') },
    { op: 'draw', x: amt('prev', '-', 1) },
  ]);
  console.log(line('seen  discard->draw hand', naive.r.cardsSeenByTurn));
  console.log(line('seen  Windfall', windfall.r.cardsSeenByTurn));
  console.log(line('seen  Dark Deal', darkDeal.r.cardsSeenByTurn));
  check('Windfall draws back what it discarded', seen(windfall) > seen(naive), `${seen(windfall).toFixed(2)} vs ${seen(naive).toFixed(2)}`);
  check(
    'Dark Deal draws one fewer than that',
    seen(darkDeal) < seen(windfall) && seen(darkDeal) > seen(naive),
    `${seen(darkDeal).toFixed(2)} between ${seen(naive).toFixed(2)} and ${seen(windfall).toFixed(2)}`,
  );
  check('and Windfall leaves you holding cards again', (windfall.r.handSizeByTurn[6] ?? 0) > (naive.r.handSizeByTurn[6] ?? 0));

  // The first step of a rule has nothing before it.
  const orphan = play([{ op: 'draw', x: amt('prev') }]);
  check('"the previous X" on the first step is zero', same(orphan.r.cardsSeenByTurn, blank.r.cardsSeenByTurn));

  // And it reads what a step *did*, not what it asked for. A search for a card
  // type this deck does not contain finds nothing and hands on nothing; asking
  // for what it wanted would let a step that failed feed one that succeeds.
  const missed = play([
    { op: 'move', x: { kind: 'fixed', n: 3 } as BehaviorAmount, from: 'library', to: 'hand', q: 't:planeswalker' },
    { op: 'draw', x: amt('prev') },
  ]);
  check('a search that finds nothing carries nothing forward', same(missed.r.cardsSeenByTurn, blank.r.cardsSeenByTurn));

  // A self step carries no number, so "the previous X" reads straight past it.
  const throughSelf = play([
    { op: 'discard', x: amt('hand') },
    { op: 'self', x: { kind: 'fixed', n: 1 } as BehaviorAmount, to: 'exile' },
    { op: 'draw', x: amt('prev') },
  ]);
  check('a self step does not eat the previous X', same(throughSelf.r.cardsSeenByTurn, windfall.r.cardsSeenByTurn));

  // Peer Into the Abyss: half your library. The adjustment runs on the real
  // number and the cap lands after it, so these three have to separate.
  const half = play([{ op: 'draw', x: amt('library', '/', 2) }]);
  const quarter = play([{ op: 'draw', x: amt('library', '/', 4) }]);
  const whole = play([{ op: 'draw', x: amt('library') }]);
  console.log(line('seen  draw library', whole.r.cardsSeenByTurn));
  console.log(line('seen  draw library/2', half.r.cardsSeenByTurn));
  console.log(line('seen  draw library/4', quarter.r.cardsSeenByTurn));
  // Read at turn 3, not turn 6. By six all three have drawn a 60-card deck to
  // the bottom and every curve reads 59.9, which is a check that cannot fail
  // and therefore measures nothing. Three is where the cap has stopped biting
  // on the halved one and the library is still deep enough to tell them apart.
  const at3 = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[3] ?? 0;
  check('half a library beats a quarter of one', at3(half) > at3(quarter), `${at3(half).toFixed(2)} vs ${at3(quarter).toFixed(2)}`);
  check('a whole one beats half', at3(whole) > at3(half), `${at3(whole).toFixed(2)} vs ${at3(half).toFixed(2)}`);
  check('and drawing your library at all beats a blank', seen(whole) > seen(blank));

  // The cap is gone (v0.158.6), and this is the check that says so. It used to
  // clamp every computed amount to 20, which made "draw your library" and
  // "draw 20" the same rule in any deck bigger than forty cards. Turn 2 is the
  // first turn a two-mana spell resolves, so it is where the difference shows
  // before the deck runs out underneath both of them.
  const flat20 = play([{ op: 'draw', x: { kind: 'fixed', n: 20 } as BehaviorAmount }]);
  const at2 = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[2] ?? 0;
  console.log(line('seen  draw 20 flat', flat20.r.cardsSeenByTurn));
  check('a computed amount is no longer capped at 20', at2(whole) > at2(flat20) + 1,
    `${at2(whole).toFixed(2)} vs ${at2(flat20).toFixed(2)}`);
  check('nor is half of one', at2(half) > at2(flat20), `${at2(half).toFixed(2)} vs ${at2(flat20).toFixed(2)}`);

  // Rounding up is a real difference, not just a label. Deliberately NOT
  // measured as "half a library, up vs down": that is one card in fifty, and
  // the two curves came out equal to two decimal places, which is a check that
  // passes on a coin flip. A twentieth of a library is 2 against 3, a ratio
  // large enough per cast that no amount of variance closes it.
  const twentiethDown = play([{ op: 'draw', x: amt('library', '/', 20) }]);
  const twentiethUp = play([{ op: 'draw', x: amt('library', '/^', 20) }]);
  console.log(line('seen  draw library/20', twentiethDown.r.cardsSeenByTurn));
  console.log(line('seen  draw library/20 up', twentiethUp.r.cardsSeenByTurn));
  check(
    'rounding up draws more than rounding down',
    seen(twentiethUp) > seen(twentiethDown) + 1,
    `${seen(twentiethUp).toFixed(2)} vs ${seen(twentiethDown).toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------------
// 14. Casting a card and the card arriving are two different moments
// ---------------------------------------------------------------------------
console.log('\n=== "when played" vs "when it enters" ===');
{
  const CREATURE = card({ name: 'Big Body', typeLine: 'Creature - Avatar', manaCost: '{4}{U}', cmc: 5 });
  const SORCERY = card({ name: 'Plain Sorcery', typeLine: 'Sorcery', manaCost: '{1}{U}', cmc: 2 });
  // Mill it, then drag it back. A two-step rule on a cheap spell, so the
  // reanimation happens early and often enough to read off a curve.
  const REANIMATOR = card({ name: 'Reanimator', typeLine: 'Sorcery', manaCost: '{1}{U}', cmc: 2 });
  const raise = {
    v: 1,
    rules: [
      {
        on: 'play',
        steps: [
          { op: 'mill', x: { kind: 'fixed', n: 4 } },
          { op: 'move', x: { kind: 'fixed', n: 1 }, from: 'graveyard', to: 'battlefield', q: 't:creature' },
        ],
      },
    ],
  } as CardBehavior;
  const rows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 12, board: 'main', oracle: CREATURE },
    { quantity: 12, board: 'main', oracle: REANIMATOR },
    { quantity: 12, board: 'main', oracle: BLANK },
  ];
  const draws2 = (on: string) =>
    ({ v: 1, rules: [{ on, steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] }) as CardBehavior;

  const withRule = (extra: [string, CardBehavior][]) => run(rows, new Map([[REANIMATOR.oracleId, raise], ...extra]));
  const onCast = withRule([[CREATURE.oracleId, draws2('play')]]);
  const onEntry = withRule([[CREATURE.oracleId, draws2('etb')]]);
  console.log(line('seen  creature, on cast', onCast.r.cardsSeenByTurn));
  console.log(line('seen  creature, on entry', onEntry.r.cardsSeenByTurn));
  // A five-drop in a six-turn window is mostly reanimated rather than cast, so
  // the entry trigger has to be worth strictly more than the cast one.
  const seen6 = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[6] ?? 0;
  check(
    'reanimating fires the entry rule and not the cast one',
    seen6(onEntry) > seen6(onCast) + 0.5,
    `${seen6(onEntry).toFixed(2)} vs ${seen6(onCast).toFixed(2)}`,
  );

  // Cast from your hand, a permanent does both, in that order.
  const both = run(
    rows,
    new Map([
      [
        CREATURE.oracleId,
        {
          v: 1,
          rules: [
            { on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] },
            { on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] },
          ],
        } as CardBehavior,
      ],
    ]),
  );
  const castOnly = run(rows, new Map([[CREATURE.oracleId, draws2('play')]]));
  console.log(line('seen  cast rule only', castOnly.r.cardsSeenByTurn));
  console.log(line('seen  cast + entry rule', both.r.cardsSeenByTurn));
  check('a permanent you cast does both', seen6(both) > seen6(castOnly), `${seen6(both).toFixed(2)} vs ${seen6(castOnly).toFixed(2)}`);

  // And a sorcery never enters anything, so an entry rule on one does nothing.
  // The editor does not offer this; the sequencer still has to refuse it,
  // because a row can arrive from a newer client or off a hand-edited sync.
  const sorceryRows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 18, board: 'main', oracle: SORCERY },
    { quantity: 18, board: 'main', oracle: BLANK },
  ];
  const sorceryEntry = run(sorceryRows, new Map([[SORCERY.oracleId, draws2('etb')]]));
  const sorceryNone = run(sorceryRows);
  check(
    'an entry rule on a sorcery does nothing',
    same(sorceryEntry.r.cardsSeenByTurn, sorceryNone.r.cardsSeenByTurn),
    `${seen6(sorceryEntry).toFixed(2)} vs ${seen6(sorceryNone).toFixed(2)}`,
  );

  // The depth guard. Two cards that each drag the other onto the battlefield is
  // a loop, and the first thing to say about it is that the process is still
  // alive to print this line at all.
  //
  // The second is that the loop happened. A guard off by one in the other
  // direction refuses every nested entry trigger, the reanimated Solemn stops
  // fetching, and nothing here would notice -- so each card draws on the way in
  // as well, and the looping pair has to out-draw a pair that only draws.
  const PING = card({ name: 'Ping', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
  const PONG = card({ name: 'Pong', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
  const drawThen = (name: string | null) =>
    ({
      v: 1,
      rules: [
        {
          on: 'etb',
          steps: [
            { op: 'draw', x: { kind: 'fixed', n: 1 } },
            ...(name ? [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'battlefield', q: `name:"${name}"` }] : []),
          ],
        },
      ],
    }) as CardBehavior;
  const pingPongRows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 12, board: 'main', oracle: PING },
    { quantity: 12, board: 'main', oracle: PONG },
    { quantity: 12, board: 'main', oracle: BLANK },
  ];
  const looped = run(
    pingPongRows,
    new Map([
      [PING.oracleId, drawThen('Pong')],
      [PONG.oracleId, drawThen('Ping')],
    ]),
  );
  const flat = run(
    pingPongRows,
    new Map([
      [PING.oracleId, drawThen(null)],
      [PONG.oracleId, drawThen(null)],
    ]),
  );
  console.log(line('seen  each draws on entry', flat.r.cardsSeenByTurn));
  console.log(line('seen  and pulls the other', looped.r.cardsSeenByTurn));
  check(
    'two cards pulling each other in loop, and then stop',
    seen6(looped) > seen6(flat) + 1,
    `${seen6(looped).toFixed(2)} vs ${seen6(flat).toFixed(2)}`,
  );

  check(
    'compiling files an entry rule on its own',
    onlyBucket(compileBehavior(draws2('etb')), 'etb', [{ op: 'draw', x: { kind: 'fixed', n: 2 } }]),
  );
}

// ---------------------------------------------------------------------------
// 15. The fetchland, which used to be the one card you could not write a rule on
// ---------------------------------------------------------------------------
console.log('\n=== fetchlands ===');
{
  // `fetch` is [types, flags]; 'U' is Island, flags 0 is "finds it untapped,
  // and it does not have to be basic".
  const STRAND = card({ name: 'Misty Strand', typeLine: 'Land', cmc: 0, manaCost: '', fetch: ['U', 0] });
  // A fetch with nothing in this deck to find: it eats a land drop and makes
  // no mana, which is what it should have been worth all along.
  const VERGE = card({ name: 'Dead End', typeLine: 'Land', cmc: 0, manaCost: '', fetch: ['G', 0] });
  check('the profile reads as a fetch', describeFetch(decodeFetchProfile(STRAND.fetch)) !== null);
  check('a basic reads as nothing', describeFetch(decodeFetchProfile(ISLAND.fetch)) === null);

  const rows: DeckRow[] = [
    { quantity: 12, board: 'main', oracle: ISLAND },
    { quantity: 12, board: 'main', oracle: STRAND },
    { quantity: 12, board: 'main', oracle: BLANK },
    { quantity: 12, board: 'main', oracle: DIVINATION },
  ];
  const derived = run(rows);

  // The headline. A rule authored on a fetchland used to be a rule you could
  // write, save, and never once see happen: the land-drop path resolved the
  // land it *found* and never the fetch itself.
  const oneStep = (step: BehaviorStep) => ({ v: 1, rules: [{ on: 'play', steps: [step] }] }) as CardBehavior;
  const authored = run(rows, new Map([[STRAND.oracleId, oneStep({ op: 'draw', x: { kind: 'fixed', n: 2 } })]]));
  // The control is NOT the derived run. Authoring anything on a fetch gives up
  // the Island, and by turn six the Islands it did not find are Divinations it
  // did not cast, which swamps two cards in the other direction. This is a
  // fetch with a rule that draws nothing, so the only difference left between
  // the two curves is whether the rule fired at all.
  const quiet = run(rows, new Map([[STRAND.oracleId, oneStep({ op: 'scry', x: { kind: 'fixed', n: 1 } })]]));
  console.log(line('seen  fetch, read from db', derived.r.cardsSeenByTurn));
  console.log(line('seen  fetch, rule scries', quiet.r.cardsSeenByTurn));
  console.log(line('seen  fetch, rule draws 2', authored.r.cardsSeenByTurn));
  const seen6 = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[6] ?? 0;
  check(
    'a rule on a fetchland fires when you play it',
    seen6(authored) > seen6(quiet) + 1,
    `${seen6(authored).toFixed(2)} vs ${seen6(quiet).toFixed(2)}`,
  );
  // And it replaces the search, the same way it replaces land ramp. Writing
  // "draw 2" on a Flooded Strand is giving up the Island, which is the bargain
  // every authored rule makes.
  console.log(line('mana  fetch, read from db', derived.r.manaByTurn));
  console.log(line('mana  fetch, rule authored', authored.r.manaByTurn));
  check(
    'an authored rule gives up the search',
    (authored.r.manaByTurn[6] ?? 0) < (derived.r.manaByTurn[6] ?? 0),
    `${(authored.r.manaByTurn[6] ?? 0).toFixed(2)} vs ${(derived.r.manaByTurn[6] ?? 0).toFixed(2)}`,
  );

  // The second half: a fetch that arrives on the battlefield any other way used
  // to be read as a land that taps for everything it could have found. The one
  // that can find nothing is where that shows up cleanly - it was worth a mana
  // a turn for nothing at all, and now it is worth what it is.
  const RAISE = card({ name: 'Raise Land', typeLine: 'Sorcery', manaCost: '{1}{U}', cmc: 2 });
  const ruleFinding = (q: string) =>
    ({
      v: 1,
      rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'battlefield', q }] }],
    }) as CardBehavior;
  //
  // One deck holding both fetches, so the two runs differ in exactly one thing:
  // which of them the rule reaches for. Comparing either against "pull a real
  // Island" does not work and the first draft of this check did it anyway --
  // `t:island` matches twenty cards in the library and `name:"Dead End"` matches
  // eight, so that check was measuring how often the move found anything.
  const bothRows: DeckRow[] = [
    { quantity: 20, board: 'main', oracle: ISLAND },
    { quantity: 8, board: 'main', oracle: STRAND },
    { quantity: 8, board: 'main', oracle: VERGE },
    { quantity: 12, board: 'main', oracle: RAISE },
  ];
  const pullsDead = run(bothRows, new Map([[RAISE.oracleId, ruleFinding('name:"Dead End"')]]));
  const pullsLive = run(bothRows, new Map([[RAISE.oracleId, ruleFinding('name:"Misty Strand"')]]));
  console.log(line('mana  pulls a dead fetch', pullsDead.r.manaByTurn));
  console.log(line('mana  pulls a live fetch', pullsLive.r.manaByTurn));
  check(
    'a pulled fetch cracks, and a fetch with nothing to find is worth nothing',
    (pullsLive.r.manaByTurn[6] ?? 0) > (pullsDead.r.manaByTurn[6] ?? 0) + 0.3,
    `${(pullsLive.r.manaByTurn[6] ?? 0).toFixed(2)} vs ${(pullsDead.r.manaByTurn[6] ?? 0).toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------------
// 16. The permanent list: the battlefield as permanents, not as mana
// ---------------------------------------------------------------------------
console.log('\n=== permanents ===');
{
  // Two creatures that tap for nothing. Before the permanent list the
  // sequencer had no idea either was on the battlefield: "a reanimated creature
  // is a body this model has no room for" was the comment, and the room is what
  // this section checks for.
  const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature - Bear', manaCost: '{1}{U}', cmc: 2, power: '2' });
  const GIANT = card({ name: 'Hill Giant', typeLine: 'Creature - Giant', manaCost: '{2}{U}', cmc: 3, power: '5' });
  const rows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 14, board: 'main', oracle: BEAR },
    { quantity: 12, board: 'main', oracle: GIANT },
    { quantity: 10, board: 'main', oracle: BLANK },
  ];
  const seen6 = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[6] ?? 0;
  const onPlay = (steps: unknown[]) => ({ v: 1, rules: [{ on: 'play', steps }] }) as CardBehavior;

  // "Draw X, X = creatures you control" against a flat draw 1. By turn six a
  // deck that is half creatures has several out, so the first has to win.
  const byCreatures = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'draw', x: { kind: 'creatures' } }])]]));
  const byOne = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'draw', x: { kind: 'fixed', n: 1 } }])]]));
  console.log(line('seen  draw 1', byOne.r.cardsSeenByTurn));
  console.log(line('seen  draw = creatures', byCreatures.r.cardsSeenByTurn));
  check('creatures you control beats a flat 1', seen6(byCreatures) > seen6(byOne) + 0.5,
    `${seen6(byCreatures).toFixed(2)} vs ${seen6(byOne).toFixed(2)}`);

  // And it counts creatures rather than permanents: the same rule in a deck of
  // lands and blanks reads nothing at all.
  const noCreatures: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 36, board: 'main', oracle: BLANK },
  ];
  const noneOut = run(noCreatures, new Map([[BLANK.oracleId, onPlay([{ op: 'draw', x: { kind: 'creatures' } }])]]));
  const flat = run(noCreatures);
  check('and it is creatures, not lands', same(noneOut.r.cardsSeenByTurn, flat.r.cardsSeenByTurn),
    `${seen6(noneOut).toFixed(2)} vs ${seen6(flat).toFixed(2)}`);

  // Disciple of Freyalise, which is the card §12 opened with: the greatest
  // power among your creatures. A 5 and a 2 are on the battlefield, so this has
  // to beat "creatures you control" once more than one is out, and it has to
  // beat a flat 2 as well.
  const byPower = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'draw', x: { kind: 'power' } }])]]));
  const byTwo = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'draw', x: { kind: 'fixed', n: 2 } }])]]));
  console.log(line('seen  draw 2', byTwo.r.cardsSeenByTurn));
  console.log(line('seen  draw = best power', byPower.r.cardsSeenByTurn));
  check('greatest power beats a flat 2', seen6(byPower) > seen6(byTwo) + 0.5,
    `${seen6(byPower).toFixed(2)} vs ${seen6(byTwo).toFixed(2)}`);
  // Bounded above too. A Hill Giant is 5, so a rule reading the best power can
  // never out-draw a flat 5, and if it does it is counting something else.
  const byFive = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'draw', x: { kind: 'fixed', n: 5 } }])]]));
  console.log(line('seen  draw 5', byFive.r.cardsSeenByTurn));
  check('and never beats the biggest creature in the deck', seen6(byPower) < seen6(byFive),
    `${seen6(byPower).toFixed(2)} vs ${seen6(byFive).toFixed(2)}`);

  // A sacrifice can find a creature. It could not before: the battlefield was
  // the mana sources, so `move 1 from battlefield to graveyard t:creature`
  // matched nothing in a deck whose creatures all tap for nothing.
  const sac = onPlay([
    { op: 'move', x: { kind: 'fixed', n: 1 }, from: 'battlefield', to: 'graveyard', q: 't:creature' },
    { op: 'draw', x: { kind: 'prev' } },
  ]);
  const sacrificing = run(rows, new Map([[BLANK.oracleId, sac]]));
  // Against the same deck with nothing authored, not against `flat`, which is
  // a different deck entirely. A rule that drew a card because the deck it was
  // measured in had fewer lands in it is not a check.
  const plain = run(rows);
  console.log(line('seen  nothing authored', plain.r.cardsSeenByTurn));
  console.log(line('seen  sac a creature, draw', sacrificing.r.cardsSeenByTurn));
  check('a sacrifice finds a creature', seen6(sacrificing) > seen6(plain) + 0.5,
    `${seen6(sacrificing).toFixed(2)} vs ${seen6(plain).toFixed(2)}`);

  // The death trigger, which is what a sacrifice is usually for. Same rule,
  // and the creature it kills draws a card on the way out.
  const dies = {
    v: 1,
    rules: [{ on: 'death', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }],
  } as CardBehavior;
  const withDeath = run(rows, new Map([[BLANK.oracleId, sac], [BEAR.oracleId, dies]]));
  console.log(line('seen  and the Bear dies loud', withDeath.r.cardsSeenByTurn));
  check('sacrificing a creature fires its death rule', seen6(withDeath) > seen6(sacrificing) + 0.5,
    `${seen6(withDeath).toFixed(2)} vs ${seen6(sacrificing).toFixed(2)}`);
  // And only when it dies. The same card milled into the graveyard has not
  // died, and a rule that fired there would be inventing cards out of a mill.
  const milled = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'mill', x: { kind: 'fixed', n: 4 } }])], [BEAR.oracleId, dies]]));
  const milledOnly = run(rows, new Map([[BLANK.oracleId, onPlay([{ op: 'mill', x: { kind: 'fixed', n: 4 } }])]]));
  check('milling a creature is not dying', same(milled.r.cardsSeenByTurn, milledOnly.r.cardsSeenByTurn),
    `${seen6(milled).toFixed(2)} vs ${seen6(milledOnly).toFixed(2)}`);

  // A flicker re-fires an entry rule, which is the whole reason it is a verb.
  // By name, not `t:creature`. Only the Bear has an entry rule, and a flicker
  // that lands on a Hill Giant half the time measures the coin flip as much as
  // it measures the flicker: the first draft read 17.44 against 16.69.
  const blink = onPlay([{ op: 'flicker', x: { kind: 'fixed', n: 1 }, q: 'name:"Grizzly Bears"' }]);
  const entryDraw = { v: 1, rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] } as CardBehavior;
  const blinking = run(rows, new Map([[BLANK.oracleId, blink], [BEAR.oracleId, entryDraw]]));
  const notBlinking = run(rows, new Map([[BEAR.oracleId, entryDraw]]));
  console.log(line('seen  Bear draws on entry', notBlinking.r.cardsSeenByTurn));
  console.log(line('seen  and gets flickered', blinking.r.cardsSeenByTurn));
  check('a flicker fires the entry rule again', seen6(blinking) > seen6(notBlinking) + 1,
    `${seen6(blinking).toFixed(2)} vs ${seen6(notBlinking).toFixed(2)}`);
  // A flicker with nothing matching is not a free draw for the card doing it.
  const blinkNothing = run(noCreatures, new Map([[BLANK.oracleId, blink]]));
  check('a flicker that finds nothing does nothing', same(blinkNothing.r.cardsSeenByTurn, flat.r.cardsSeenByTurn));

  // A permanent somebody sacrificed stops doing what it did every upkeep.
  // Only a `self` step could take a card off the battlefield before this
  // release, so nothing could reach an Arena but the Arena; now any rule can
  // name one, and a dead card left on the upkeep list draws forever.
  const arena = { v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] } as CardBehavior;
  const sacAny = onPlay([{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'battlefield', to: 'graveyard', q: 'name:"Grizzly Bears"' }]);
  const kept = run(rows, new Map([[BEAR.oracleId, arena]]));
  const sacked = run(rows, new Map([[BEAR.oracleId, arena], [BLANK.oracleId, sacAny]]));
  console.log(line('seen  Bear draws each upkeep', kept.r.cardsSeenByTurn));
  console.log(line('seen  and gets sacrificed', sacked.r.cardsSeenByTurn));
  check('a sacrificed permanent stops triggering', seen6(sacked) < seen6(kept) - 0.5,
    `${seen6(sacked).toFixed(2)} vs ${seen6(kept).toFixed(2)}`);

  // The mana view did not go away when the permanent view arrived. A land
  // bounced off the battlefield is the check that says so, and it is the one a
  // careless permanent list breaks: it is the same slot in two arrays.
  const bounce = onPlay([{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'battlefield', to: 'hand', q: 't:island' }]);
  const bouncing = run(rows, new Map([[BLANK.oracleId, bounce]]));
  console.log(line('mana  nothing authored', plain.r.manaByTurn));
  console.log(line('mana  bounces its own land', bouncing.r.manaByTurn));
  check(
    'a land bounced off the battlefield stops making mana',
    (bouncing.r.manaByTurn[6] ?? 0) < (plain.r.manaByTurn[6] ?? 0) - 0.3,
    `${(bouncing.r.manaByTurn[6] ?? 0).toFixed(2)} vs ${(plain.r.manaByTurn[6] ?? 0).toFixed(2)}`,
  );

  check(
    'compiling files a death rule on its own',
    onlyBucket(compileBehavior(dies), 'death', [{ op: 'draw', x: { kind: 'fixed', n: 2 } }]),
  );
  check('a flicker keeps its criteria and drops its zones', (() => {
    const clean = sanitizeCardBehavior({
      v: 1,
      rules: [{ on: 'play', steps: [{ op: 'flicker', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'hand', q: 't:creature' }] }],
    });
    const step = clean?.rules[0]?.steps[0];
    return !!step && step.op === 'flicker' && step.q === 't:creature' && !step.from && !step.to;
  })());
}

// ---------------------------------------------------------------------------
// 17. Combat, which exists for exactly one trigger
// ---------------------------------------------------------------------------
console.log('\n=== attacking ===');
{
  const EDRIC = card({ name: 'Edric', typeLine: 'Creature - Human Rogue', manaCost: '{1}{U}', cmc: 2, power: '2' });
  const rows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 18, board: 'main', oracle: EDRIC },
    { quantity: 18, board: 'main', oracle: BLANK },
  ];
  const seen6 = (r: ReturnType<typeof run>) => r.r.cardsSeenByTurn[6] ?? 0;
  const attacks = { v: 1, rules: [{ on: 'attack', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] } as CardBehavior;
  const swinging = run(rows, new Map([[EDRIC.oracleId, attacks]]));
  const idle = run(rows);
  console.log(line('seen  no attack trigger', idle.r.cardsSeenByTurn));
  console.log(line('seen  draws when it swings', swinging.r.cardsSeenByTurn));
  check('an attack trigger fires every turn it can', seen6(swinging) > seen6(idle) + 1,
    `${seen6(swinging).toFixed(2)} vs ${seen6(idle).toFixed(2)}`);

  // Summoning sickness, which is the one rule of combat this model has. A
  // two-drop cast on turn two attacks on turn three and not before, so the
  // curve cannot move on the turn the first copy lands.
  console.log(line('seen  turn by turn', swinging.r.cardsSeenByTurn));
  check('nothing attacks the turn it arrives', (swinging.r.cardsSeenByTurn[2] ?? 0) === (idle.r.cardsSeenByTurn[2] ?? 0),
    `turn 2: ${(swinging.r.cardsSeenByTurn[2] ?? 0).toFixed(2)} vs ${(idle.r.cardsSeenByTurn[2] ?? 0).toFixed(2)}`);
  check('and it does attack the turn after', (swinging.r.cardsSeenByTurn[3] ?? 0) > (idle.r.cardsSeenByTurn[3] ?? 0),
    `turn 3: ${(swinging.r.cardsSeenByTurn[3] ?? 0).toFixed(2)} vs ${(idle.r.cardsSeenByTurn[3] ?? 0).toFixed(2)}`);

  // An attack rule on something that cannot attack is worth nothing, which is
  // the §11.4 direction. The editor does not offer it; a row off a newer
  // client still has to land somewhere harmless.
  const ROCK = card({ name: 'Mind Stone', typeLine: 'Artifact', manaCost: '{2}', cmc: 2, mana: [1, 1, 0] });
  const rockRows: DeckRow[] = [
    { quantity: 24, board: 'main', oracle: ISLAND },
    { quantity: 18, board: 'main', oracle: ROCK },
    { quantity: 18, board: 'main', oracle: BLANK },
  ];
  const rockSwings = run(rockRows, new Map([[ROCK.oracleId, attacks]]));
  const rockIdle = run(rockRows);
  check('an artifact does not attack', same(rockSwings.r.cardsSeenByTurn, rockIdle.r.cardsSeenByTurn),
    `${seen6(rockSwings).toFixed(2)} vs ${seen6(rockIdle).toFixed(2)}`);

  // A creature flickered is a new object, so it is sick again and does not
  // swing that turn. Measured against the same deck not flickering: the
  // flicker can only ever cost attacks, never add them.
  const blink = {
    v: 1,
    rules: [{ on: 'play', steps: [{ op: 'flicker', x: { kind: 'fixed', n: 1 }, q: 't:creature' }] }],
  } as CardBehavior;
  const blinked = run(rows, new Map([[EDRIC.oracleId, attacks], [BLANK.oracleId, blink]]));
  console.log(line('seen  and gets flickered', blinked.r.cardsSeenByTurn));
  check('a flickered creature is summoning sick again', seen6(blinked) < seen6(swinging),
    `${seen6(blinked).toFixed(2)} vs ${seen6(swinging).toFixed(2)}`);
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);

test('behavior-sim: every check passes', () => {
  expect(failures).toBe(0);
});
