import {
  BASIC_LAND_TYPES,
  decodeFetchProfile,
  decodeManaProfile,
  sourceColors,
  type DeckBoard,
  type DeckFormat,
  type OracleCard,
} from '@mtg/shared';
import { atLeast } from './hypergeom.js';
import { cardsSeen, handSize, type DrawSetup } from './gameModel.js';
import { bindingPips, parseManaCost, pipKey, type PipColor } from './manaCost.js';
import { canPay, missingColors, type ManaUnit, type UnitGroup } from './canPay.js';

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
  /**
   * All of `units` has to be one color (Lotus Field, Gilded Lotus). The payment
   * solver gets these as a group rather than as independent units, because
   * three mana of any one color is not three five-color sources.
   */
  oneColor: boolean;
  /**
   * Its mana has no color we can name: Exotic Orchard reads an opponent's
   * board, and a goldfish has no opponents. It pays generic and no pip.
   */
  generic: boolean;
  /** Spendable only on part of the deck (Ancient Ziggurat). Counted, and footnoted. */
  restricted: boolean;
  /** Turns or activations before it is gone (Urza's Saga, the depletion lands). */
  life: number;
  /** Earliest turn it can pay for a spell cast that same turn. */
  readyTurn: number;
  copies: number;
  /** Enters tapped every time, so it costs a turn. */
  slow: boolean;
  /** How much it makes depends on the board; `units` is a floor of 1. */
  unknown: boolean;
  /** A fetchland: its colors were resolved from what this deck holds, not from the card. */
  fetched: boolean;
  /** A land, so a `grants` effect in this deck widens what it can tap for. */
  isLand: boolean;
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
  /**
   * Sources this deck would need for the threshold, or null when no deck of
   * this shape could hold that many. A 99-card list with 41 lands cannot put
   * 48 black sources in play, so "9 short" was an instruction to nowhere.
   */
  needed: number | null;
  /**
   * The first turn this cost clears the bar with the sources it already has,
   * or null if it never does inside MAX_CHECK_TURN. This is the honest answer
   * when `needed` is null: the card is not late, it is a later card.
   */
  clearsAtTurn: number | null;
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
  /** Fetchland copies in the library whose colors were resolved from the deck. */
  fetches: number;
  /** Colors a granter (Urborg, Chromatic Lantern) adds to every land in the deck. */
  granted: PipColor[];
  /** Copies whose mana is spendable only on part of the deck (Ancient Ziggurat). */
  restricted: number;
  /** Copies whose color depends on an opponent's lands, so they only pay generic. */
  genericOnly: number;
  /** Copies that run out — Urza's Saga, the depletion lands. */
  expiring: number;
}

const faces = (typeLine: string) => typeLine.split('//').map((f) => f.trim());
const isLandFace = (face: string) => /\bLand\b/.test(face);
const isNotACard = (o: OracleCard) => {
  const t = o.typeLine.toLowerCase();
  return t.startsWith('token') || t.includes('emblem') || t === 'card';
};

export const pipColors = (produces: string | undefined): PipColor[] =>
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
export function readyTurn(kind: string, cmc: number, tapped: string): number | null {
  if (kind === 'land') return tapped === 'always' ? 2 : 1;
  if (kind === 'rock' || kind === 'dork') return Math.max(2, Math.ceil(cmc) + 1);
  return null;
}

/**
 * What a fetchland is worth, which is a question about the deck rather than
 * about the card. A Scalding Tarn searches for an Island or a Mountain; what
 * that gets you depends entirely on which Islands and Mountains are in the
 * ninety-nine. In a UR deck it is a blue-or-red source. In a deck also running
 * Hallowed Fountain it is a white source too, because a Hallowed Fountain is an
 * Island — which is why the match is on the *type line* and not on `produces`.
 *
 * Nothing here invents a color: a fetch can only find a land already in the
 * deck, so its colors are always a subset of the deck's. That is why counting
 * fetches cannot turn an uncastable card castable, and why leaving them out
 * only ever understated things.
 *
 * The one place this flatters a deck is the pathological one: eight fetches and
 * a single Island are eight blue sources here, and in a real game the second
 * fetch finds nothing blue. Each land can only be found once, and a
 * hypergeometric over the multiset cannot see that. The panel says so.
 */
export interface FetchTarget {
  typeLine: string;
  colors: PipColor[];
  basic: boolean;
}

