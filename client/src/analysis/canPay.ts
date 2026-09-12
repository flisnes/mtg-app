import { bindingPips, type ParsedCost, type Pip, type PipColor } from './manaCost.js';

// Can this pile of mana pay this cost?
//
// The question looks like counting and isn't. A dual making W or U, a dual
// making W or B, and three Mountains hold two "white sources" between them and
// still cannot pay {2}{W}{W} — the same card would have to be both of them.
// They can pay {3}{W} perfectly well. That is bipartite matching between pips
// and sources (Hall's condition), not a comparison of two numbers, and every
// color-aware number the analysis ever reports rides on getting it right.
//
// Everything here is pure, synchronous and small: a hand holds under a dozen
// sources and a cost under a dozen pips, so Kuhn's algorithm on that is a few
// microseconds. It is built and tested before it has a UI on purpose — wrong
// here means confidently wrong everywhere downstream.

/**
 * One mana, and the colors it could be. A Forest is one unit of {G}; a
 * Hallowed Fountain one unit of {W,U}; Sol Ring two units of {C}. Multi-mana
 * sources are expanded into units by the caller, because "two mana" and "one
 * mana twice" pay a cost identically and only the unit count matters here.
 */
export interface ManaUnit {
  colors: readonly PipColor[];
}

/** Enumerating which flexible pips to pay in color is 2^n; past this we stop trying to be clever. */
const MAX_FLEXIBLE = 8;

/**
 * Maximum number of pips that can be matched to distinct units. Kuhn's
 * algorithm: for each pip, walk its options looking for a free unit, bumping
 * an already-matched pip along an augmenting path when one exists.
 */
export function maxMatching(pips: readonly Pip[], units: readonly ManaUnit[]): number {
  /** For each unit, the pip currently assigned to it. */
  const takenBy = new Int32Array(units.length).fill(-1);
  let matched = 0;

  const augment = (pip: number, seen: Uint8Array): boolean => {
    const options = pips[pip]!.options;
    for (let u = 0; u < units.length; u++) {
      if (seen[u]) continue;
      const unit = units[u]!;
      if (!options.some((c) => unit.colors.includes(c))) continue;
      seen[u] = 1;
      const holder = takenBy[u]!;
      if (holder === -1 || augment(holder, seen)) {
        takenBy[u] = pip;
        return true;
      }
    }
    return false;
  };

  for (let p = 0; p < pips.length; p++) {
    if (augment(p, new Uint8Array(units.length))) matched++;
  }
  return matched;
}

/**
 * Can `units` pay `cost`? Colored pips are matched to distinct units first;
 * whatever is left over pays the generic, since any mana pays generic. That
 * ordering is not a heuristic — a maximum matching leaves exactly as many units
 * spare as any other assignment of the same size, so if this fails, nothing works.
 *
 * Pips with a way out ({2/W}, Phyrexian) are tried both ways: paid in color
 * when the color is there, paid in generic (or life) when it isn't.
 */
export function canPay(cost: ParsedCost, units: readonly ManaUnit[]): boolean {
  const fixed = bindingPips(cost);
  const flexible = cost.pips.filter((p) => p.genericOut !== null);

  if (flexible.length === 0 || flexible.length > MAX_FLEXIBLE) {
    // Past the cap, and in the ordinary case, pay every flexible pip the cheap
    // way: generic (or, for Phyrexian, life). That is always available, so it
    // can only under-report castability, never over-report it.
    const generic = cost.generic + flexible.reduce((n, p) => n + (p.genericOut ?? 0), 0);
    return feasible(fixed, generic, units);
  }

  // Which flexible pips to pay in colored mana is a real choice: paying {2/R}
  // with a Mountain costs one mana instead of two, but spends the Mountain that
  // a {R} elsewhere in the cost might have needed. Small enough to just try all.
  for (let mask = 0; mask < 1 << flexible.length; mask++) {
    const pips = [...fixed];
    let generic = cost.generic;
    for (let i = 0; i < flexible.length; i++) {
      const pip = flexible[i]!;
      if (mask & (1 << i)) pips.push(pip);
      else generic += pip.genericOut ?? 0;
    }
    if (feasible(pips, generic, units)) return true;
  }
  return false;
}

function feasible(pips: readonly Pip[], generic: number, units: readonly ManaUnit[]): boolean {
  if (units.length < pips.length + generic) return false;
  if (pips.length === 0) return true;
  return maxMatching(pips, units) === pips.length;
}

/**
 * The colors that are actually short, when a cost can't be paid: the smallest
 * set of pips whose combined options have too few units behind them. This is
 * the witness Hall's condition hands you, and it is what turns "you can't cast
 * this" into "you have no blue".
 */
export function missingColors(cost: ParsedCost, units: readonly ManaUnit[]): PipColor[] {
  const short = new Set<PipColor>();
  for (const pip of bindingPips(cost)) {
    const have = units.filter((u) => pip.options.some((c) => u.colors.includes(c))).length;
    const wanting = bindingPips(cost).filter((p) => p.options.every((c) => pip.options.includes(c))).length;
    if (have < wanting) for (const c of pip.options) short.add(c);
  }
  return [...short];
}
