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

/** In a PaymentPlan: this unit was not tapped at all. */
export const PAY_UNUSED = -1;
/** In a PaymentPlan: this unit was tapped, and its color did not matter. */
export const PAY_GENERIC = -2;

/**
 * Not "can you pay" but "how did you pay": one assignment of mana to symbols,
 * for the goldfish trace to read back as "Island taps for {U}".
 *
 * Only the trace wants this. Every other caller asks the yes/no question, and
 * an assignment costs an allocation per solve, so it is opt-in rather than
 * always returned.
 *
 * `pool` is the units the solve actually settled on, in a documented order:
 * every unit in `units`, in order, then each group's units in group order, with
 * that group's chosen color. A caller that knows which source pushed which unit
 * can therefore read the assignment straight back onto its battlefield.
 */
export interface PaymentPlan {
  pool: ManaUnit[];
  /** The pips that ended up paid in colored mana, in matching order. */
  pips: Pip[];
  /**
   * For each entry in `pips`, its index in `cost.pips`. A caller that knows
   * which spell contributed which symbols to a shared cost can therefore say
   * which land paid for which spell, and the pips get reordered on the way
   * through (fixed first, then whichever hybrids were paid in colour), so
   * identity is not enough to recover it — two copies of Counterspell share one
   * parsed cost and so share its Pip objects.
   */
  pipSlot: number[];
  /** For each index in `pool`: an index into `pips`, PAY_GENERIC, or PAY_UNUSED. */
  byUnit: Int32Array;
}

/** Enough to say "it worked" when nobody asked for the assignment. */
const YES: PaymentPlan = { pool: [], pips: [], pipSlot: [], byUnit: new Int32Array(0) };

/**
 * Maximum number of pips that can be matched to distinct units. Kuhn's
 * algorithm: for each pip, walk its options looking for a free unit, bumping
 * an already-matched pip along an augmenting path when one exists.
 *
 * `out`, when given, comes back holding the assignment it found: for each unit,
 * the pip it was matched to, or -1.
 */
export function maxMatching(pips: readonly Pip[], units: readonly ManaUnit[], out?: Int32Array): number {
  /** For each unit, the pip currently assigned to it. */
  const takenBy = out ?? new Int32Array(units.length);
  takenBy.fill(-1);
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
  return solve(cost, units, groups, false) !== null;
}

/**
 * The same solve, made to show its working. Null when the cost cannot be paid,
 * which is exactly when `canPay` is false — the two share every line below, so
 * the trace can never claim a cast the simulator refused or refuse one it made.
 */
export function explainPayment(
  cost: ParsedCost,
  units: readonly ManaUnit[],
  groups: readonly UnitGroup[] = [],
): PaymentPlan | null {
  return solve(cost, units, groups, true);
}

