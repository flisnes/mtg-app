// A seeded pseudo-random generator for the simulator.
//
// Seeded on purpose: the same deck and the same settings must give the same
// numbers twice. A panel whose percentages shuffle themselves every time React
// re-renders reads as a slot machine, and the whole point of labelling a number
// "simulated" is that the user can still trust it.
//
// xoshiro128** — four 32-bit words of state, no multiply-heavy mixing, and it
// passes the tests that matter at this scale. Math.random() would do the job
// statistically and cannot be seeded, which is the one thing we need.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
}

export function makeRng(seed: number): Rng {
  // Any all-zero state is a fixed point, so splitmix the seed into four words
  // and make sure at least one of them is set.
  let s0 = mix(seed ^ 0x9e3779b9);
  let s1 = mix(s0 ^ 0x85ebca6b);
  let s2 = mix(s1 ^ 0xc2b2ae35);
  let s3 = mix(s2 ^ 0x27d4eb2f);
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const next = (): number => {
    let r = Math.imul(s1, 5);
    r = Math.imul((r << 7) | (r >>> 25), 9);
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    return (r >>> 0) / 4294967296;
  };

  // next() is strictly below 1, so the floor never reaches n.
  return { next, int: (n) => Math.floor(next() * n) };
}

function mix(x: number): number {
  let z = x | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) | 0;
}

/**
 * Fisher-Yates over the first `len` entries of `xs`, in place. The library is a
 * flat Int32Array of card indices, one entry per copy, so a shuffle is the
 * whole of "shuffle up and draw".
 */
export function shuffle(xs: Int32Array, len: number, rng: Rng): void {
  for (let i = len - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = xs[i]!;
    xs[i] = xs[j]!;
    xs[j] = t;
  }
}
