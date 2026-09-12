import type { DeckFormat } from '@mtg/shared';
import { atLeast, between, pmf } from './hypergeom.js';
import { cardsSeen, handSize, OPENING_HAND } from './gameModel.js';

// The mulligan advisor — phase 4, and the last piece before the simulator.
//
// Everything here is a hypergeometric on the seven cards you were dealt, so it
// is exact and instant, same as phase 2. What it deliberately does *not* model
// is bottoming: which cards you put back is a judgement about the cards, not a
// count of them, and a count is all this layer has. That is the simulator's
// job, and until then the fine print says so.
//
// The one fact that makes London tractable: every mulligan deals a fresh seven
// from the whole deck. The trials are independent and identical, so the odds of
// *seeing* a keepable hand never change with the number of mulligans taken.
// What shrinks is the hand. That single observation is the whole chain below.

/** The hand nobody ships. Mulligan a five on a land count and the game is gone anyway. */
export const KEEP_ANYTHING_AT = 5;

/** A keep rule: how many of one group a seven has to hold. Lands, usually. */
export interface KeepRule {
  /** Copies of the group in the library. */
  copies: number;
  /** Fewest you'd keep a seven on. */
  min: number;
  /** Most — a flood is a mulligan too. */
  max: number;
}

/** "Your third land by turn three": `need` of the group among the cards seen by `turn`. */
export interface HandGoal {
  need: number;
  turn: number;
}

export interface HandRow {
  /** Copies of the group in the seven you were dealt. */
  inHand: number;
  /** P(dealt exactly this many). */
  pDealt: number;
  verdict: 'keep' | 'short' | 'flood';
  /** P(reaching the goal from here, if you keep it). */
  pGoal: number;
}

export interface HandSizeRow {
  cards: number;
  /** P(the game starts with a hand this size). */
  p: number;
}

export interface MulliganOutlook {
  library: number;
  /** Copies of the group actually in the library. */
  copies: number;
  /** P(a fresh seven passes the rule). Constant across mulligans — see the note above. */
  pKeepable: number;
  /** P(you start the game a card down). */
  pMulligan: number;
  handSizes: HandSizeRow[];
  expectedHandSize: number;
  /** Commander's first mulligan costs no cards, which changes the shape of all of this. */
  freeMulligan: boolean;
  /** One row per opening-hand count, 0 to seven. */
  rows: HandRow[];
  /** P(goal | a seven you'd keep) — the bar every row is read against. */
  pTypical: number;
  goal: HandGoal;
}

export function mulliganOutlook(
  library: number,
  format: DeckFormat | undefined,
  rule: KeepRule,
  goal: HandGoal,
  opts: { onPlay: boolean },
): MulliganOutlook {
  const seven = Math.min(OPENING_HAND, library);
  const copies = Math.min(rule.copies, library);
  const freeMulligan = handSize(format, 1) === OPENING_HAND;
  const pKeepable = seven === 0 ? 0 : between(library, copies, seven, rule.min, rule.max);

  // The chain: keep the first hand that passes, and keep whatever you are on
  // once it gets down to KEEP_ANYTHING_AT. Hand sizes are summed rather than
  // listed per mulligan because Commander's free first one lands on seven
  // twice, and "a seven" is what the player cares about either way.
  const sizes = new Map<number, number>();
  let left = 1;
  for (let m = 0; ; m++) {
    const cards = handSize(format, m);
    const forced = cards <= KEEP_ANYTHING_AT;
    const p = forced ? left : left * pKeepable;
    sizes.set(cards, (sizes.get(cards) ?? 0) + p);
    left -= p;
    if (forced) break;
  }
  const handSizes = [...sizes].map(([cards, p]) => ({ cards, p })).sort((a, b) => b.cards - a.cards);
  const expectedHandSize = handSizes.reduce((sum, r) => sum + r.cards * r.p, 0);
  const pMulligan = Math.max(0, 1 - (sizes.get(OPENING_HAND) ?? 0));

  // Draws between the opener and the end of `turn`. The hand you keep is the
  // seven you were dealt, so the library you draw from is what is left of it.
  const draws = cardsSeen({ library, handSize: seven, onPlay: opts.onPlay }, goal.turn) - seven;

  const rows: HandRow[] = [];
  let keepWeight = 0;
  let keepSum = 0;
  for (let v = 0; v <= seven; v++) {
    const pDealt = pmf(library, copies, seven, v);
    const pGoal = v >= goal.need ? 1 : atLeast(library - seven, copies - v, draws, goal.need - v);
    const verdict = v < rule.min ? 'short' : v > rule.max ? 'flood' : 'keep';
    rows.push({ inHand: v, pDealt, verdict, pGoal });
    if (verdict === 'keep') {
      keepWeight += pDealt;
      keepSum += pDealt * pGoal;
    }
  }

  return {
    library,
    copies,
    pKeepable,
    pMulligan,
    handSizes,
    expectedHandSize,
    freeMulligan,
    rows,
    pTypical: keepWeight > 0 ? keepSum / keepWeight : 0,
    goal,
  };
}
