import { decodeManaProfile, type DeckBoard, type DeckFormat, type OracleCard } from '@mtg/shared';
import { atLeast } from './hypergeom.js';
import { cardsSeen, handSize, type DrawSetup } from './gameModel.js';
import { bindingPips, parseManaCost, pipKey, type PipColor } from './manaCost.js';
import { canPay, missingColors, type ManaUnit } from './canPay.js';

// The colored-source report: for every card in the deck, are there enough
// sources of its colors to actually cast it on curve?
//
// This is Frank Karsten's deckbuilding check, computed rather than looked up.
// His published tables come from simulations of a 60-card deck that mulligan
// any hand with fewer than two lands; ours comes from the same exact
// hypergeometric the draw-odds panel uses, over *this* deck's actual size and
// with no mulligan at all. So our count runs stricter than his, and by a
// measured amount rather than a vague one: at his figures our model reads about
// 86-89% for a single pip, 82% for double, 73-76% for triple, which puts us two
// to four sources above him depending on the pip count.
//
// We ship ours anyway, and say so on the face of it. His numbers are not
// reproducible for a 62-card brew or a 40-card limited deck, and importing them
// would mean the probability we display and the target we set came out of two
// models that disagree. One model, stated bar, arithmetic anyone can redo.
//
// What it does not do is the joint question. A card wanting {1}{W}{U} is
// checked for white and for blue separately, and a dual land counts for both.
// The honest joint answer needs a matching solve per possible draw, which is
// the simulator's job (phase 5). What canPay() does cover here is the absolute
// case: whether the deck's whole source pool could ever pay the cost at all,
// which catches the splash you never built the mana for.

/** The probability a card is expected to clear. Karsten's number, and the one everyone quotes. */
export const DEFAULT_THRESHOLD = 0.9;

/** Past this the curve is flat and the question stops being interesting. */
const MAX_CHECK_TURN = 8;