/**
 * The lands in this deck a fetch could go and get. Built once and asked many
 * times: the answer is the same for every fetch in the list, and the same
 * question gets asked of every fetch sitting unused in your collection.
 *
 * A fetch searches the library, so only the mainboard can answer it. What it
 * finds has to be a land that makes mana; a Bojuka Bog is findable and worth
 * nothing to a color count.
 */
export function fetchTargets(rows: readonly SourceRow[]): FetchTarget[] {
  const targets: FetchTarget[] = [];
  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0 || r.board !== 'main' || isNotACard(o)) continue;
    const colors = pipColors(o.produces);
    if (colors.length === 0 || !isLandFace(faces(o.typeLine)[0] ?? '')) continue;
    targets.push({ typeLine: o.typeLine, colors, basic: /^Basic\b/i.test(o.typeLine) });
  }
  return targets;
}

/** What one fetchland is worth against those targets. Empty when it finds nothing. */
export function fetchColorsIn(oracle: OracleCard, targets: readonly FetchTarget[]): PipColor[] {
  const profile = decodeFetchProfile(oracle.fetch);
  if (!profile) return [];
  const wanted = [...profile.types].map((letter) => BASIC_LAND_TYPES[letter]).filter((t): t is string => !!t);
  const colors = new Set<PipColor>();
  for (const target of targets) {
    if (profile.basicOnly && !target.basic) continue;
    if (!wanted.some((type) => new RegExp(`\\b${type}\\b`).test(target.typeLine))) continue;
    for (const c of target.colors) colors.add(c);
  }
  return (['W', 'U', 'B', 'R', 'G', 'C'] as PipColor[]).filter((c) => colors.has(c));
}

function fetchSources(rows: readonly SourceRow[], produced: ReadonlyMap<string, DeckSource>): DeckSource[] {
  const fetches: { row: SourceRow; oracle: OracleCard }[] = [];
  const targets = fetchTargets(rows);

  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o)) continue;
    if (o.fetch) fetches.push({ row: r, oracle: o });
  }
  if (fetches.length === 0 || targets.length === 0) return [];

  const byOracle = new Map<string, DeckSource>();
  for (const { row, oracle } of fetches) {
    const existing = byOracle.get(oracle.oracleId);
    if (existing) {
      existing.copies += row.quantity;
      existing.fromCommandZone &&= row.board === 'commander';
      continue;
    }
    const profile = decodeFetchProfile(oracle.fetch)!;
    const colors = fetchColorsIn(oracle, targets);
    if (colors.length === 0) continue;
    byOracle.set(oracle.oracleId, {
      oracleId: oracle.oracleId,
      name: oracle.name,
      colors,
      units: 1,
      // The fetch itself is untapped; what costs you a turn is what it puts
      // down. Evolving Wilds is a turn-two source for the same reason a Temple is.
      readyTurn: profile.tapped === 'always' ? 2 : 1,
      copies: row.quantity,
      slow: profile.tapped === 'always',
      unknown: false,
      oneColor: false,
      generic: false,
      restricted: false,
      life: 0,
      fetched: true,
      isLand: true,
      fromCommandZone: row.board === 'commander',
    });
  }
  // A fetch that shares an oracle id with something already counted as a
  // producer cannot happen, but the caller merges by id, so say it out loud.
  for (const id of byOracle.keys()) if (produced.has(id)) byOracle.delete(id);
  return [...byOracle.values()];
}

/**
 * Colors this deck hands to every land in it — Urborg makes them all Swamps,
 * Chromatic Lantern gives them all an any-color ability.
 *
 * Deck-relative like a fetchland, and for the same reason: these cards never
 * add mana, they add a color *option*, so what one is worth is a fact about the
 * lands around it. This is the mana model's only under-count — an Urborg in a
 * deck with ten Mountains makes eleven black sources and we counted one — and
 * it is fixed with a mask union rather than a count change.
 *
 * The mainboard only. A granter in the command zone is always available, but
 * the shape of that answer ("every land is a Swamp, in the games you have cast
 * your commander") is not something a hypergeometric can carry, and claiming
 * the colors unconditionally would overstate every deck with a Chromatic
 * Lantern commander.
 */
export function grantedColors(rows: readonly SourceRow[]): PipColor[] {
  const granted = new Set<PipColor>();
  for (const r of rows) {
    if (!r.oracle?.grants || r.quantity <= 0 || r.board !== 'main') continue;
    for (const c of pipColors(r.oracle.grants)) granted.add(c);
  }
  return (['W', 'U', 'B', 'R', 'G', 'C'] as PipColor[]).filter((c) => granted.has(c));
}

