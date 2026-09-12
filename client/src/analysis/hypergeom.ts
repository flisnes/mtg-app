import { comb } from './combinatorics.js';

// Hypergeometric probability: drawing without replacement from a deck, which is
// what every "odds I've drawn X" question in Magic actually is.
//
// All of it is exact and synchronous — no sampling, no confidence interval, no
// caveat beyond the model itself. That is the whole reason these questions get
// answered here rather than in a simulator: the answer is a closed form and it
// arrives in microseconds. Anything that depends on the *order* you drew things
// (available mana, whether a tapland cost you a turn) does not fit here and is
// not forced to; see notes/deck-analysis-mana-model.md §5.

/** P(exactly k of the K interesting cards among n drawn from a deck of N). */
export function pmf(N: number, K: number, n: number, k: number): number {
  if (N < 0 || K < 0 || n < 0 || K > N || n > N) return 0;
  const total = comb(N, n);
  return total === 0 ? 0 : (comb(K, k) * comb(N - K, n - k)) / total;
}

/**
 * P(the drawn count lands in [kMin, kMax]). Both ends are clamped to what is
 * actually reachable, so `between(60, 4, 7, 0, 99)` is 1 rather than a sum that
 * wandered off the end of the triangle.
 */
export function between(N: number, K: number, n: number, kMin: number, kMax: number): number {
  // You cannot draw fewer than n − (N − K): once the uninteresting cards run
  // out, the rest of the hand has to come from K.
  const lo = Math.max(0, kMin, n - (N - K));
  const hi = Math.min(K, n, kMax);
  if (lo > hi) return 0;
  let sum = 0;
  for (let k = lo; k <= hi; k++) sum += pmf(N, K, n, k);
  // Rounding can push a full sweep a hair past 1; a probability above 1 is a
  // bug wearing a decimal point, so clamp it.
  return Math.min(1, sum);
}

/** P(at least k). */
export function atLeast(N: number, K: number, n: number, k: number): number {
  if (k <= 0) return 1;
  return between(N, K, n, k, n);
}

/** P(at most k). */
export function atMost(N: number, K: number, n: number, k: number): number {
  return between(N, K, n, 0, k);
}

/** One bucket of a multi-group draw. Buckets must be disjoint — see groups.ts. */
export interface Category {
  /** Copies of this category in the deck. */
  size: number;
  /** Fewest that must be drawn. */
  min: number;
  /** Most that may be drawn; unbounded when absent ("at most 4 lands" wants it). */
  max?: number;
}

/**
 * P(a draw of n from N satisfies every category at once). An implicit
 * "everything else" bucket of size N − Σsizes soaks up the rest of the hand.
 *
 * Direct enumeration over the feasible count vectors. With the handful of
 * categories any UI will ever ask for, that is a few thousand terms — cheaper
 * than the memo lookup that would avoid it.
 *
 * Σ mins > n is a legitimate "you are asking for more cards than you draw", not
 * a programming error: it returns 0. Categories that overrun the deck are the
 * programming error, and throw.
 */
export function multivariate(N: number, n: number, categories: readonly Category[]): number {
  let sized = 0;
  for (const c of categories) sized += c.size;
  if (sized > N) throw new RangeError(`multivariate: categories total ${sized} in a deck of ${N}`);
  const rest = N - sized;
  const total = comb(N, n);
  if (total === 0) return 0;

  const walk = (i: number, drawn: number, ways: number): number => {
    if (i === categories.length) {
      const left = n - drawn;
      return left >= 0 && left <= rest ? ways * comb(rest, left) : 0;
    }
    const c = categories[i]!;
    const lo = Math.max(0, c.min);
    const hi = Math.min(c.size, c.max ?? c.size, n - drawn);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += walk(i + 1, drawn + k, ways * comb(c.size, k));
    return sum;
  };

  return Math.min(1, walk(0, 0, 1) / total);
}
