import { multivariate, type Category } from './hypergeom.js';
import { cardsSeen, MAX_TURN, type DrawSetup } from './gameModel.js';

// "What are the odds I've drawn N of these by turn T?" — the exact half of the
// deck analysis, and the one question the hypergeometric answers with no
// caveats at all. One point per turn, turn 0 being the opening hand.
//
// It goes through `multivariate` rather than the simpler `between`, with a
// single category, because the mulligan advisor and the "two lands *and* a
// two-drop" query that come next are the same call with more categories. One
// path, exercised from day one.

export interface OddsPoint {
  /** 0 is the opening hand; 1..MAX_TURN are turns. */
  turn: number;
  /** Cards seen by then. */
  seen: number;
  p: number;
}

export interface OddsCurve {
  points: OddsPoint[];
  /** True when the deck simply doesn't hold enough copies — every point is 0. */
  impossible: boolean;
}

/**
 * The per-turn curve for "at least `min` of a group of `copies`" (optionally
 * capped at `max`, for "two to five lands" style questions).
 */
export function oddsCurve(
  setup: DrawSetup,
  copies: number,
  min: number,
  opts: { max?: number; maxTurn?: number } = {},
): OddsCurve {
  const maxTurn = opts.maxTurn ?? MAX_TURN;
  const category: Category = { size: Math.min(copies, setup.library), min, max: opts.max };
  const points: OddsPoint[] = [];
  for (let turn = 0; turn <= maxTurn; turn++) {
    const seen = cardsSeen(setup, turn);
    points.push({ turn, seen, p: multivariate(setup.library, seen, [category]) });
  }
  return { points, impossible: copies < min };
}

/** The first turn the curve reaches `target`, or null if it never does. */
export function turnReaching(curve: OddsCurve, target: number): number | null {
  return curve.points.find((p) => p.p >= target)?.turn ?? null;
}