/** The mana-producing cards in the library, plus the commander, which is always there. */
export function deckSources(rows: readonly SourceRow[]): DeckSource[] {
  const byOracle = new Map<string, DeckSource>();
  /** Reflecting Pool and friends: resolved once the rest of the deck is known. */
  const reflecting: DeckSource[] = [];

  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o)) continue;
    const profile = decodeManaProfile(o.mana);
    if (!profile) continue;
    const ready = readyTurn(profile.kind, o.cmc, profile.tapped);
    if (ready === null) continue;
    // The profile's own colors, not `produces` — which is the union over every
    // ability the card has at any price, and so calls Nykthos a six-color
    // source when the ability we costed at one mana adds {C}.
    const colors = pipColors(sourceColors(profile, o.produces));
    if (colors.length === 0 && !profile.opponent) continue;
    const existing = byOracle.get(o.oracleId);
    if (existing) {
      existing.copies += r.quantity;
      existing.fromCommandZone &&= r.board === 'commander';
      continue;
    }
    const source: DeckSource = {
      oracleId: o.oracleId,
      name: o.name,
      colors,
      units: Math.max(1, profile.adds),
      readyTurn: ready,
      copies: r.quantity,
      slow: profile.tapped === 'always',
      unknown: profile.unknown,
      oneColor: profile.oneColor && profile.adds > 1,
      generic: profile.opponent,
      restricted: profile.restricted,
      life: profile.life,
      fetched: false,
      isLand: profile.kind === 'land',
      fromCommandZone: r.board === 'commander',
    };
    byOracle.set(o.oracleId, source);
    if (profile.reflects) reflecting.push(source);
  }
  for (const source of fetchSources(rows, byOracle)) byOracle.set(source.oracleId, source);

  const sources = [...byOracle.values()];

  // Reflecting Pool taps for any type a land *you* control could produce, which
  // unlike Exotic Orchard's opponent-facing version is a question the decklist
  // answers. Same trick as a fetchland, and a much better answer than either
  // guessing five colors or giving up and calling it colorless.
  for (const pool of reflecting) {
    const from = new Set<PipColor>();
    for (const s of sources) {
      if (s === pool || !s.isLand || s.generic) continue;
      for (const c of s.colors) from.add(c);
    }
    pool.colors = (['W', 'U', 'B', 'R', 'G', 'C'] as PipColor[]).filter((c) => from.has(c));
  }

  const granted = grantedColors(rows);
  if (granted.length > 0) {
    for (const s of sources) {
      if (!s.isLand) continue;
      const widened = new Set<PipColor>([...s.colors, ...granted]);
      s.colors = (['W', 'U', 'B', 'R', 'G', 'C'] as PipColor[]).filter((c) => widened.has(c));
      // A land that only made mana an opponent could is now also, definitely, a
      // Swamp. That is a color we can name, so it stops being generic-only.
      if (s.colors.length > 0) s.generic = false;
    }
  }
  return sources;
}

/**
 * The pool as the payment solver wants it: one unit per mana, capped at what
 * the cost could possibly use. This asks "could the deck ever pay this",
 * not "will you draw it", so every distinct source is assumed available.
 *
 * Two sources don't become plain units. A Lotus Field's three mana are a
 * *group* — three of one color, chosen once — because expanded as independent
 * five-color units they pay {W}{U}{B}, which is a cost the card cannot pay. An
 * Exotic Orchard's mana has no color we can name, so it becomes a unit with no
 * colors: it fills generic and matches no pip.
 */
function unitPool(sources: readonly DeckSource[], cap: number): { units: ManaUnit[]; groups: UnitGroup[] } {
  const units: ManaUnit[] = [];
  const groups: UnitGroup[] = [];
  for (const s of sources) {
    const have = Math.min(s.copies * s.units, cap);
    if (s.oneColor) {
      // Each *copy* picks its own color, so they are separate groups.
      for (let copy = 0; copy < s.copies && groups.length * s.units < cap; copy++) {
        groups.push({ colors: s.colors, count: s.units });
      }
      continue;
    }
    for (let i = 0; i < have; i++) units.push({ colors: s.generic ? [] : s.colors });
  }
  return { units, groups };
}

