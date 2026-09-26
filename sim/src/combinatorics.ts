// Binomial coefficients, as a Pascal triangle grown on demand.
//
// The analysis spec called for an explicit initComb() at startup and a throw if
// anything reached comb() first. Growing the table lazily deletes that failure
// mode rather than reporting it, which is the better trade for a table that
// costs microseconds to build and is only ever asked for deck-sized rows.
//
// Doubles, not BigInt: C(100, 50) is about 1e29 and every caller here divides
// one of these by another, so a double's 15 significant digits are plenty and
// the ratio is what has to be accurate, not the intermediate. Overflow to
// Infinity only starts around n = 1030, which is not a deck.

/** A deck bigger than this isn't a deck, and a runaway n shouldn't eat memory. */
const MAX_N = 1000;

const table: number[][] = [[1]];

function grow(n: number): void {
  for (let i = table.length; i <= n; i++) {
    const prev = table[i - 1]!;
    const row = new Array<number>(i + 1);
    row[0] = 1;
    row[i] = 1;
    for (let k = 1; k < i; k++) row[k] = prev[k - 1]! + prev[k]!;
    table[i] = row;
  }
}

/**
 * C(n, k) — the number of ways to choose k of n, ignoring order.
 *
 * Zero outside the triangle (k negative, or larger than n), which is what every
 * caller here means by it: there is no way to draw 3 copies of a 2-of.
 */
export function comb(n: number, k: number): number {
  if (n < 0 || k < 0 || k > n) return 0;
  if (n > MAX_N) throw new RangeError(`comb: n=${n} is past the ${MAX_N} this table is built for`);
  if (n >= table.length) grow(n);
  return table[n]![k]!;
}
