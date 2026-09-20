import type { FetchProfileTuple, ManaProfileTuple, OracleTagDictionary } from '@mtg/shared';
import {
  BASIC_LAND_TYPES,
  FETCH_BASIC_ONLY,
  MANA_BOUNCE,
  MANA_EXPIRES,
  MANA_KINDS,
  MANA_LETTERS,
  MANA_MAYBE_TAPPED,
  MANA_ONE_COLOR,
  MANA_ONE_SHOT,
  MANA_OPPONENT,
  MANA_REFLECTS,
  MANA_RESTRICTED,
  MANA_SICK,
  MANA_TAPPED,
  MANA_UNKNOWN,
} from '@mtg/shared';
import { tagSubtrees } from './oracleTags.js';

// Derives OracleCard.mana: how a card feeds the mana system, so the deck
// analysis can sequence a turn instead of just counting cards. Runs here rather
// than on the client because it wants oracle text, Tagger tags and Scryfall's
// produced_mana in the same place, and the client should not carry a parser.
//
// Two rules hold the whole thing together:
//
//  1. **The tags decide, not the text.** A naive /enters .* tapped/ over the
//     card DB's 1258 lands hits 648 of them — and it is wrong, not merely
//     noisy: Glacial Fortress, Stomping Ground, Steam Vents and Secluded Glen
//     all print "enters tapped" inside a sentence that starts with "unless".
//     Tagger has already split that: `tapland` is the 499 that always do,
//     `conditional-tapland` the 165 that sometimes do. Those two play nothing
//     alike, and no amount of regex gets you the difference without a rules
//     engine.
//
//  2. **Mark what we can't parse; never guess quietly.** Of the ~3,100 cards
//     that come out of here with a profile, ~370 carry MANA_UNKNOWN, and 159 of
//     those are `extraland`, which is unknowable by construction. The rest are
//     the cards whose output depends on the board — Bloom Tender, Charmed
//     Pendant, Astral Cornucopia. They get a floor of 1 and the flag, so a
//     consumer can say "6 cards in this deck produce mana in a way we can't
//     model" instead of quietly reporting a probability with a fudge factor in
//     it.

/** Tag subtrees the derivation keys off, resolved to dictionary indices once. */
export interface ManaTagIndex {
  tapland: ReadonlySet<number>;
  conditionalTapland: ReadonlySet<number>;
  rock: ReadonlySet<number>;
  dork: ReadonlySet<number>;
  landRamp: ReadonlySet<number>;
  multiLandRamp: ReadonlySet<number>;
  ritual: ReadonlySet<number>;
  extraLand: ReadonlySet<number>;
}

const MANA_SLUGS = [
  'tapland',
  'conditional-tapland',
  'mana-rock',
  'mana-dork',
  'land-ramp',
  'multi-land-ramp',
  'ritual',
  'extra-land',
];

export function buildManaTagIndex(dictionary: OracleTagDictionary): ManaTagIndex {
  const sets = tagSubtrees(dictionary, MANA_SLUGS);
  const of = (slug: string) => sets.get(slug) ?? new Set<number>();
  return {
    tapland: of('tapland'),
    conditionalTapland: of('conditional-tapland'),
    rock: of('mana-rock'),
    dork: of('mana-dork'),
    landRamp: of('land-ramp'),
    multiLandRamp: of('multi-land-ramp'),
    ritual: of('ritual'),
    extraLand: of('extra-land'),
  };
}

/** Anything inside `{…}`. */
const SYMBOL = /\{([^}]+)\}/g;

/** What one symbol is worth as mana: `{2}` two, `{G}`/`{W/U}` one, `{T}`/`{E}` nothing. */
function symbolValue(symbol: string): number {
  const generic = Number(symbol);
  if (Number.isFinite(generic)) return generic;
  return /^[WUBRGCS]$/i.test(symbol) || symbol.includes('/') ? 1 : 0;
}

const WRITTEN_NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "three mana", "2 mana" — cards that count in words rather than printing symbols. */
const WRITTEN_AMOUNT = new RegExp(`\\b(\\d+|${WRITTEN_NUMBERS.join('|')}) mana\\b`, 'i');

/**
 * A phrase that makes the amount a fact about the board rather than about the
 * card: "X mana", "that much mana", "for each …". Tested against the whole
 * line, not just the part after "add", because Bloom Tender's "For each color
 * among permanents you control, add one mana of that color" puts the caveat in
 * front and the innocent-looking "one mana" behind.
 */
