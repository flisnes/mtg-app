import type { DeckFormat } from '@mtg/shared';

// How many cards you have seen by turn N, which is the only bridge between a
// game of Magic and the hypergeometric math next door.
//
// Deliberately driven by the deck in front of us rather than by the format's
// legal size: a 62-card brew is 62 cards, and quoting odds for the 60 the rules
// require would be quietly answering a different deck's question.

/** A starting hand, before any mulligan. */
export const OPENING_HAND = 7;

/** How far out the curve is worth plotting. Past this, everything is 99%. */
export const MAX_TURN = 6;

export interface DrawSetup {
  /** Cards in the library when the game starts. The command zone is not in it. */
  library: number;
  /** Cards kept in hand after mulligans. */
  handSize: number;
  /** On the play you skip your first draw step. */
  onPlay: boolean;
  /** Flat extra cards seen — the cheap knob for "I expect to cantrip twice". */
  bonusDraws?: number;
}

/**
 * Hand size after `mulligans` mulligans. London deals a fresh seven every time
 * and makes you bottom the difference, so what shrinks is the hand, not the
 * draw. Commander's first mulligan is free.
 */
export function handSize(format: DeckFormat | undefined, mulligans: number): number {
  const free = format === 'commander' ? 1 : 0;
  return Math.max(0, OPENING_HAND - Math.max(0, mulligans - free));
}

/**
 * Cards seen by the end of turn `turn`'s draw step. Turn 0 is the opening hand,
 * before anybody has untapped.
 *
 * On the play turn 1 draws nothing, so turn 1 and the opener are the same seven
 * cards; on the draw they differ by one. That single card is the whole of the
 * play/draw difference in a goldfish model, and it is worth showing because it
 * is also the whole of the difference at the table for this kind of question.
 */
export function cardsSeen(setup: DrawSetup, turn: number): number {
  const draws = turn <= 0 ? 0 : setup.onPlay ? turn - 1 : turn;
  const seen = setup.handSize + draws + (setup.bonusDraws ?? 0);
  // You cannot see more cards than there are. A deck this small has bigger
  // problems, but the math must not report odds for a draw that can't happen.
  return Math.min(seen, setup.library);
}