/** Fewest sources that clear `threshold` for `pips` of them by `seen` cards. */
/**
 * Sources needed to clear the bar, or null when that many cannot exist.
 *
 * The cap is the point. This used to walk all the way to `library` and return
 * whatever it found, which for triple black on turn three in a 99 is 48 — in a
 * deck that holds 41 lands. A target above the deck's own source ceiling is not
 * a shortfall a decklist can close, and printing it as one is how the sheet
 * came to tell a mono-black deck it was nine black sources short of black
 * while the panel above it said the land count was fine.
 */
function sourcesNeeded(library: number, seen: number, pips: number, threshold: number, ceiling: number): number | null {
  for (let n = pips; n <= ceiling; n++) {
    if (atLeast(library, n, seen, pips) >= threshold) return n;
  }
  return null;
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
  /**
   * The most sources of any one colour this deck could possibly have: every
   * source it runs, recoloured. Nothing a decklist edit can do beats it without
   * adding cards, and adding cards is the *other* panel's lever. A target above
   * this is unreachable and gets reported as a turn instead of as a shortfall.
   */
  const ceiling = sources.reduce((n, s) => n + s.copies, 0);
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

    // The turn comes from the cost we parsed, not from Scryfall's `cmc`: a
    // split card's cmc is both halves added together, and an Adventure's cost
    // string holds two of them. You cast one half.
    const turn = Math.min(MAX_CHECK_TURN, Math.max(1, Math.ceil(cost.mana)));
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
      const matching = sources.filter((s) => s.colors.some((c) => g.colors.includes(c)));
      const countBy = (t: number) => matching.filter((s) => s.readyTurn <= t).reduce((n, s) => n + s.copies, 0);
      const available = countBy(turn);
      const p = atLeast(library, Math.min(available, library), seen, g.pips);
      // When it does clear, if it ever does. Sources come online over the turns
      // and you see more cards, so this is monotone and the first hit is the
      // answer. It is what the panel says in place of a shortfall it cannot
      // close, and it is the "when" half of holding every card to its mana value.
      let clearsAtTurn: number | null = null;
      for (let t = turn; t <= MAX_CHECK_TURN; t++) {
        const n = Math.min(countBy(t), library);
        if (atLeast(library, n, cardsSeen(setup, t), g.pips) >= threshold) {
          clearsAtTurn = t;
          break;
        }
      }
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
        needed: sourcesNeeded(library, seen, g.pips, threshold, ceiling),
        clearsAtTurn,
        p,
        ok: p >= threshold,
        commander: r.board === 'commander',
        uncastable: false,
        missing: [],
      };
    }
    if (!worst) continue;

    const pool = unitPool(all, cost.mana);
    if (!canPay(cost, pool.units, pool.groups)) {
      worst.uncastable = true;
      worst.missing = missingColors(cost, pool.units, pool.groups);
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
    fetches: sources.filter((s) => s.fetched).reduce((n, s) => n + s.copies, 0),
    granted: grantedColors(rows),
    restricted: sources.filter((s) => s.restricted).reduce((n, s) => n + s.copies, 0),
    genericOnly: sources.filter((s) => s.generic).reduce((n, s) => n + s.copies, 0),
    expiring: sources.filter((s) => s.life > 0).reduce((n, s) => n + s.copies, 0),
  };
}

/**
 * The one line worth leading with, in whichever of its three shapes fits.
 *
 * "2 white sources short for turn-4 {W}{W}" is the useful one, and it is only
 * honest when the deck could actually hold those two. Where the bar is above
 * the deck's source ceiling there is no shortfall to name, so the line says
 * when the card does come online instead of demanding lands that cannot exist.
 */
export function shortfallHeadline(check: CastCheck): string {
  const color = colorName(check.colors);
  if (check.uncastable) {
    const missing = check.missing.map((c) => colorName([c])).join(' or ');
    return `${check.name} needs ${missing || color} mana this deck doesn't make.`;
  }
  if (check.needed === null) {
    const pips = `${check.pips} ${color} source${check.pips === 1 ? '' : 's'}`;
    const when = check.clearsAtTurn
      ? `It gets there on turn ${check.clearsAtTurn}.`
      : `It doesn't get there inside ${MAX_CHECK_TURN} turns.`;
    return `${check.name} wants ${pips} on turn ${check.turn}, which no manabase this size reaches. ${when}`;
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