export interface SourceRow {
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

/** One card in the deck that makes mana, and when it can make it. */
export interface DeckSource {
  oracleId: string;
  name: string;
  colors: PipColor[];
  /** Mana it adds once it is online. */
  units: number;
  /** Earliest turn it can pay for a spell cast that same turn. */
  readyTurn: number;
  copies: number;
  /** Enters tapped every time, so it costs a turn. */
  slow: boolean;
  /** How much it makes depends on the board; `units` is a floor of 1. */
  unknown: boolean;
  /**
   * It is the commander, so it is always available and never drawn. Kept out
   * of every count the hypergeometric sees — a card that isn't in the library
   * can't be one of the copies you draw from it — and kept in the payment
   * solver's pool, where "always available" is exactly what it is.
   */
  fromCommandZone: boolean;
}

export interface ColorCount {
  color: PipColor;
  /** Copies in the library that can make it, once everything is online. */
  count: number;
  /** Of those, the ones that always enter tapped. */
  slow: number;
}

/** One card checked against the deck's mana. */
export interface CastCheck {
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  /** The turn we hold it to: its mana value, which is when you want to cast it. */
  turn: number;
  /** How many pips of the binding requirement. */
  pips: number;
  /** The colors that can pay them — one for {W}{W}, two for a hybrid. */
  colors: PipColor[];
  /** Copies in the library that make one of those colors and are online by `turn`. */
  sources: number;
  /** Sources this deck would need for the threshold. */
  needed: number;
  /** Exact odds of holding `pips` of them by `turn`. */
  p: number;
  ok: boolean;
  /** In the command zone, so it is the one card you always have. */
  commander: boolean;
  /** No draw makes this castable: the deck has no mana that pays this cost. */
  uncastable: boolean;
  /** When uncastable, the colors that are missing. */
  missing: PipColor[];
}

export interface ManaReport {
  /** Sources per color, for the colors this deck's costs actually ask for. */
  byColor: ColorCount[];
  /** Every colored card in the deck, worst odds first. */
  checks: CastCheck[];
  /** Checks below the threshold, worst first — the ones worth acting on. */
  shortfalls: CastCheck[];
  library: number;
  /** False when the card DB predates the mana profile, which looks identical to "no sources". */
  hasManaData: boolean;
  /** Cards whose printed cost we could not fully model ({X}, snow). */
  unmodelled: number;
}

const faces = (typeLine: string) => typeLine.split('//').map((f) => f.trim());
const isLandFace = (face: string) => /\bLand\b/.test(face);
const isNotACard = (o: OracleCard) => {
  const t = o.typeLine.toLowerCase();
  return t.startsWith('token') || t.includes('emblem') || t === 'card';
};

const pipColors = (produces: string | undefined): PipColor[] =>
  produces ? ([...produces].filter((c) => 'WUBRGC'.includes(c)) as PipColor[]) : [];

/**
 * When a source can pay for a spell cast on the same turn.
 *
 *   land            turn 1, or turn 2 if it always enters tapped (you play it
 *                   a turn early, which is exactly what the tapland tax measures)
 *   rock, dork      one turn after you could cast it: a Signet cast on two
 *                   lands helps on turn three, and a turn-one dork on turn two
 *
 * Rituals, land ramp and extra-land effects are left out of the count entirely.
 * A ritual is not a source, and what a Rampant Growth fetches depends on what
 * is left in the library — a number we would have to invent.
 */
function readyTurn(kind: string, cmc: number, tapped: string): number | null {
  if (kind === 'land') return tapped === 'always' ? 2 : 1;
  if (kind === 'rock' || kind === 'dork') return Math.max(2, Math.ceil(cmc) + 1);
  return null;
}

/** The mana-producing cards in the library, plus the commander, which is always there. */
export function deckSources(rows: readonly SourceRow[]): DeckSource[] {
  const byOracle = new Map<string, DeckSource>();
  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o)) continue;
    const profile = decodeManaProfile(o.mana);
    if (!profile) continue;
    const ready = readyTurn(profile.kind, o.cmc, profile.tapped);
    if (ready === null) continue;
    const colors = pipColors(o.produces);
    if (colors.length === 0) continue;
    const existing = byOracle.get(o.oracleId);
    if (existing) {
      existing.copies += r.quantity;
      existing.fromCommandZone &&= r.board === 'commander';
      continue;
    }
    byOracle.set(o.oracleId, {
      oracleId: o.oracleId,
      name: o.name,
      colors,
      units: Math.max(1, profile.adds),
      readyTurn: ready,
      copies: r.quantity,
      slow: profile.tapped === 'always',
      unknown: profile.unknown,
      fromCommandZone: r.board === 'commander',
    });
  }
  return [...byOracle.values()];
}

/**
 * The pool as the payment solver wants it: one unit per mana, capped at what
 * the cost could possibly use. This asks "could the deck ever pay this",
 * not "will you draw it", so every distinct source is assumed available.
 */
function unitPool(sources: readonly DeckSource[], cap: number): ManaUnit[] {
  const units: ManaUnit[] = [];
  for (const s of sources) {
    const have = Math.min(s.copies * s.units, cap);
    for (let i = 0; i < have; i++) units.push({ colors: s.colors });
  }
  return units;
}

/** Fewest sources that clear `threshold` for `pips` of them by `seen` cards. */
function sourcesNeeded(library: number, seen: number, pips: number, threshold: number): number {
  for (let n = pips; n <= library; n++) {
    if (atLeast(library, n, seen, pips) >= threshold) return n;
  }
  return library;
}

/**
 * The full report. `library` is the mainboard count — what you shuffle — and
 * the commander is checked alongside it without being counted into it, because
 * it is a card you cast out of a zone you never draw from.
 */
