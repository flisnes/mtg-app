// Mana costs, parsed into what actually has to be paid.
//
// Scryfall gives us the cost as printed ("{2}{W}{W}", "{W/U}{W/U}", "{2/R}",
// "{G/P}"). Every consumer downstream wants the same two things out of it: how
// much generic mana it asks for, and which pips constrain the *colors* of the
// mana that pays it. Those are different questions and only the second one is
// hard, so they get separated here once rather than re-derived per caller.
//
// The deliberate simplifications, all of which the UI states rather than hides:
//   {X}   counted as zero. "Can I cast it on curve" has no answer otherwise.
//   {S}   snow, counted as one generic. We don't track snow permanents.
//   {W/P} Phyrexian, payable with two life, so it never constrains a color.

/** A single mana that a pip can be paid with. Colorless {C} is not a color, but it is a requirement. */
export type PipColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const PIP_COLORS = 'WUBRGC';

const isPipColor = (s: string): s is PipColor => s.length === 1 && PIP_COLORS.includes(s);

/**
 * One symbol that wants a specific kind of mana. A plain `{W}` has one option
 * and no way out; a hybrid `{W/U}` has two; a two-brid `{2/W}` and Phyrexian
 * `{W/P}` have an out, so they never make a deck's colors the problem.
 */
export interface Pip {
  /** Colors that can pay it, in WUBRG order. */
  options: PipColor[];
  /** Generic mana that pays it instead, or null when there is no way around the color. */
  genericOut: number | null;
}

export interface ParsedCost {
  /** Generic mana asked for, {X} at zero. */
  generic: number;
  pips: Pip[];
  /** Total mana the cost asks for if every pip is paid in colored mana. */
  mana: number;
  /** True when the cost contains {X} — the printed cost is a floor, not the price. */
  hasX: boolean;
  /** Symbols we don't model, verbatim, so a caller can say so instead of guessing. */
  unmodelled: string[];
}

const EMPTY: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [] };

/** Pips that must be paid in colored mana — the only ones that constrain a deck. */
export function bindingPips(cost: ParsedCost): Pip[] {
  return cost.pips.filter((p) => p.genericOut === null);
}

/** A stable key for "pips payable by this same set of colors", so {W/U}{W/U} groups together. */
export function pipKey(pip: Pip): string {
  return pip.options.join('');
}

export function parseManaCost(cost: string | null | undefined): ParsedCost {
  if (!cost) return EMPTY;
  const out: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [] };
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cost))) {
    const raw = (m[1] ?? '').trim().toUpperCase();
    if (/^\d+$/.test(raw)) {
      out.generic += Number(raw);
      continue;
    }
    if (raw === 'X' || raw === 'Y' || raw === 'Z') {
      out.hasX = true;
      continue;
    }
    if (raw === 'S') {
      // Snow wants a snow permanent, which we don't track. One generic is the
      // honest floor: it never claims a color the deck might not have.
      out.generic += 1;
      out.unmodelled.push(m[0]!);
      continue;
    }
    if (isPipColor(raw)) {
      out.pips.push({ options: [raw], genericOut: null });
      continue;
    }
    if (raw.includes('/')) {
      const parts = raw.split('/');
      const options: PipColor[] = [];
      let genericOut: number | null = null;
      let bad = false;
      for (const part of parts) {
        if (part === 'P') genericOut = 0; // Phyrexian: two life, no mana at all.
        else if (/^\d+$/.test(part)) genericOut = Math.max(genericOut ?? 0, Number(part));
        else if (isPipColor(part)) options.push(part);
        else bad = true;
      }
      if (bad || options.length === 0) {
        out.generic += 1;
        out.unmodelled.push(m[0]!);
        continue;
      }
      out.pips.push({ options: PIP_COLORS.split('').filter((c) => options.includes(c as PipColor)) as PipColor[], genericOut });
      continue;
    }
    // Anything else ({T} in a cost, {∞}, a symbol printed after this was
    // written): one generic, and named, so nobody has to guess what we did.
    out.generic += 1;
    out.unmodelled.push(m[0]!);
  }
  out.mana = out.generic + out.pips.length;
  return out;
}