function solve(
  cost: ParsedCost,
  units: readonly ManaUnit[],
  groups: readonly UnitGroup[],
  wantPlan: boolean,
): PaymentPlan | null {
  if (groups.length === 0) return payableWith(cost, units, wantPlan);

  /** Groups worth enumerating, by index, and the color each settled one took. */
  const live: number[] = [];
  const fixedColor: (ManaUnit | null)[] = groups.map(() => null);
  let combos = 1;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    if (group.count <= 0) continue;
    const choices = group.colors.length;
    // No color to choose, or more enumeration than we are willing to do: the
    // units become colorless mana, which is the safe direction — they still pay
    // generic and they claim no pip.
    if (choices === 0 || combos * choices > MAX_GROUP_COMBOS) {
      fixedColor[g] = GENERIC_UNIT;
      continue;
    }
    // One color is not a choice, it is just mana.
    if (choices === 1) {
      fixedColor[g] = SINGLE_UNIT[group.colors[0]!];
      continue;
    }
    combos *= choices;
    live.push(g);
  }

  // The pool is always laid out `units` first, then each group's units in group
  // order, whichever way the enumeration goes. Without that the assignment a
  // plan hands back could not be mapped to the permanent that produced it.
  for (let combo = 0; combo < combos; combo++) {
    const chosen = [...fixedColor];
    let rest = combo;
    for (const g of live) {
      const group = groups[g]!;
      chosen[g] = SINGLE_UNIT[group.colors[rest % group.colors.length]!];
      rest = Math.floor(rest / group.colors.length);
    }
    const pool: ManaUnit[] = [...units];
    for (let g = 0; g < groups.length; g++) {
      const unit = chosen[g];
      if (!unit) continue;
      for (let i = 0; i < groups[g]!.count; i++) pool.push(unit);
    }
    const plan = payableWith(cost, pool, wantPlan);
    if (plan) return plan;
  }
  return null;
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
function payableWith(cost: ParsedCost, units: readonly ManaUnit[], wantPlan: boolean): PaymentPlan | null {
  const fixed = bindingPips(cost);
  const flexible = cost.pips.filter((p) => p.genericOut !== null);
  // Where each of those sat in the printed cost. Only the trace reads it, so it
  // is built only when a plan is wanted.
  const fixedSlots: number[] = [];
  const flexSlots: number[] = [];
  if (wantPlan) {
    for (let i = 0; i < cost.pips.length; i++) {
      (cost.pips[i]!.genericOut === null ? fixedSlots : flexSlots).push(i);
    }
  }

  if (flexible.length === 0 || flexible.length > MAX_FLEXIBLE) {
    // Past the cap, and in the ordinary case, pay every flexible pip the cheap
    // way: generic (or, for Phyrexian, life). That is always available, so it
    // can only under-report castability, never over-report it.
    const generic = cost.generic + flexible.reduce((n, p) => n + (p.genericOut ?? 0), 0);
    return feasible(fixed, fixedSlots, generic, units, wantPlan);
  }

  // Which flexible pips to pay in colored mana is a real choice: paying {2/R}
  // with a Mountain costs one mana instead of two, but spends the Mountain that
  // a {R} elsewhere in the cost might have needed. Small enough to just try all.
  for (let mask = 0; mask < 1 << flexible.length; mask++) {
    const pips = [...fixed];
    const slots = wantPlan ? [...fixedSlots] : fixedSlots;
    let generic = cost.generic;
    for (let i = 0; i < flexible.length; i++) {
      const pip = flexible[i]!;
      if (mask & (1 << i)) {
        pips.push(pip);
        if (wantPlan) slots.push(flexSlots[i]!);
      } else generic += pip.genericOut ?? 0;
    }
    const plan = feasible(pips, slots, generic, units, wantPlan);
    if (plan) return plan;
  }
  return null;
}

function feasible(
  pips: readonly Pip[],
  slots: readonly number[],
  generic: number,
  units: readonly ManaUnit[],
  wantPlan: boolean,
): PaymentPlan | null {
  if (units.length < pips.length + generic) return null;
  if (!wantPlan) {
    if (pips.length === 0) return YES;
    return maxMatching(pips, units) === pips.length ? YES : null;
  }

  const byUnit = new Int32Array(units.length).fill(PAY_UNUSED);
  if (pips.length > 0 && maxMatching(pips, units, byUnit) !== pips.length) return null;
  // Whatever the matching left over pays the generic. Which spares they are
  // does not matter — a maximum matching leaves exactly as many as any other
  // assignment of the same size — so take them in battlefield order, which
  // reads as "tap the lands you have left" rather than as an arbitrary pick.
  let owed = generic;
  for (let u = 0; u < units.length && owed > 0; u++) {
    if (byUnit[u] !== PAY_UNUSED) continue;
    byUnit[u] = PAY_GENERIC;
    owed--;
  }
  if (owed > 0) return null;
  return { pool: [...units], pips: [...pips], pipSlot: [...slots], byUnit };
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