export function manaReport(
  rows: readonly SourceRow[],
  library: number,
  format: DeckFormat | undefined,
  opts: { onPlay?: boolean; threshold?: number } = {},
): ManaReport {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const setup: DrawSetup = { library, handSize: handSize(format, 0), onPlay: opts.onPlay ?? true };
  const all = deckSources(rows);
  /** What you draw: the command zone is not shuffled into it. */
  const sources = all.filter((s) => !s.fromCommandZone);
  const checks: CastCheck[] = [];
  const wanted = new Set<PipColor>();
  let unmodelled = 0;
  const seenOracle = new Set<string>();

  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o)) continue;
    // A land has no mana cost; a modal card with a land on the back has one.
    if (isLandFace(faces(o.typeLine)[0] ?? '')) continue;
    if (seenOracle.has(o.oracleId)) continue;
    seenOracle.add(o.oracleId);

    const cost = parseManaCost(o.manaCost);
    if (cost.unmodelled.length > 0 || cost.hasX) unmodelled++;
    const binding = bindingPips(cost);
    if (binding.length === 0) continue;

    const turn = Math.min(MAX_CHECK_TURN, Math.max(1, Math.ceil(o.cmc)));
    const seen = cardsSeen(setup, turn);

    // Group the pips by what can pay them, so {W}{W} is one requirement for two
    // white and {W/U}{W/U} is one requirement for two of either. The binding
    // requirement is whichever group is least likely to be there.
    const groups = new Map<string, { colors: PipColor[]; pips: number }>();
    for (const pip of binding) {
      const key = pipKey(pip);
      const g = groups.get(key);
      if (g) g.pips++;
      else groups.set(key, { colors: pip.options, pips: 1 });
      for (const c of pip.options) wanted.add(c);
    }

    let worst: CastCheck | null = null;
    for (const g of groups.values()) {
      const available = sources
        .filter((s) => s.readyTurn <= turn && s.colors.some((c) => g.colors.includes(c)))
        .reduce((n, s) => n + s.copies, 0);
      const p = atLeast(library, Math.min(available, library), seen, g.pips);
      if (worst && p >= worst.p) continue;
      worst = {
        oracleId: o.oracleId,
        name: o.name,
        manaCost: o.manaCost ?? '',
        cmc: o.cmc,
        turn,
        pips: g.pips,
        colors: g.colors,
        sources: available,
        needed: sourcesNeeded(library, seen, g.pips, threshold),
        p,
        ok: p >= threshold,
        commander: r.board === 'commander',
        uncastable: false,
        missing: [],
      };
    }
    if (!worst) continue;

    const pool = unitPool(all, cost.mana);
    if (!canPay(cost, pool)) {
      worst.uncastable = true;
      worst.missing = missingColors(cost, pool);
      worst.ok = false;
    }
    checks.push(worst);
  }

  // Uncastable first (a missing color is not a probability problem), then by
  // odds. A tie goes to the more expensive card, which is the harder fix.
  checks.sort((a, b) => Number(b.uncastable) - Number(a.uncastable) || a.p - b.p || b.cmc - a.cmc);

  const byColor: ColorCount[] = ([...'WUBRGC'] as PipColor[])
    .filter((c) => wanted.has(c))
    .map((color) => {
      const of = sources.filter((s) => s.colors.includes(color));
      return {
        color,
        count: of.reduce((n, s) => n + s.copies, 0),
        slow: of.filter((s) => s.slow).reduce((n, s) => n + s.copies, 0),
      };
    });

  return {
    byColor,
    checks,
    shortfalls: checks.filter((c) => !c.ok),
    library,
    hasManaData: sources.length > 0,
    unmodelled,
  };
}

/** "2 white sources short for turn-4 {W}{W}" — the one line worth leading with. */
export function shortfallHeadline(check: CastCheck): string {
  const color = colorName(check.colors);
  if (check.uncastable) {
    const missing = check.missing.map((c) => colorName([c])).join(' or ');
    return `${check.name} needs ${missing || color} mana this deck doesn't make.`;
  }
  const short = Math.max(1, check.needed - check.sources);
  return `${short} ${color} source${short === 1 ? '' : 's'} short for ${check.name} on turn ${check.turn}.`;
}

const COLOR_NAMES: Record<PipColor, string> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
  C: 'colorless',
};

/** "white", or "white-or-blue" for a hybrid requirement. */
export function colorName(colors: readonly PipColor[]): string {
  return colors.map((c) => COLOR_NAMES[c]).join('-or-');
}