const BOARD_DEPENDENT = /\bx\b|that much|for each|equal to|any number/i;

/**
 * Mana one alternative of an "Add …" clause produces, or null when we shouldn't
 * put a number on it — which is what MANA_UNKNOWN exists for.
 *
 * The written amount wins over the symbols: in "Add three mana of any one
 * color" the words are the amount and the symbols, where there are any, are
 * only naming the palette to choose from.
 */
function amountOf(part: string): number | null {
  if (BOARD_DEPENDENT.test(part)) return null;
  const written = WRITTEN_AMOUNT.exec(part);
  if (written) {
    const word = written[1]!.toLowerCase();
    const n = Number(word);
    return Number.isFinite(n) ? n : WRITTEN_NUMBERS.indexOf(word) + 1;
  }
  let total = 0;
  for (const m of part.matchAll(SYMBOL)) total += symbolValue(m[1]!);
  return total > 0 ? total : null;
}

/**
 * An "Add …" clause is a *choice* between its comma- and "or"-separated
 * alternatives, so a dual land's "Add {W} or {U}" is one mana and not two,
 * while a Signet's "Add {U}{G}" — one alternative, two symbols — really is two.
 * Getting this backwards is how every land in a two-color deck comes out
 * looking like a Sol Ring.
 */
function addsInClause(clause: string): number | null {
  let best: number | null = null;
  for (const part of clause.split(/,| or /i)) {
    const n = amountOf(part);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * One "add …" on the card, split into everything downstream needs: how much it
 * nets, which colors it makes, and the handful of ways it fails to be an
 * ordinary repeatable source.
 */
interface AddClause {
  /** Mana it nets after its own activation cost, or null when the board decides. */
  net: number | null;
  /**
   * Colors it makes, in MANA_LETTERS order, or '' when we cannot name them —
   * which covers both "we failed to parse it" and "there is no answer"
   * (`opponent`). The two are told apart by the flags, not by this string.
   */
  colors: string;
  /** "Add three mana of any one color": all of `net`, one color. */
  oneColor: boolean;
  /** Colors are whatever an opponent's lands make. */
  opponent: boolean;
  /** Colors are whatever your own lands make. */
  reflects: boolean;
  /** "Spend this mana only to cast a creature spell." */
  restricted: boolean;
  /** The cost spends the card, or a counter it entered with, so it is finite. */
  limited: boolean;
  /**
   * It names a color we cannot resolve — "the chosen color", "your commander's
   * color identity". Citadel Gate's "{T}: Add {W} or one mana of the chosen
   * color" makes two colors and we can only see one, so narrowing to that one
   * would be worse than not narrowing at all.
   */
  vague: boolean;
}

/** "{T}: Add {C}" — a cost you can pay at will, which is what a source is. */
const TAP_COST = /\{T\}/i;

/**
 * The "add" is inside quotation marks, which in Magic's templating always means
 * the ability belongs to something else: Chromatic Lantern's `Lands you control
 * have "{T}: Add one mana of any color."`, Gift of Paradise's `Enchanted land
 * has "…"`, and the reminder text on every card that makes Treasure tokens.
 * The card causes mana to exist and taps for none of it, so Scryfall fills in
 * `produced_mana` and we must not read that as a source.
 */
const QUOTED_ABILITY = /["“'‘]/;

/**
 * The exception, and the only one: a card handing the ability to *itself*.
 * Urza's Saga's `I — This Saga gains "{T}: Add {C}."` is a real {C} source for
 * as long as the Saga is around.
 */
const GAINS_ITSELF = /\bthis [\w' ]+ gains\b/i;

/**
 * A triggered ability, which is every mana doubler ever printed: "Whenever you
 * tap a land for mana, add one mana of any type that land produced." Caged Sun,
 * Vorinclex, Mirari's Wake and Zendikar Resurgent all hang their mana off
 * somebody else's ability and have no way to make mana on their own.
 */
const TRIGGERED = /^\s*(?:whenever|when|at the beginning)\b/i;

/**
 * The cost spends the card itself, so the ability is not what the card does
 * every turn: Black Lotus and Lotus Petal sacrifice, Vivid Crag and the
 * depletion lands spend a counter that entered with them. Either way the clause
 * loses to a plain "{T}: Add" printed on the same card — Crystal Vein's "{T},
 * Sacrifice this land: Add {C}{C}" is a one-off cash-in, and reading it as the
 * land's output is how a one-mana land gets credited with two every turn.
 */
const SELF_LIMITED = /\bsacrifice (?:this|it)\b|\bremove an? [\w-]+ counter from (?:this|it)\b/i;

/** "Add one mana of any color that a land an opponent controls could produce." */
const OPPONENT_COLORS = /\ban opponent controls could produce\b/i;
/** Reflecting Pool: the same sentence about a zone we *can* see. */
const OWN_COLORS = /\ba land you control could produce\b/i;
/** Ancient Ziggurat, Cavern of Souls: real mana, spendable on part of the deck. */
const RESTRICTED_USE = /\bspend this mana only\b/i;
/** "Add three mana of any one color" — Lotus Field, Black Lotus, Chromatic Orrery. */
const ONE_COLOR_WORDING = /\bany one color\b|\bthe same color\b/i;

/** "of any color" is the five; "of any type" also includes colorless. */
const ANY_COLOR = /\bof any color\b/i;
const ANY_TYPE = /\bof any type\b/i;

/** A color chosen at some point we do not simulate, so we cannot name it. */
const VAGUE_COLOR = /\bthe chosen color\b|\bchosen type\b|\bcolor identity\b/i;

/**
 * Which colors a clause makes. Read off the clause and not off Scryfall's
 * `produced_mana`, which is the union over every ability the card has at every
 * price — the whole reason Nykthos reads as a six-color source when the ability
 * we costed at one mana adds {C}.
 */
function colorsInClause(body: string): string {
  if (OPPONENT_COLORS.test(body) || OWN_COLORS.test(body)) return '';
  if (ANY_TYPE.test(body)) return MANA_LETTERS;
  if (ANY_COLOR.test(body)) return MANA_LETTERS.replace('C', '');
  const seen = new Set<string>();
  for (const m of body.matchAll(SYMBOL)) {
    for (const part of m[1]!.toUpperCase().split('/')) {
      if (MANA_LETTERS.includes(part) && part.length === 1) seen.add(part);
    }
  }
  return [...MANA_LETTERS].filter((c) => seen.has(c)).join('');
}

/** "{T}: Add …", once per line, with the cost that precedes it. */
const ADD_CLAUSE = /^(.*?)\badd ([^.\n]*)/i;

/**
 * The clause adds *mana* and not something else. `\badd ` happily matches "add
 * a lore counter" and Class reminder text's "add its ability", which were
 * harmless while all we read off a clause was a number — they parse to nothing
 * — and stopped being harmless the moment the mere existence of a clause
 * started deciding whether the card is a source at all.
 */
const ADDS_MANA = /\{[WUBRGCSX0-9/]+\}|\bmana\b/i;

/**
 * Every "add …" the card can perform *itself*.
 *
 * Two exclusions carry §9.D, and both are about the same mistake: Scryfall
 * fills in `produced_mana` for anything that causes mana to be added, and the
 * old fallback read that as "this card taps for mana". Caged Sun has no tap
 * ability at all and was being counted as a one-mana any-color rock; Vorinclex
 * was filed as a `dork`, so the sequencer would cast a six-mana 6/6 as ramp and
 * then tap it. A card whose only "add" is granted to other permanents, or hangs
 * off a trigger, is not a source. Dropping the odd genuinely-triggered producer
 * along with them under-counts, which is the safe direction.
 */
function ownClauses(oracleText: string | null): AddClause[] {
  const out: AddClause[] = [];
  for (const line of (oracleText ?? '').split('\n')) {
    const m = ADD_CLAUSE.exec(line);
    if (!m) continue;
    const cost = m[1] ?? '';
    const body = m[2] ?? '';
    if (QUOTED_ABILITY.test(cost) && !GAINS_ITSELF.test(cost)) continue;
    if (TRIGGERED.test(cost)) continue;
    if (!ADDS_MANA.test(body)) continue;

    // The amount is read from the cost and the clause only. The *rest* of the
    // line is a different sentence and routinely mentions {X} for reasons that
    // have nothing to do with how much mana this makes — Rosheen Meanderer's
    // "Spend this mana only on costs that contain {X}" follows a perfectly
    // countable {C}{C}{C}{C}, and letting it reach BOARD_DEPENDENT turns four
    // mana into an unknown one.
    let net: number | null = null;
    if (!BOARD_DEPENDENT.test(cost + ' add ' + body)) {
      const gross = addsInClause(body);
      if (gross !== null) {
        let paid = 0;
        for (const s of cost.matchAll(SYMBOL)) paid += symbolValue(s[1]!);
        net = Math.max(0, gross - paid);
      }
    }
    out.push({
      net,
      colors: colorsInClause(body),
      oneColor: ONE_COLOR_WORDING.test(body),
      opponent: OPPONENT_COLORS.test(body),
      reflects: OWN_COLORS.test(body),
      // Where the mana may be spent *is* in the following sentence, so this one
      // reads the whole line.
      restricted: RESTRICTED_USE.test(line),
      limited: SELF_LIMITED.test(cost) && TAP_COST.test(cost),
      vague: VAGUE_COLOR.test(body),
    });
  }
  return out;
}

/** What the profile is built from: the card's best repeatable ability, or abilities. */
interface Chosen {
  /** Mana it nets, or null when the board decides. */
  net: number | null;
  /** Union of the colors every tied unrestricted clause makes. */
  colors: string;
  oneColor: boolean;
  opponent: boolean;
  reflects: boolean;
  /** Every clause at this price is spendable only on part of the deck. */
  restricted: boolean;
  /** Every clause at this price spends the card, so the mana comes once. */
  limited: boolean;
}

/**
 * Pick the ability the profile describes.
 *
 * Repeatable first, because Crystal Vein's "{T}, Sacrifice this land: Add
 * {C}{C}" nets more than its "{T}: Add {C}" and is not what the land does every
 * turn — taking the bigger number is how a one-mana land ends up credited with
 * two mana a turn forever. When every clause spends the card (Black Lotus,
 * Lotus Petal), the best of those wins and the caller marks it one-shot.
 *
 * How much it adds and which colors it makes then come apart, and they have to.
 * `adds` is one ability's output — you tap the card once. The colors are the
 * union over *every* ability you can use for free, because you choose which one
 * each time you tap: Shivan Reef prints "{T}: Add {C}" and "{T}: Add {U} or
 * {R}", and Phyrexian Tower "{T}: Add {C}" beside a two-mana black one. Picking
 * a single clause for both turns the first into a Wastes and the second into a
 * land that cannot pay {C}.
 *
 * Three kinds of clause stay out of that union, each for its own reason:
 * restricted ones, because Cavern of Souls only makes its any-color mana for
 * one creature type and {C} is the honest half; limited ones, because Vivid
 * Crag's any-color mode runs out; and vague ones, because naming half of
 * Citadel Gate's two colors is worse than naming neither. When the exclusions
 * leave nothing — Ancient Ziggurat is restricted and nothing else — the best
 * clause speaks for the card and carries its flag.
 */
function bestClause(clauses: readonly AddClause[]): Chosen | undefined {
  const repeatable = clauses.filter((c) => !c.limited);
  const pool = repeatable.length > 0 ? repeatable : clauses;
  if (pool.length === 0) return undefined;

  /** null nets sort last: a number we parsed beats one we didn't. */
  const rank = (c: AddClause) => (c.net === null ? -1 : c.net);
  const best = Math.max(...pool.map(rank));
  const tied = pool.filter((c) => rank(c) === best);
  const open = tied.filter((c) => !c.restricted);
  const winners = open.length > 0 ? open : tied;

  /** Every ability that actually hands you mana at no price but the tap. */
  const free = pool.filter((c) => !c.restricted && !c.vague && (c.net ?? 0) >= 1);
  const speaking = free.length > 0 ? free : winners;
  const colors = new Set<string>();
  for (const c of speaking) for (const letter of c.colors) colors.add(letter);

  return {
    net: best < 0 ? null : best,
    colors: speaking.some((c) => c.vague) ? '' : [...MANA_LETTERS].filter((c) => colors.has(c)).join(''),
    oneColor: winners.every((c) => c.oneColor),
    opponent: speaking.every((c) => c.opponent),
    reflects: speaking.every((c) => c.reflects),
    restricted: winners.every((c) => c.restricted),
    limited: repeatable.length === 0,
  };
}

/**
 * Ramp that actually puts a land into play. The `land-ramp` tag is broader than
 * that — it also carries cards that only fetch to hand, and a scattering that
 * look like mis-tags (Volition Reins) — and this is the sentence the real ones
 * all print.
 */
const PUTS_LAND_IN_PLAY = /onto the battlefield/i;

/** Fetched lands overwhelmingly arrive tapped, and here the text says so plainly. */
const FETCHES_TAPPED = /onto the battlefield tapped/i;

/**
 * An Exploration, and nothing that merely looks like one.
 *
 * The `extra-land` tag is the loosest of the eight: 162 cards carry it, and
 * only about thirty of them actually let you play more lands. The rest put a
 * land onto the battlefield some other way — Arboreal Grazer out of your hand,
 * Elvish Rejuvenator off the top five — which Tagger files under the same
 * heading because the *outcome* rhymes. It does not play alike at all: the
 * simulator's `extraland` is a permanent granting a land drop every turn for
 * the rest of the game, so reading one off a Grazer invents seven land drops
 * out of a 1/2 with reach.
 *
 * So the tag decides the family and the text decides membership, which is rule
 * 1 of this file pointed at the one tag that needed it. "On each of your turns"
 * is the whole discriminator: a card that says "this turn" is a one-shot the
 * sequencer could not honour anyway — its land drop for the turn has already
 * happened by the time the spell resolves.
 *
 * "Additional" is optional only because Fastbond does not print it: "you may
 * play any number of lands on each of your turns" is the same card said the
 * other way round. The tag still has to agree, which is what keeps that
 * looseness from reaching anything else.
 */
const EXTRA_LAND_DROP =
  /play (?:up to )?(an|one|two|three|four|five|x|any number of) (?:additional )?lands?[^.\n]*(?:on|during) each of (?:your|their) turns/i;

/** How many extra drops it grants. Azusa is two, and everything else printed is one. */
const EXTRA_LAND_COUNTS: Record<string, number> = { an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * "This land enters tapped with two depletion counters on it", and the ability
 * removes one to pay. Two activations and it sacrifices itself, so an
 * eight-turn simulation that models Peat Bog as a permanent credits it with
 * sixteen mana instead of four.
 */
const DEPLETION = /\bwith (\w+) depletion counters?\b/i;

/** A Saga sacrifices itself after its last chapter; the numeral says how many turns. */
const SAGA_LIFETIME = /\bsacrifice after (I+)\b/i;

/** Lotus Field: three permanents become one. Net minus two lands, and we counted it a bonus. */
const SACS_LANDS_ON_ENTRY = /\benters,? sacrifice (\w+) lands?\b/i;

/**
 * The Karoos. The land comes back, which is a spare land drop and not a loss.
 * Two generations word it differently: the Ravnica cycle triggers a return, the
 * Visions cycle makes returning a land the price of keeping this one. Same
 * arithmetic either way — you are down a land in play and up one in hand.
 */
const BOUNCES_LAND_ON_ENTRY =
  /\benters,? return an? [\w ]*land you control to its owner's hand\b|\bsacrifice it unless you return an? [\w ]*(?:land|Plains|Island|Swamp|Mountain|Forest) you control to its owner's hand\b/i;

/** "Each land is a Swamp in addition to its other land types." */
const GRANTS_BASIC_TYPE = /\beach land is an? (Plains|Island|Swamp|Mountain|Forest)\b/i;

/** Prismatic Omen, Dryad of the Ilysian Grove. */
const GRANTS_EVERY_TYPE = /\blands you control are every basic land type\b/i;

/** Chromatic Lantern, Joiner Adept: the ability itself, handed to every land. */
const GRANTS_ANY_COLOR = /\blands you control have "[^"]*\badd one mana of any color/i;

export interface ManaProfileInput {
  typeLine: string;
  oracleText: string | null;
  /** MANA_LETTERS-ordered production string; '' when the card adds no mana. */
  produces: string;
  /** The card's own tag indices (OracleCard.tags), unexpanded. */
  tags: readonly number[] | undefined;
}

/** A written or digit count, as a number — "two" depletion counters, "two" lands. */
function countWord(word: string): number {
  const n = Number(word);
  if (Number.isFinite(n)) return n;
  const i = WRITTEN_NUMBERS.indexOf(word.toLowerCase());
  return i >= 0 ? i + 1 : 0;
}

/**
 * How long the source lasts, in turns or activations, or 0 for "forever".
 *
 * Urza's Saga gains "{T}: Add {C}" from chapter I the turn it enters and
 * sacrifices itself after III. The lore counter goes on at precombat main, so
 * you get to tap it on the turn it dies too: three turns of {C}, then nothing.
 */
function lifetimeOf(card: ManaProfileInput): number {
  const text = card.oracleText ?? '';
  const depletion = DEPLETION.exec(text);
  if (depletion) return countWord(depletion[1]!);
  if (/\bSaga\b/.test(card.typeLine)) {
    const saga = SAGA_LIFETIME.exec(text);
    if (saga) return saga[1]!.length;
  }
  return 0;
}

/** Lands it costs you as it enters, and whether they come back. */
function entryCostOf(oracleText: string | null): { entry: number; bounce: boolean } {
  const text = oracleText ?? '';
  if (BOUNCES_LAND_ON_ENTRY.test(text)) return { entry: 1, bounce: true };
  const sacs = SACS_LANDS_ON_ENTRY.exec(text);
  if (sacs) return { entry: countWord(sacs[1]!), bounce: false };
  return { entry: 0, bounce: false };
}

/**
 * Colors this card hands to every land you control, or undefined for the ~35k
 * that hand out nothing.
 *
 * These cards never add mana, they add a color *option*, so they are a mask to
 * union into other sources rather than a source of their own. Urborg's own
 * `produces` of `B` is right about Urborg and blind to the other half: in a
 * deck with ten Mountains it makes eleven black sources, and the mana model's
 * only under-count is counting it as one.
 */
export function grantsOf(card: ManaProfileInput): string | undefined {
  const text = card.oracleText ?? '';
  if (GRANTS_EVERY_TYPE.test(text) || GRANTS_ANY_COLOR.test(text)) return MANA_LETTERS.replace('C', '');
  const basic = GRANTS_BASIC_TYPE.exec(text);
  if (basic) {
    const type = basic[1]!.toLowerCase();
    const letter = Object.entries(BASIC_LAND_TYPES).find(([, name]) => name.toLowerCase() === type)?.[0];
    if (letter) return letter;
  }
  return undefined;
}

/**
 * The card's mana profile, or undefined when it neither produces mana nor ramps.
 *
 * Precedence is deliberate and the order below is the order to read it in: a
 * land that also ramps is a land, a creature that taps for mana is a dork
 * whatever else it does. Only the first match wins, so every card gets exactly
 * one kind and the sequencer never has to reconcile two.
 */
export function manaProfileOf(card: ManaProfileInput, index: ManaTagIndex): ManaProfileTuple | undefined {
  const tags = card.tags ?? [];
  const tagged = (set: ReadonlySet<number>) => tags.some((t) => set.has(t));
  const kindOf = (k: (typeof MANA_KINDS)[number]) => MANA_KINDS.indexOf(k);

  const isLand = /\bLand\b/.test(card.typeLine);
  const isCreature = /\bCreature\b/.test(card.typeLine);
  const clauses = ownClauses(card.oracleText);
  const clause = bestClause(clauses);
  const parsed = clause?.net ?? null;
  /** It can make mana by itself, rather than causing somebody else's land to. */
  const ownsMana = clauses.length > 0;

  /**
   * Everything past `flags` in the tuple, trimmed back to nothing for the great
   * majority of cards that need none of it.
   */
  const tail = (colors: string | null, life = 0, entry = 0): (string | null | number)[] => {
    const parts: (string | null | number)[] = [colors, life, entry];
    while (parts.length && (parts.at(-1) === 0 || parts.at(-1) === null)) parts.pop();
    return parts;
  };

  /** Flags the chosen clause implies, whatever kind of card it sits on. */
  const clauseFlags = (): number =>
    (clause?.oneColor && (clause.net ?? 0) > 1 ? MANA_ONE_COLOR : 0) |
    (clause?.opponent ? MANA_OPPONENT : 0) |
    (clause?.reflects ? MANA_REFLECTS : 0) |
    (clause?.restricted ? MANA_RESTRICTED : 0);

  /**
   * The clause's colors, or null to fall back to `produces`.
   *
   * Narrowing only happens when we could actually *name* a narrower set. A
   * clause we failed to read (Bloom Tender's devotion-style counting) keeps
   * `produces`, because the alternative is telling a five-color dork it makes
   * nothing. An opponent-dependent clause is the one case where empty is the
   * answer rather than a failure, and it is flagged as such.
   */
  const clauseColors = (): string | null => {
    if (!clause) return null;
    if (clause.opponent) return '';
    if (!clause.colors) return null;
    // Only ever narrow. `produced_mana` is the union over everything the card
    // can do, so it is an upper bound by construction: a parse that comes out
    // *wider* has misread the text, and trusting it would have us claiming
    // colors the card cannot make — the one kind of error this whole section
    // exists to stop.
    const narrowed = [...clause.colors].filter((c) => card.produces.includes(c)).join('');
    return narrowed === card.produces ? null : narrowed;
  };

  if (isLand && card.produces) {
    // Lands tap for one unless they say otherwise (Ancient Tomb, Crystal Vein),
    // and unlike a rock a land with no printed mana ability is a basic — whose
    // one mana is a rule, not text. So an unparsed land is 1, not unknown.
    const life = lifetimeOf(card);
    const { entry, bounce } = entryCostOf(card.oracleText);
    const flags =
      (tagged(index.tapland) ? MANA_TAPPED : tagged(index.conditionalTapland) ? MANA_MAYBE_TAPPED : 0) |
      clauseFlags() |
      (life ? MANA_EXPIRES : 0) |
      (bounce ? MANA_BOUNCE : 0);
    return [kindOf('land'), parsed ?? 1, flags, ...tail(clauseColors(), life, entry)] as ManaProfileTuple;
  }

  // A mana creature's mana arrives a turn late. Checked before `rock` because
  // Tagger tags a few artifact creatures as both.
  if (card.produces && ownsMana && (tagged(index.dork) || (isCreature && parsed !== null))) {
    const flags = MANA_SICK | clauseFlags() | (parsed === null ? MANA_UNKNOWN : 0) | (clause?.limited ? MANA_ONE_SHOT : 0);
    return [kindOf('dork'), parsed ?? 1, flags, ...tail(clauseColors())] as ManaProfileTuple;
  }
  if (card.produces && ownsMana && tagged(index.rock)) {
    const flags = clauseFlags() | (parsed === null ? MANA_UNKNOWN : 0) | (clause?.limited ? MANA_ONE_SHOT : 0);
    return [kindOf('rock'), parsed ?? 1, flags, ...tail(clauseColors())] as ManaProfileTuple;
  }
  if (card.produces && ownsMana && tagged(index.ritual)) {
    const flags = MANA_ONE_SHOT | clauseFlags() | (parsed === null ? MANA_UNKNOWN : 0);
    return [kindOf('ritual'), parsed ?? 1, flags, ...tail(clauseColors())] as ManaProfileTuple;
  }

  // Exploration, Azusa: worth a land drop only while you have spare lands in
  // hand, which is a property of the game state and not of the card. Recorded
  // so the UI can list it, flagged so nobody sums it. Checked before landramp
  // because Tagger files these under both.
  const extra = tagged(index.extraLand) ? EXTRA_LAND_DROP.exec(card.oracleText ?? '') : null;
  if (extra) {
    // "X additional lands" and "any number of" are a number off the board, so
    // they keep the floor of 1 the flag already implies. The flag itself is set
    // either way: what an extra drop is *worth* depends on holding a spare
    // land, which is unknowable from the card and always has been.
    return [kindOf('extraland'), EXTRA_LAND_COUNTS[extra[1]!.toLowerCase()] ?? 1, MANA_UNKNOWN];
  }
  // Ramp that fetches cardboard rather than tapping for mana, so it has no
  // `produces` of its own: what it makes is whatever land it finds.
  if (tagged(index.landRamp) && PUTS_LAND_IN_PLAY.test(card.oracleText ?? '')) {
    const flags = FETCHES_TAPPED.test(card.oracleText ?? '') ? MANA_TAPPED : 0;
    return [kindOf('landramp'), tagged(index.multiLandRamp) ? 2 : 1, flags];
  }

  // Produces mana but fits no family Tagger names — an Ornithopter of Paradise
  // nobody has tagged yet, a one-off enchantment. Still a source; call it a
  // rock, which is the kind with no timing quirks.
  //
  // `ownsMana` is the guard §9.D asks for, and it is the whole reason this
  // branch was dangerous: `produced_mana` is filled in for anything that causes
  // mana to be added, so without it Caged Sun — which has no tap ability at all
  // — shipped as a one-mana any-color rock, and Mirari's Wake, Zendikar
  // Resurgent, both Gauntlets and Joiner Adept alongside it.
  if (card.produces && ownsMana) {
    const flags = clauseFlags() | (parsed === null ? MANA_UNKNOWN : 0) | (clause?.limited ? MANA_ONE_SHOT : 0);
    return [kindOf('rock'), parsed ?? 1, flags, ...tail(clauseColors())] as ManaProfileTuple;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Fetchlands
//
// Scryfall gives a fetchland no `produced_mana`, and it is right not to: a
// Scalding Tarn adds no mana, it trades itself for a card. So the profile above
// skips it entirely, and until this existed a fetch was invisible to every
// colored-source count in the app — which on an eight-fetch manabase is not a
// rounding error. A UR deck's turn-two Counterspell read 29% when the honest
// figure was 69%.
//
// What a fetch is worth is a fact about the deck, not the card: it makes every
// color of every land it could find *in that decklist*. So all that is derived
// here is the search terms, and the resolving happens on the client, where a
// decklist is in scope.
//
// This is text parsing, which rule 1 above says to distrust — but there is no
// tag for "and it finds an Island or a Mountain", and the sentence these cards
// print is one sentence with no "unless" in it. The parse is anchored on
// "Search your library for … onto the battlefield" and only ever emits the five
// basic land types, so a card that searches for something we don't model (a
// Desert, a Sphere) comes out as no fetch at all rather than as a wrong one.

/** "Search your library for <what>, put it/them onto the battlefield". */
const FETCH_SENTENCE = /Search your library for ([^.]*?),? (?:and )?put (?:it|them|that card)[^.]*?onto the battlefield/i;

/** The fetched land arrives tapped, which costs the same turn a tapland does. */
const ARRIVES_TAPPED = /onto the battlefield tapped/i;

/** Fabled Passage: tapped, then untapped once you control four lands. */
const THEN_UNTAPS = /onto the battlefield tapped[^.]*\.[^.]*untap/i;

/**
 * The fetch *itself* enters tapped (Grasslands, Krosan Verge). It costs you the
 * same turn a tapland does even when the land it finds arrives untapped:
 * cracking it needs {T}, and a land that entered tapped has no {T} to give
 * until your next untap step.
 *
 * The self-reference wording only. A shockland's "If you don't, it enters
 * tapped" hangs off an "unless" and means something else entirely, which is the
 * whole reason the profile above leans on tags rather than text.
 */
const SELF_ENTERS_TAPPED = /(?:^|\n)This land enters tapped\./i;

/**
 * What a fetchland searches out, or undefined when the card isn't one.
 *
 * Only lands are considered. Farseek and Cultivate put lands into play too, but
 * they are spells that cost mana on a turn you wanted to spend it, and the
 * profile above already files them as `landramp`.
 */
export function fetchProfileOf(card: ManaProfileInput): FetchProfileTuple | undefined {
  if (!/\bLand\b/.test(card.typeLine)) return undefined;
  const text = card.oracleText ?? '';
  const m = FETCH_SENTENCE.exec(text);
  if (!m) return undefined;
  const phrase = m[1] ?? '';

  // "a basic land card" names no type and means all of them; anything else has
  // to say which, and we only model the five that make colors.
  const named = Object.entries(BASIC_LAND_TYPES).filter(([, type]) => new RegExp(`\\b${type}\\b`, 'i').test(phrase));
  const anyBasic = named.length === 0 && /\bbasic land\b/i.test(phrase);
  const types = anyBasic ? Object.keys(BASIC_LAND_TYPES).join('') : named.map(([letter]) => letter).join('');
  if (!types) return undefined;

  const basicOnly = anyBasic || /\bbasic\b/i.test(phrase);
  let flags = basicOnly ? FETCH_BASIC_ONLY : 0;
  if (SELF_ENTERS_TAPPED.test(text) || ARRIVES_TAPPED.test(text)) {
    flags |= THEN_UNTAPS.test(text) ? MANA_MAYBE_TAPPED : MANA_TAPPED;
  }
  return [types, flags];
}
