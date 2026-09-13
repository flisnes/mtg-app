import { bindingPips, type ParsedCost, type Pip, type PipColor } from './manaCost.js';

// Can this pile of mana pay this cost?
//
// The question looks like counting and isn't. A dual making W or U, a dual
// making W or B, and a Mountain count as two white sources and one blue, which
// is enough of each for {W}{W}{U} — and they cannot pay it, because the WU
// would have to be both the second white and the blue at once. They pay
// {1}{W}{W} perfectly well. That is bipartite matching between pips and sources
// (Hall's condition), not a per-color comparison of two numbers, and every
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
 *
 * An **empty** `colors` is a real and useful unit: mana that exists but whose
 * color we cannot name. Exotic Orchard makes mana off lands we do not simulate,
 * so it pays the generic part of a cost and never a pip — including {C}, which
 * is a requirement like any other. Empty colors fall out of the matching for
 * free (no pip lists them) while still counting toward the total, which is
 * exactly the behaviour wanted.
 */
export interface ManaUnit {
  colors: readonly PipColor[];
}

/**
 * `count` units that all have to be the *same* color, chosen from `colors`.
 *
 * Lotus Field says "Add three mana of any one color". Expanded as three
 * independent five-color units it pays {W}{U}{B}, which is a cost the card
 * cannot pay and a pool the game cannot produce. As a group it pays {B}{B}{B}
 * and nothing else. Cascading Cataracts is the opposite case ("five mana in any
 * combination"), so it really is independent units — which is why this is
 * derived from the printed clause and never assumed for a multi-color source.
 */
export interface UnitGroup {
  colors: readonly PipColor[];
  count: number;
}

/** Enumerating which flexible pips to pay in color is 2^n; past this we stop trying to be clever. */
const MAX_FLEXIBLE = 8;

/**
 * Color assignments across all groups that we will enumerate. Five choices per
 * group and a deck holds one or two, so this is slack by a wide margin; groups
 * past it degrade to colorless mana, which under-reports and never over-reports.
 */
const MAX_GROUP_COMBOS = 1024;

/** Mana whose color we cannot name: pays generic, matches no pip. */
const GENERIC_UNIT: ManaUnit = { colors: [] };

const SINGLE_UNIT: Record<PipColor, ManaUnit> = {
  W: { colors: ['W'] },
  U: { colors: ['U'] },
  B: { colors: ['B'] },
  R: { colors: ['R'] },
  G: { colors: ['G'] },
  C: { colors: ['C'] },
};

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
 * Can `units` (plus any same-color `groups`) pay `cost`?
 *
 * Groups are resolved first, by trying every color each one could settle on:
 * once a group has picked, its units are ordinary single-color mana and the
 * rest of the solve is unchanged. The enumeration is a mixed-radix count over
 * the groups, bounded by MAX_GROUP_COMBOS.
 */
export function canPay(cost: ParsedCost, units: readonly ManaUnit[], groups: readonly UnitGroup[] = []): boolean {
  if (groups.length === 0) return payableWith(cost, units);

  /** Groups worth enumerating, and everything that resolved to plain units on sight. */
  const live: UnitGroup[] = [];
  const settled: ManaUnit[] = [...units];
  let combos = 1;

  for (const group of groups) {
    if (group.count <= 0) continue;
    const choices = group.colors.length;
    // No color to choose, or more enumeration than we are willing to do: the
    // units become colorless mana, which is the safe direction — they still pay
    // generic and they claim no pip.
    if (choices === 0 || combos * choices > MAX_GROUP_COMBOS) {
      for (let i = 0; i < group.count; i++) settled.push(GENERIC_UNIT);
      continue;
    }
    // One color is not a choice, it is just mana.
    if (choices === 1) {
      const unit = SINGLE_UNIT[group.colors[0]!];
      for (let i = 0; i < group.count; i++) settled.push(unit);
      continue;
    }
    combos *= choices;
    live.push(group);
  }
  if (live.length === 0) return payableWith(cost, settled);

  for (let combo = 0; combo < combos; combo++) {
    const pool = [...settled];
    let rest = combo;
    for (const group of live) {
      const color = group.colors[rest % group.colors.length]!;
      rest = Math.floor(rest / group.colors.length);
      const unit = SINGLE_UNIT[color];
      for (let i = 0; i < group.count; i++) pool.push(unit);
    }
    if (payableWith(cost, pool)) return true;
  }
  return false;
}

/**
 * The pool is settled; now decide the cost. Colored pips are matched to
 * distinct units first; whatever is left over pays the generic, since any mana
 * pays generic. That ordering is not a heuristic — a maximum matching leaves
 * exactly as many units spare as any other assignment of the same size, so if
 * this fails, nothing works.
 *
 * Pips with a way out ({2/W}, Phyrexian) are tried both ways: paid in color
 * when the color is there, paid in generic (or life) when it isn't.
 */
function payableWith(cost: ParsedCost, units: readonly ManaUnit[]): boolean {
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
 *
 * Groups are counted here as if their units were independent, because a witness
 * wants to name a color the deck genuinely lacks. That makes this *under*-report
 * when a same-color group was what blocked the cast — a Lotus Field deck that
 * fails {W}{U}{B} is short no single color, it is short the ability to make two
 * colors at once. Callers read an empty answer as "nothing in particular to
 * blame", not as "nothing was wrong".
 */
export function missingColors(
  cost: ParsedCost,
  units: readonly ManaUnit[],
  groups: readonly UnitGroup[] = [],
): PipColor[] {
  const pool = [...units];
  for (const group of groups) for (let i = 0; i < group.count; i++) pool.push({ colors: group.colors });

  const short = new Set<PipColor>();
  const binding = bindingPips(cost);
  for (const pip of binding) {
    const have = pool.filter((u) => pip.options.some((c) => u.colors.includes(c))).length;
    const wanting = binding.filter((p) => p.options.every((c) => pip.options.includes(c))).length;
    if (have < wanting) for (const c of pip.options) short.add(c);
  }
  return [...short];
}
