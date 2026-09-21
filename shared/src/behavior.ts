import { BASIC_LAND_TYPES, MANA_LETTERS, sourceColors, type EffectProfile, type FetchProfile, type ManaProfile } from './card.js';

// Card behavior: what the *user* says a card does, when the pipeline's oracle
// reading says nothing useful.
//
// `OracleCard.effect` (effectProfile.ts) is derived from oracle text and Tagger
// tags, and its rule 2 is deliberately strict: only unconditional, only on
// resolution, only yours. That is the right default and it leaves most of the
// interesting cards in a deck resolving as blanks — the coverage line on the
// trajectory panel exists to say how many. This is the other direction: a
// grammar small enough to pick from two dropdowns, stored per deck, that
// replaces the derived reading for one card.
//
// Three rules shape it:
//
//  1. **Verb and number are separate choices.** "Draw X", then "X is the number
//     of cards in your hand". A step names what happens; an amount names how
//     much, and an amount can read the game state. That split is what keeps the
//     option lists short while the combinations stay useful.
//
//  2. **Nothing is offered that the simulator cannot execute.** A dropdown
//     listing "when attacking" against a sequencer with no combat step is a
//     worse lie than an omission, because the user authored it and then watched
//     it do nothing. The catalogs below are exactly the executable set;
//     everything else waits for the state to model it (§12 of the mana-model
//     notes).
//
//  3. **Authored behavior breaks the floor promise, so it gets counted.** The
//     panel's credibility rests on §11.4: every modelling error is an omission,
//     so the curves are a floor. A user writing "draw 7" on a Llanowar Elves is
//     an error in the other direction. It stays allowed and it stays visible —
//     SimCoverage.authored is the number, and the coverage line says it out loud.

/**
 * When a rule fires.
 *
 * `play` and `etb` are the same moment for most cards and two different moments
 * for the ones that matter. Casting is something you do from your hand; entering
 * the battlefield is something the card does, and it can do it without you
 * having cast anything at all. A Solemn Simulacrum reanimated out of the
 * graveyard still fetches a land; a Reanimate does not draw the cards the
 * creature's cast trigger would have.
 *
 * So: `play` is the cast, `etb` is the arrival, and a permanent cast from your
 * hand does both in that order.
 *
 * `attack` and `death` arrived with the permanent list. Both were unwritable
 * before it for the same reason: the sequencer tracked the permanents that make
 * mana and nothing else, so it had no idea a creature was on the battlefield,
 * let alone whether it was summoning sick or what killed it.
 *
 * `cast` and `enters` are the two *watched* triggers, and they are a different
 * shape from the other five: the rest fire on something happening to the card
 * holding the rule, these fire on something happening to a card that is not it.
 * A permanent sitting on the battlefield watches the game go by and does
 * something each time it sees what it is looking for — which is most of what a
 * deck's engine is, and none of which was writable before them. Which cards
 * count is a criteria string on the rule (`BehaviorRule.q`), so landfall is
 * `enters` with `t:land` and Archmage Emeritus is `cast` with
 * `t:instant or t:sorcery`.
 */
export type BehaviorTrigger = 'play' | 'etb' | 'attack' | 'death' | 'upkeep' | 'cast' | 'enters';

/** The triggers that watch other cards, and so carry a criteria of their own. */
export const WATCHED_TRIGGERS = ['cast', 'enters'] as const;
export type WatchedTrigger = (typeof WATCHED_TRIGGERS)[number];

/**
 * Where a card can be. The battlefield is the lopsided one: the sequencer
 * tracks the permanents that make mana and nothing else, so moving a card
 * *onto* it is always meaningful and moving one *off* it only ever finds a land
 * or a rock. The editor says so rather than pretending otherwise.
 *
 * The library is three entries rather than one, because *where* in it is the
 * whole difference between a Mystical Tutor and a shuffle. `library` on its own
 * is a random spot, which is what "shuffle it in" means once the deck is a bag
 * of cards; the other two go where they say. Both are destinations only —
 * nothing in Magic reaches into the bottom of your library, and "the top card"
 * as a *source* is already what an unfiltered move off `library` gives you.
 */
export type BehaviorZone = 'library' | 'librarytop' | 'librarybottom' | 'hand' | 'graveyard' | 'exile' | 'battlefield';

/**
 * What one step does.
 *
 * `flicker` is a `move` that would be illegal as one: off the battlefield and
 * straight back onto it, which `compileBehavior` refuses for every other step
 * because a move from a zone to itself is not a move. It is its own verb
 * because what it is *for* is the re-entry, not the travel.
 *
 * `mana` is the mana pool: mana you have *now*, this turn, that is gone at the
 * end of it. A Treasure is the same burst with a keep attached, which is why
 * this is the weaker of the two and why it is offered anyway — a Lotus Cobra's
 * landfall mana evaporates, and writing it as a Treasure would hand the deck a
 * permanent it never had. Its colors are a choice, because the three cards you
 * would write one for want three different answers: a Dark Ritual makes
 * {B}{B}{B}, a Lotus Cobra makes one mana of any color, and a Burnt Offering
 * makes black and red in whatever mix you like. Choosing nothing is any color,
 * which is what the step used to be and still is by default.
 *
 * `damage` is the one step with nothing on this side of the table to show for
 * it: a Lightning Bolt changes no zone you control. It exists because the
 * simulator now counts what a deck is doing *to* somebody, and a burn spell
 * that resolves as a blank makes an aggro deck read as a pile of lands. No
 * target, because a goldfish has exactly one.
 */
export type BehaviorStepKind =
  | 'draw'
  | 'mill'
  | 'discard'
  | 'scry'
  | 'surveil'
  | 'treasure'
  | 'mana'
  | 'damage'
  | 'move'
  | 'flicker'
  | 'self';

/**
 * Where a step's number comes from.
 *
 * `prev` is the odd one: it reads no game state at all, only what the step
 * before it actually did. Windfall is "discard your hand, then draw that many",
 * and every amount here is read as its own step runs, so the second `hand`
 * would be zero — correct arithmetic, wrong card. This is the number that step
 * reached, carried forward one place.
 */
export type BehaviorAmountKind =
  | 'fixed'
  | 'all'
  | 'prev'
  | 'hand'
  | 'library'
  | 'lands'
  | 'creatures'
  | 'power'
  | 'graveyard'
  | 'turn'
  | 'xpaid';

/**
 * Arithmetic on an amount, so "half your library" and "that many minus one" are
 * writable without a new amount kind for each of them.
 *
 * One operator and one number, applied once, and no nesting. That covers Dark
 * Deal (X - 1), Peer Into the Abyss (X / 2) and the double-up effects; an
 * expression language would cover a handful more and cost a parser, precedence
 * rules and errors pointing into the middle of a formula.
 *
 * Division is two operators rather than one with a rounding flag. Magic prints
 * both — "half, rounded down" on Peer Into the Abyss, "half, rounded up" on
 * Fire Covenant — and a separate flag would be a control that only appears for
 * one of five operators, which is a worse dropdown than five entries.
 */
export type BehaviorAmountOp = '+' | '-' | '*' | '/' | '/^';

export interface BehaviorAmount {
  kind: BehaviorAmountKind;
  /** The number, for `fixed` only. Ignored (and unset) on every other kind. */
  n?: number;
  /**
   * An adjustment applied after the kind is read. Never set on `fixed` (that is
   * just a different number) or on `all` (a ceiling, not a count).
   */
  op?: BehaviorAmountOp;
  /** The right-hand side of `op`, at least 1. Absent exactly when `op` is. */
  by?: number;
}

export interface BehaviorStep {
  op: BehaviorStepKind;
  /** Ignored by `self`, which moves one card and that card is not up to you. */
  x: BehaviorAmount;
  /** `move` only: where the cards come from. */
  from?: BehaviorZone;
  /** `move` and `self`: where they end up. */
  to?: BehaviorZone;
  /**
   * `move` only: a Scryfall query saying which cards qualify. Absent or empty
   * means any card.
   *
   * Reusing the search syntax rather than inventing a picker is the whole trick
   * here: `t:basic`, `t:creature mv<=3`, `o:"draw a card"` are all already
   * written, already documented on the search screen, and already understood by
   * anyone who has used the app for ten minutes. Matching happens once per deck
   * build, against the cards in the deck, so the sequencer's inner loop only
   * ever reads a precomputed bitmask.
   *
   * May contain `[X]` (see `queryHasX`), which is the one thing here that is
   * not Scryfall syntax. Square brackets mean nothing to the real parser, so
   * the borrowed language stays borrowed.
   */
  q?: string;
  /**
   * `move` only, and only when `q` holds an `[X]`: what that placeholder is
   * worth. A second amount rather than a second vocabulary — the query says
   * *where* the number goes and this says *what it is*, which is §12.1's split
   * applied one level down.
   */
  qx?: BehaviorAmount;
  /**
   * `move` and `self`, and only onto the battlefield: it arrives **untapped**,
   * so a mana source pays for something the turn it lands.
   *
   * Absent is tapped, which is what every such move has always done and the
   * conservative half of the two cards that print this. The flag is the way
   * round it is because a Sakura-Tribe Scout putting a land into play untapped
   * is the rarer card and the one that needs saying; writing the default down
   * would put a `tapped: true` on every row that already means it.
   */
  untapped?: true;
  /**
   * `mana` only: which colors it makes, as WUBRGC letters. Absent is any color,
   * which is what the step meant before there was anything to say.
   *
   * A string rather than an array because it is stored per deck per card and
   * "BR" is four bytes where `["B","R"]` is eleven. Normalized by
   * `sanitizeCardBehavior` into MANA_LETTERS order, so the same three checkboxes
   * always save the same bytes.
   */
  colors?: string;
  /**
   * `mana` only: all of it has to be the **same** color, chosen once from
   * `colors`. Lotus Field's three mana of any one color, and the same flag
   * MANA_ONE_COLOR is on the mana profile for the same reason — expanded as
   * independent units it would pay {W}{U}{B}, a cost the card cannot pay.
   *
   * Only meaningful with more than one color on offer and more than one mana.
   */
  oneColor?: true;
}

// ---------------------------------------------------------------------------
// The [X] placeholder
// ---------------------------------------------------------------------------

/**
 * `[X]`, `[X+1]`, `[X - 2]`. An offset and nothing more.
 *
 * Deliberately not an expression language. The cards that exist say X, X-1 and
 * X+1; multiplication and nesting would buy none of them and cost an evaluator,
 * precedence rules and error messages pointing into the middle of a string.
 * Square brackets because Scryfall has no use for them, so a query carrying one
 * is unambiguously ours.
 */
const X_TOKEN = /\[\s*[Xx]\s*(?:([+-])\s*(\d+))?\s*\]/;
const X_TOKEN_ALL = new RegExp(X_TOKEN.source, 'g');

export function queryHasX(q: string | null | undefined): boolean {
  return !!q && X_TOKEN.test(q);
}

/**
 * The query with every placeholder replaced by a number, ready for the ordinary
 * card-query parser. Clamped at zero: `[X-2]` with X of 1 must not hand the
 * parser `mv<=-1`.
 */
export function substituteQueryX(q: string, x: number): string {
  return q.replace(X_TOKEN_ALL, (_m, sign: string | undefined, digits: string | undefined) => {
    const offset = digits ? Number(digits) * (sign === '-' ? -1 : 1) : 0;
    return String(Math.max(0, x + offset));
  });
}


export interface BehaviorRule {
  on: BehaviorTrigger;
  /** Resolved in order, which is the whole point: a loot draws before it discards. */
  steps: BehaviorStep[];
  /**
   * `cast` and `enters` only: which cards wake this rule, as a Scryfall query.
   * Absent or empty is any of them.
   *
   * The same syntax a `move` step narrows with, pointed at the event instead of
   * at a zone — one language for "which cards" wherever the question comes up.
   * No `[X]` here, though: a watched rule is woken by something happening, not
   * resolved with a number, so there is nothing for a placeholder to read.
   */
  q?: string;
}

/**
 * One card's authored behavior. Versioned because the grammar will grow: a
 * reader that meets a `v` it does not know keeps the row intact on disk and
 * ignores it in the simulator, which is the same thing it does with a step kind
 * it has never heard of.
 */
export interface CardBehavior {
  v: 1;
  rules: BehaviorRule[];
}

export const CARD_BEHAVIOR_VERSION = 1;

/**
 * Rules on one card. One per trigger and nothing real wants all of them, but
 * the watched triggers break that arithmetic: two `cast` rules watching two
 * different criteria are two rules on the same moment, which is a Storm-Kiln
 * Artist that also cares about creatures.
 */
export const MAX_BEHAVIOR_RULES = 7;
/** Steps in one rule. */
export const MAX_BEHAVIOR_STEPS = 6;
/**
 * The ceiling on a number somebody **types**: a `fixed` amount, or the `by` of
 * an adjustment. Ninety-nine because that is a Commander deck, and a rule
 * saying "draw 99" is a rule about a real game rather than a typo.
 *
 * It used to cap *computed* amounts too, and that was a lie with a number on
 * it: "draw half your library" in a 99-card deck came out as twenty, so the
 * curve for a Peer Into the Abyss deck was the curve for a deck that does not
 * contain one. The sequencer's zones all guard their own bounds — drawCards
 * stops at the end of the library and the size of your hand, moveCards stops
 * when nothing matches — so the cap was never what made them safe.
 */
export const MAX_BEHAVIOR_AMOUNT = 99;
/**
 * Characters in a move step's criteria. Long enough for anything worth writing
 * (`t:creature mv<=3 -t:legendary` is 29) and short enough that a behavior row
 * stays comfortably inside SYNC_MAX_ROW_BYTES.
 */
export const MAX_BEHAVIOR_QUERY = 120;
/**
 * The ceiling on `[X]` inside a move step's criteria, which is a different
 * number from MAX_BEHAVIOR_AMOUNT and has to stay one.
 *
 * A query with an `[X]` is compiled once per value of X into a stack of
 * bitmasks, so this bound is paid in memory and in parses-per-keystroke rather
 * than in accuracy. Twenty covers `mv<=[X]` on every card ever printed; letting
 * it follow the typed ceiling to 99 would make the stack five times taller to
 * hold rows nothing can match.
 */
export const MAX_QUERY_X = 20;

/**
 * How many values of `[X]` a filter is compiled for: the closed range
 * 0..MAX_QUERY_X. That is what keeps a runtime value out of the simulator's
 * inner loop — picking the row *is* resolving the query.
 */
export const X_VARIANTS = MAX_QUERY_X + 1;

/** One deck's answer for one card. Keyed `<deckId>:<oracleId>`, synced like any row. */
export interface DeckBehavior {
  id: string;
  deckId: string;
  oracleId: string;
  behavior: CardBehavior;
  updatedAt: number;
}

export const deckBehaviorId = (deckId: string, oracleId: string): string => `${deckId}:${oracleId}`;

// ---------------------------------------------------------------------------
// The catalogs: one source of truth for the editor, the renderer and the sim
// ---------------------------------------------------------------------------

export interface TriggerOption {
  id: BehaviorTrigger;
  label: string;
  /** How the rule reads when it is written out. */
  lead: string;
  hint: string;
  /**
   * What the card has to be for this moment to exist. A sorcery never enters
   * the battlefield and never attacks, so a rule hung on either would be
   * §12.2's lie: authored, saved, and silently doing nothing every game.
   */
  needs?: 'permanent' | 'creature';
  /**
   * It fires on something happening to a *different* card, so the rule carries
   * a criteria saying which cards count. The editor shows a box for it, the
   * compiler keeps it per rule rather than merging the steps, and the sequencer
   * matches it against the card that caused the event.
   */
  watches?: boolean;
}

export const BEHAVIOR_TRIGGERS: readonly TriggerOption[] = [
  {
    id: 'play',
    label: 'When you play it',
    lead: 'When you play it',
    hint: 'Resolves once, the turn you cast it from your hand or put it down as a land. Not when it arrives any other way.',
  },
  {
    id: 'etb',
    label: 'When it enters the battlefield',
    lead: 'When it enters the battlefield',
    hint: 'However it got there: cast, played as a land, fetched, flickered, or brought back out of the graveyard. A permanent you cast does this after its played rule.',
    needs: 'permanent',
  },
  {
    id: 'attack',
    label: 'When it attacks',
    lead: 'Whenever it attacks',
    hint: 'Every turn it can. Nobody blocks, nothing dies in combat and no damage is counted, so this trigger is the only thing an attack is worth here. A creature cannot attack the turn it arrives.',
    needs: 'creature',
  },
  {
    id: 'death',
    label: 'When it dies',
    lead: 'When it dies',
    hint: 'Leaving the battlefield for the graveyard, which in this model means a rule sacrificed it. Nothing on the other side of the table is killing anything.',
    needs: 'permanent',
  },
  {
    id: 'upkeep',
    label: 'At each of your upkeeps',
    lead: 'At each of your upkeeps',
    hint: 'Fires every turn from the one after it lands. For permanents that stay on the battlefield.',
  },
  {
    id: 'cast',
    label: 'When you cast another spell',
    lead: 'Whenever you cast another spell',
    hint: 'Every time, while this permanent is on the battlefield, and before the spell it saw resolves. Narrow it below: t:instant or t:sorcery is Archmage Emeritus, t:creature is Beast Whisperer. Lands are played rather than cast, so they never wake this.',
    needs: 'permanent',
    watches: true,
  },
  {
    id: 'enters',
    label: 'When another permanent enters',
    lead: 'Whenever another permanent you control enters',
    hint: 'However it got there: played, cast, fetched, flickered or reanimated. Narrow it below: t:land is landfall, t:creature is Guardian Project. This card never wakes itself, and neither does a second copy of it.',
    needs: 'permanent',
    watches: true,
  },
];

export interface StepOption {
  id: BehaviorStepKind;
  label: string;
  /** Third person, for writing the rule out: "draws 2". */
  verb: string;
}

export const BEHAVIOR_STEPS: readonly StepOption[] = [
  { id: 'draw', label: 'Draw X', verb: 'draw' },
  { id: 'mill', label: 'Mill X', verb: 'mill' },
  { id: 'discard', label: 'Discard X', verb: 'discard' },
  { id: 'scry', label: 'Scry X', verb: 'scry' },
  { id: 'surveil', label: 'Surveil X', verb: 'surveil' },
  { id: 'treasure', label: 'Create X Treasures', verb: 'create' },
  { id: 'mana', label: 'Add X mana', verb: 'add' },
  { id: 'damage', label: 'Deal X damage', verb: 'deal' },
  { id: 'move', label: 'Move X between zones', verb: 'move' },
  { id: 'flicker', label: 'Flicker X permanents', verb: 'flicker' },
  { id: 'self', label: 'Put this card into a zone', verb: 'put' },
];

export interface ManaColorOption {
  /** A letter of MANA_LETTERS. */
  id: string;
  /** For the picker, which is six round buttons wide on a phone. */
  symbol: string;
  label: string;
}

/**
 * The colors a `mana` step can be told to make, WUBRG plus colorless.
 *
 * Colorless is on the list because it is a real answer and a different one: a
 * Cabal Ritual's cousin that adds {C}{C} pays generic costs and no pip, which
 * the simulator already models (a land with no nameable color does exactly
 * this) and which "any color" would quietly overstate.
 */
export const BEHAVIOR_MANA_COLORS: readonly ManaColorOption[] = [
  { id: 'W', symbol: '{W}', label: 'White' },
  { id: 'U', symbol: '{U}', label: 'Blue' },
  { id: 'B', symbol: '{B}', label: 'Black' },
  { id: 'R', symbol: '{R}', label: 'Red' },
  { id: 'G', symbol: '{G}', label: 'Green' },
  { id: 'C', symbol: '{C}', label: 'Colorless' },
];

/** The five colors, which is what "any color" means and what an empty `colors` is. */
export const ANY_COLOR = 'WUBRG';

/**
 * A `colors` string as it is stored: MANA_LETTERS order, no duplicates, nothing
 * that is not a mana letter, and empty for "any color".
 *
 * All five colors normalizes *away* rather than being kept, so the picker with
 * everything ticked and the picker with nothing ticked save the same bytes —
 * they mean the same thing, and two spellings of one rule is the sort of thing
 * that makes a sync diff for no reason.
 */
export function normalizeManaColors(raw: string | null | undefined): string {
  if (!raw) return '';
  let out = '';
  for (const letter of MANA_LETTERS) if (raw.toUpperCase().includes(letter)) out += letter;
  return out === ANY_COLOR ? '' : out;
}

/** What a `mana` step actually makes, with the empty string resolved. */
export const manaStepColors = (step: BehaviorStep): string => normalizeManaColors(step.colors) || ANY_COLOR;

export interface ZoneOption {
  id: BehaviorZone;
  /** For the picker. */
  label: string;
  /** For the picker, where being the destination changes what it means. */
  toLabel?: string;
  /** For writing the rule out as a source: "from your library". */
  phrase: string;
  /** For writing it out as a destination, where that reads differently. */
  into?: string;
  /** Nothing is ever taken from here, so it is offered as a destination only. */
  toOnly?: boolean;
}

export const BEHAVIOR_ZONES: readonly ZoneOption[] = [
  {
    id: 'library',
    label: 'Library',
    toLabel: 'Library (random spot)',
    phrase: 'your library',
    into: 'a random spot in your library',
  },
  { id: 'librarytop', label: 'Top of library', phrase: 'your library', into: 'the top of your library', toOnly: true },
  { id: 'librarybottom', label: 'Bottom of library', phrase: 'your library', into: 'the bottom of your library', toOnly: true },
  { id: 'hand', label: 'Hand', phrase: 'your hand' },
  { id: 'graveyard', label: 'Graveyard', phrase: 'your graveyard' },
  { id: 'battlefield', label: 'Battlefield', phrase: 'the battlefield' },
  { id: 'exile', label: 'Exile', phrase: 'exile' },
];

/** The zones a `move` can take cards out of. */
export const BEHAVIOR_FROM_ZONES: readonly ZoneOption[] = BEHAVIOR_ZONES.filter((z) => !z.toOnly);

export interface AmountOption {
  id: BehaviorAmountKind;
  /** For the picker: what X equals. */
  label: string;
  /** For writing the rule out, where it follows the verb. */
  phrase: string;
  /** Only means anything on a `move`, where the source zone bounds it. */
  moveOnly?: boolean;
  /**
   * Only means anything on a `play` rule, and only on a card whose printed cost
   * has an `{X}` in it. An upkeep three turns later is not the moment the mana
   * went in, and §12.2 says an option that cannot fire does not get offered.
   */
  needsX?: boolean;
  /** There has to be a step before this one for it to read anything. */
  needsPrev?: boolean;
  /** Arithmetic on it would say nothing: see BehaviorAmount.op. */
  noAdjust?: boolean;
}

/**
 * `label` is deliberately terser than `phrase`. The picker sits on one row
 * beside an operator and a number on a 393px phone, so "X = your graveyard"
 * fits where "X = cards in your graveyard" would truncate; the sentence the
 * rule is written out as has the whole width and says it in full.
 */
export const BEHAVIOR_AMOUNTS: readonly AmountOption[] = [
  { id: 'fixed', label: 'a number', phrase: '', noAdjust: true },
  { id: 'all', label: 'all that match', phrase: 'all that match', moveOnly: true, noAdjust: true },
  { id: 'prev', label: 'the previous X', phrase: 'the previous X', needsPrev: true },
  { id: 'xpaid', label: 'the X you paid', phrase: 'the mana you spent on X', needsX: true },
  { id: 'hand', label: 'your hand', phrase: 'cards in your hand' },
  { id: 'library', label: 'your library', phrase: 'cards in your library' },
  { id: 'lands', label: 'your lands', phrase: 'lands you control' },
  { id: 'creatures', label: 'your creatures', phrase: 'creatures you control' },
  { id: 'power', label: 'the greatest power', phrase: 'the greatest power among creatures you control' },
  { id: 'graveyard', label: 'your graveyard', phrase: 'cards in your graveyard' },
  { id: 'turn', label: 'the turn number', phrase: 'the turn number' },
];

export interface AmountOpOption {
  id: BehaviorAmountOp;
  /** The picker shows this alone, so it has to be one glyph wide and obvious. */
  symbol: string;
  /** For writing the rule out. */
  sign: string;
  /** What follows the number in prose, where the symbol on its own is ambiguous. */
  tail?: string;
}

export const BEHAVIOR_AMOUNT_OPS: readonly AmountOpOption[] = [
  { id: '+', symbol: '+', sign: '+' },
  { id: '-', symbol: '-', sign: '-' },
  { id: '*', symbol: '×', sign: '×' },
  { id: '/', symbol: '÷', sign: '÷', tail: ', rounded down' },
  { id: '/^', symbol: '÷↑', sign: '÷', tail: ', rounded up' },
];

const TRIGGER_BY_ID = new Map(BEHAVIOR_TRIGGERS.map((t) => [t.id as string, t]));
const STEP_BY_ID = new Map(BEHAVIOR_STEPS.map((s) => [s.id as string, s]));
const AMOUNT_BY_ID = new Map(BEHAVIOR_AMOUNTS.map((a) => [a.id as string, a]));
const OP_BY_ID = new Map(BEHAVIOR_AMOUNT_OPS.map((o) => [o.id as string, o]));
const ZONE_BY_ID = new Map(BEHAVIOR_ZONES.map((z) => [z.id as string, z]));

// ---------------------------------------------------------------------------
// Reading one out loud
// ---------------------------------------------------------------------------

/**
 * An amount's adjustment applied to the number its kind read.
 *
 * The two division operators are the whole reason this is a switch rather than
 * a lookup: `/` floors and `/^` ceils, and which one a card wants is printed on
 * it. An op this build does not recognize cannot reach here — compileBehavior
 * drops the step and sanitizeCardBehavior drops the adjustment — so the
 * fallthrough is the unmodified number rather than a guess.
 */
export function applyAmountOp(value: number, x: BehaviorAmount): number {
  if (!x.op || !x.by) return value;
  switch (x.op) {
    case '+':
      return value + x.by;
    case '-':
      return value - x.by;
    case '*':
      return value * x.by;
    case '/':
      return Math.floor(value / x.by);
    case '/^':
      return Math.ceil(value / x.by);
    default:
      return value;
  }
}

export function describeAmount(x: BehaviorAmount): string {
  const base = x.kind === 'fixed' ? String(x.n ?? 0) : (AMOUNT_BY_ID.get(x.kind)?.phrase ?? '?');
  if (!x.op || !x.by) return base;
  const op = OP_BY_ID.get(x.op);
  return `${base} ${op?.sign ?? x.op} ${x.by}${op?.tail ?? ''}`;
}

/**
 * One step as a phrase: "draw 2", or "draw X (X = cards in your hand)".
 *
 * A computed amount keeps the X rather than reading as one — "draw cards in
 * your hand" is a sentence about what you draw, not how many — and naming it
 * the same way the editor's own dropdown does means the sentence and the
 * control you set it with say the identical thing.
 */
/** A destination zone as it reads after "to": "the top of your library". */
function intoPhrase(zone: BehaviorZone | undefined): string {
  const z = ZONE_BY_ID.get(zone ?? '');
  return z?.into ?? z?.phrase ?? 'somewhere';
}

/** Cards go *into* every zone but the battlefield, which they go *onto*. */
const intoPrep = (zone: BehaviorZone | undefined): string => (zone === 'battlefield' ? 'onto' : 'into');

/**
 * How it lands, for the one destination where that is a question. Said out loud
 * on both settings rather than only on the unusual one: the default used to be
 * silent and always tapped, which read as an oversight in the sentence and
 * surprised anyone who expected a reanimated Sol Ring to pay for something.
 */
const tappedPhrase = (step: BehaviorStep): string =>
  step.to === 'battlefield' ? (step.untapped ? ', untapped' : ', tapped') : '';

export function describeStep(step: BehaviorStep): string {
  const verb = STEP_BY_ID.get(step.op)?.verb ?? step.op;
  const computed = step.x.kind !== 'fixed';
  const count = computed ? 'X' : String(step.x.n ?? 0);
  const tail = computed ? ` (X = ${describeAmount(step.x)})` : '';
  // The one step that is about the card holding the rule rather than about the
  // cards it can reach, so it has no count and no criteria to read out.
  if (step.op === 'self') return `put this card ${intoPrep(step.to)} ${intoPhrase(step.to)}${tappedPhrase(step)}`;
  if (step.op === 'move') {
    const from = ZONE_BY_ID.get(step.from ?? '')?.phrase ?? 'somewhere';
    const to = intoPhrase(step.to) + tappedPhrase(step);
    const filter = step.q ? ` matching ${step.q}` : '';
    const where = ` from ${from} to ${to}`;
    // What the query's own placeholder is worth, named separately from the
    // count because they are two different numbers on the same step.
    const plug = step.q && queryHasX(step.q) ? `, with [X] = ${describeAmount(step.qx ?? { kind: 'fixed', n: 0 })}` : '';
    // "all that match" already says how many, so it does not want an "X = "
    // trailer explaining a number nobody asked for.
    if (step.x.kind === 'all') return `move everything${filter}${where}${plug}`;
    const n = step.x.n ?? 0;
    const cards = computed ? 'X cards' : `${n} card${n === 1 ? '' : 's'}`;
    return `move ${cards}${filter}${where}${tail}${plug}`;
  }
  if (step.op === 'flicker') {
    const filter = step.q ? ` matching ${step.q}` : '';
    const plug = step.q && queryHasX(step.q) ? `, with [X] = ${describeAmount(step.qx ?? { kind: 'fixed', n: 0 })}` : '';
    if (step.x.kind === 'all') return `flicker every permanent you control${filter}${plug}`;
    const n = step.x.n ?? 0;
    const what = computed ? 'X permanents' : `${n} permanent${n === 1 ? '' : 's'}`;
    return `flicker ${what} you control${filter}${tail}${plug}`;
  }
  if (step.op === 'treasure') {
    const many = computed || (step.x.n ?? 0) !== 1;
    return `${verb} ${count} Treasure${many ? 's' : ''}${tail}`;
  }
  if (step.op === 'damage') {
    // No target: a goldfish has one opponent and nothing to aim at. The step
    // says how much damage leaves your side of the table, which is the only
    // half of it the simulator can count.
    return `${verb} ${count} damage${tail}`;
  }
  if (step.op === 'mana') {
    // Phrased the way describeRitual phrases the pipeline's own reading, so a
    // Dark Ritual you wrote out by hand and a Dark Ritual we read off the card
    // say the same sentence.
    const colors = manaStepColors(step);
    const symbols = [...colors].map((c) => `{${c}}`).join('');
    const any = colors === ANY_COLOR;
    if (colors.length === 1) return `${verb} ${count} ${symbols} to your mana pool${tail}`;
    const what = any ? 'any color' : symbols;
    if (step.oneColor) return `${verb} ${count} mana of any one of ${any ? symbols : what} to your mana pool${tail}`;
    return `${verb} ${count} mana of ${what} to your mana pool${tail}`;
  }
  return `${verb} ${count}${tail}`;
}

/**
 * What wakes a rule, as a phrase: "When you play it", or "Whenever you cast
 * another spell matching t:instant".
 *
 * A watched trigger's criteria belongs here rather than beside the steps,
 * because it says *when*, not *what* — the same string on a `move` step would
 * be saying which cards to take.
 */
export function describeTrigger(rule: BehaviorRule): string {
  const t = TRIGGER_BY_ID.get(rule.on);
  const lead = t?.lead ?? rule.on;
  return t?.watches && rule.q ? `${lead} matching ${rule.q}` : lead;
}

/** One rule as a sentence: "When you play it: draw 2, then discard 1". */
export function describeRule(rule: BehaviorRule): string {
  const lead = describeTrigger(rule);
  if (rule.steps.length === 0) return `${lead}: nothing`;
  const bits = rule.steps.map(describeStep);
  const last = bits.pop()!;
  return bits.length > 0 ? `${lead}: ${bits.join(', ')}, then ${last}` : `${lead}: ${last}`;
}

/** Every rule, one sentence each. Empty for a behavior that does nothing. */
export function describeBehavior(b: CardBehavior | null | undefined): string[] {
  if (!b) return [];
  return b.rules.filter((r) => r.steps.length > 0).map(describeRule);
}

// ---------------------------------------------------------------------------
// The derived profile, in the same grammar
// ---------------------------------------------------------------------------

/**
 * `OracleCard.effect` rendered as rules, so the editor opens on the pipeline's
 * answer rather than on a blank page, and "edit what we read" and "write your
 * own" are the same gesture.
 *
 * Two things do not survive the trip, both display-only rather than executed:
 * `tutor` (the sequencer resolves a tutor as a draw off the top anyway, so the
 * rules are identical and only the label is lost) and `unknown` (a confidence
 * flag on an amount, not an amount).
 *
 * Step order is resolveEffect()'s order, which is the order a card is written
 * in: draw, discard, mill, dig, Treasure.
 */
export function behaviorFromEffect(effect: EffectProfile | null | undefined): CardBehavior | null {
  if (!effect) return null;
  const steps: BehaviorStep[] = [];
  const fixed = (op: BehaviorStepKind, n: number) => {
    if (n > 0) steps.push({ op, x: { kind: 'fixed', n: Math.min(n, MAX_BEHAVIOR_AMOUNT) } });
  };
  fixed('draw', effect.draw);
  // "Your whole hand" is exactly the `hand` amount, which is the grammar
  // agreeing with the pipeline rather than a coincidence worth trimming.
  if (effect.wholeHand) steps.push({ op: 'discard', x: { kind: 'hand' } });
  else fixed('discard', effect.discard);
  fixed('mill', effect.mill);
  if (effect.scry >= effect.surveil) fixed('scry', effect.scry);
  else fixed('surveil', effect.surveil);
  fixed('treasure', effect.treasure);
  if (steps.length === 0) return null;
  return { v: CARD_BEHAVIOR_VERSION, rules: [{ on: effect.repeatable ? 'upkeep' : 'play', steps }] };
}

/**
 * The land ramp the *mana* profile reads, as a phrase in this grammar's voice,
 * or null for every card that is not land ramp.
 *
 * A card's derived reading comes from two pipeline fields with two different
 * jobs: `effect` is what it does to your hand and library, `mana` is what it
 * does to your mana. Only the first had a rendering here, so a Rampant Growth
 * showed up in the editor as "do nothing" while the simulator was quietly
 * ramping off it — which is how someone ends up writing the ramp out by hand
 * and getting it twice.
 *
 * Deliberately a *phrase* and not a `CardBehavior`. The sequencer's derived
 * ramp searches for the land that best fixes your colours; a `move` step takes
 * a random matching one. Rendering this as editable rules would break
 * `behaviorFromEffect`'s promise that opening the editor and pressing Save
 * changes nothing, so it says what the database read and leaves the writing to
 * the user.
 */
export function describeLandRamp(mana: ManaProfile | null | undefined): string | null {
  if (!mana || mana.kind !== 'landramp') return null;
  const n = Math.max(1, mana.adds);
  // Always tapped, whatever the flag says: that is what the sequencer does with
  // one, and this has to describe the model rather than the card.
  return `put ${n} land${n === 1 ? '' : 's'} from your library onto the battlefield, tapped`;
}

/**
 * What the card *is*, for the three kinds that sit on the battlefield and tap:
 * a land, a rock, a mana creature. Null for everything else.
 *
 * The odd one out among the readings here, because it is the only one a rule
 * written in the editor does not replace. A Llanowar Elves taps for green
 * whatever anybody writes on it — that is its type line and its printed
 * ability, not a reading of its text that might be wrong.
 *
 * It gets a line anyway, and that is the whole point: every effect the
 * simulator gives a card should be readable in one place, including the ones
 * you cannot argue with. A Lotus Cobra used to sit in that list saying "do
 * nothing" while the sequencer tapped it for a mana of any colour every turn
 * from the one after it landed, which is a model somebody is entitled to see.
 */
export function describeManaSource(mana: ManaProfile | null | undefined, produces: string | undefined): string | null {
  if (!mana) return null;
  if (mana.kind !== 'land' && mana.kind !== 'rock' && mana.kind !== 'dork') return null;
  const colors = sourceColors(mana, produces);
  const symbols = [...colors].map((c) => `{${c}}`).join('');
  const n = Math.max(0, mana.adds);
  // A utility land that taps for nothing still costs a land drop, which is the
  // only thing the sequencer knows about it.
  if (n === 0 || colors.length === 0) {
    const what = n === 0 ? 'Taps for nothing' : `Taps for ${n} mana that pays only generic costs`;
    return mana.kind === 'land' && mana.tapped === 'always' ? `Arrives tapped. ${what}` : what;
  }
  const what =
    colors.length === 1
      ? `Taps for ${symbols.repeat(n)}`
      : mana.oneColor && n > 1
        ? `Taps for ${n} mana of any one of ${symbols}`
        : `Taps for ${n} mana of ${colors.length >= 5 ? 'any color' : symbols}`;
  // Only 'always'. A conditional tapland is untapped as far as the sequencer is
  // concerned, the same call describeFetch makes.
  const lead = mana.tapped === 'always' ? 'Arrives tapped. ' : '';
  // Summoning sickness, which is the whole difference between a dork and a rock
  // and the reason they are two kinds rather than one with a type line.
  const tail = mana.kind === 'dork' ? ', from the turn after it arrives' : '';
  return `${lead}${what}${tail}`;
}

/**
 * The extra land drops the mana profile reads, as a phrase, or null for
 * everything that is not an Exploration.
 *
 * The fifth derived reading and the last one with no voice, which is how an
 * Arboreal Grazer came to sit in the editor saying "do nothing" while the
 * sequencer handed it a land drop every turn for the rest of the game. The
 * misreading is fixed upstream — the pipeline now wants the card to actually
 * say "on each of your turns" — but the *silence* was the worse half: a wrong
 * effect you can see is a bug report, and a wrong effect you cannot see is a
 * deck report nobody can explain.
 *
 * Same shape and same reason as the three below it: a phrase, not rules,
 * because the grammar has no step that grants a land drop and inventing one
 * that only ever appears on thirty cards would be a worse dropdown than a
 * sentence.
 */
export function describeExtraLand(mana: ManaProfile | null | undefined): string | null {
  if (!mana || mana.kind !== 'extraland') return null;
  const n = Math.max(1, mana.adds);
  // From the turn after it lands, which is what the sequencer does with one:
  // this turn's land drop has already happened by the time it resolves.
  return `play ${n} additional land${n === 1 ? '' : 's'} on each of your turns, from next turn`;
}

/**
 * The *ritual* the mana profile reads, as a phrase, or null for every card that
 * is not one. The fourth derived reading, and the fourth one that showed up in
 * the editor as "do nothing" while the sequencer was casting it.
 *
 * Same shape and same reason as describeLandRamp: a phrase rather than rules,
 * because the grammar's own `mana` step adds mana of any color and a Dark
 * Ritual adds {B}{B}{B}. Rendering it as editable steps would quietly widen the
 * card's colors the moment somebody opened the editor and pressed Save.
 */
export function describeRitual(mana: ManaProfile | null | undefined, produces: string | undefined): string | null {
  if (!mana || mana.kind !== 'ritual') return null;
  const n = Math.max(1, mana.adds);
  const colors = sourceColors(mana, produces);
  const symbols = [...colors].map((c) => `{${c}}`).join('');
  // No nameable color at all is MANA_OPPONENT, and a goldfish has no opponents.
  // The mana is still mana; it just cannot pay a pip.
  if (colors.length === 0) return `add ${n} mana that pays only generic costs`;
  if (colors.length === 1) return `add ${symbols.repeat(n)} to your mana pool`;
  if (mana.oneColor) return `add ${n} mana of any one of ${symbols} to your mana pool`;
  const what = colors.length >= 5 ? 'any color' : symbols;
  return `add ${n} mana of ${what} to your mana pool`;
}

/**
 * What the *fetch* profile reads, as a phrase, or null for anything that is not
 * a fetchland. The third derived reading, and the third one that had no voice
 * in the editor: a Flooded Strand showed up as "do nothing" while the sequencer
 * was cracking it every game.
 *
 * Same shape and same reason as describeLandRamp: a phrase rather than rules,
 * because the sequencer picks the land that best fixes your colours and a
 * `move` step takes a random matching one. Rendering it as editable steps would
 * break behaviorFromEffect's promise that opening the editor and pressing Save
 * changes nothing.
 */
export function describeFetch(fetch: FetchProfile | null | undefined): string | null {
  if (!fetch) return null;
  const types = [...fetch.types].map((letter) => BASIC_LAND_TYPES[letter]).filter((t): t is string => !!t);
  if (types.length === 0) return null;
  // All five is "a land", which is what the card says and four words shorter
  // than listing them. Anything less names the types, because on a Windswept
  // Heath that is the whole card.
  const what = types.length === 5 ? 'land' : types.join(' or ');
  // Only 'always'. A conditional tapland is untapped as far as the sequencer is
  // concerned, and this describes the model rather than the card — same call
  // describeLandRamp makes in the other direction.
  const how = fetch.tapped === 'always' ? ', tapped' : '';
  return `sacrifice it and put ${fetch.basicOnly ? 'a basic' : 'a'} ${what} from your library onto the battlefield${how}`;
}

// ---------------------------------------------------------------------------
// Compiling, for the simulator
// ---------------------------------------------------------------------------

/**
 * A behavior split by trigger, so the sequencer's inner loop does no filtering
 * and meets no string it has to recognize twice.
 *
 * Steps the running build does not understand are dropped here rather than
 * anywhere later: a row written by a newer client keeps every byte on disk and
 * in sync, and simply plays out as less than it says. The alternative — refuse
 * the whole behavior — would make one unknown step delete a card's whole
 * reading on the older device.
 */
export interface WatchRule {
  /** Which cards wake it. Absent is any of them. */
  q?: string;
  steps: BehaviorStep[];
}

export interface CompiledBehavior {
  play: BehaviorStep[];
  etb: BehaviorStep[];
  attack: BehaviorStep[];
  death: BehaviorStep[];
  upkeep: BehaviorStep[];
  /**
   * The watched triggers, and the one pair that stays a *list of rules* rather
   * than flattening into a list of steps. Every other trigger is one moment, so
   * two rules on it are one longer rule; these two are "whenever you see X",
   * and two of them on one card are two different X's.
   */
  cast: WatchRule[];
  enters: WatchRule[];
}

/**
 * An amount this build can execute end to end. An unknown *op* is dropped with
 * the whole step rather than ignored, because ignoring one runs the number
 * unmodified: a "÷ 2" this build has never heard of would double what the
 * author asked for, which is the one direction §11.4 does not allow.
 */
const knownAmount = (x: BehaviorAmount | undefined | null): boolean =>
  !!x && AMOUNT_BY_ID.has(x.kind) && (!x.op || OP_BY_ID.has(x.op));

export function compileBehavior(b: CardBehavior | null | undefined): CompiledBehavior | null {
  if (!b || b.v !== CARD_BEHAVIOR_VERSION || !Array.isArray(b.rules)) return null;
  const out: CompiledBehavior = { play: [], etb: [], attack: [], death: [], upkeep: [], cast: [], enters: [] };
  for (const rule of b.rules) {
    const trigger = rule ? TRIGGER_BY_ID.get(rule.on) : undefined;
    if (!trigger || !Array.isArray(rule.steps)) continue;
    // A watched trigger's steps are collected on their own and filed with the
    // criteria that wakes them; every other trigger appends to its one bucket,
    // which is what it has always done.
    const bucket: BehaviorStep[] = trigger.watches ? [] : out[rule.on as Exclude<BehaviorTrigger, WatchedTrigger>];
    for (const step of rule.steps) {
      if (!step || !STEP_BY_ID.has(step.op) || !knownAmount(step.x)) continue;
      if (step.op === 'self') {
        if (!step.to || !ZONE_BY_ID.has(step.to)) continue;
      } else if (step.op === 'move') {
        // A move with no zones, or with the same zone twice, is not a move.
        if (!step.from || !step.to || !ZONE_BY_ID.has(step.from) || !ZONE_BY_ID.has(step.to)) continue;
        if (step.from === step.to || ZONE_BY_ID.get(step.from)!.toOnly) continue;
        if (step.qx && (!knownAmount(step.qx) || step.qx.kind === 'all')) continue;
      } else if (step.op === 'flicker') {
        // Both ends are the battlefield and neither is a choice, so there are
        // no zones to check. The criteria still is one.
        if (step.qx && (!knownAmount(step.qx) || step.qx.kind === 'all')) continue;
      } else if (step.x.kind === 'all') {
        // "All that match" is bounded by the zone it draws from, and only a
        // move has one. "Draw all" would be MAX_BEHAVIOR_AMOUNT wearing a hat.
        continue;
      }
      bucket.push(step);
    }
    if (trigger.watches && bucket.length > 0) {
      const q = typeof rule.q === 'string' ? rule.q.trim() : '';
      out[rule.on as WatchedTrigger].push(q ? { q, steps: bucket } : { steps: bucket });
    }
  }
  const fires =
    out.play.length > 0 ||
    out.etb.length > 0 ||
    out.attack.length > 0 ||
    out.death.length > 0 ||
    out.upkeep.length > 0 ||
    out.cast.length > 0 ||
    out.enters.length > 0;
  return fires ? out : null;
}

/**
 * Every distinct criteria string a compiled behavior uses, for the caller that
 * has to turn them into per-card bitmasks. Lives here because the grammar is
 * what knows which steps carry a query.
 */
export function collectBehaviorQueries(b: CompiledBehavior | null | undefined, into: Set<string>): void {
  if (!b) return;
  for (const steps of [b.play, b.etb, b.attack, b.death, b.upkeep]) {
    for (const step of steps) if (step.q) into.add(step.q);
  }
  // A watched rule has two kinds of criteria on it: the one that says which
  // cards wake it, and whatever its own steps narrow with. Both compile the
  // same way and both come out as a byte per card.
  for (const rules of [b.cast, b.enters]) {
    for (const rule of rules) {
      if (rule.q) into.add(rule.q);
      for (const step of rule.steps) if (step.q) into.add(step.q);
    }
  }
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function cleanAmount(raw: unknown): BehaviorAmount | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !AMOUNT_BY_ID.has(kind)) return null;
  if (kind === 'fixed') {
    const n = typeof raw.n === 'number' && Number.isFinite(raw.n) ? Math.round(raw.n) : 0;
    return { kind: 'fixed', n: Math.max(0, Math.min(MAX_BEHAVIOR_AMOUNT, n)) };
  }
  const out: BehaviorAmount = { kind: kind as BehaviorAmountKind };
  // An adjustment of zero is not an adjustment, and an amount the catalog says
  // takes none never keeps one. Both are dropped rather than stored, so saving
  // the same rule twice is the same bytes — §12.3's promise, one level down.
  if (!AMOUNT_BY_ID.get(kind)!.noAdjust && typeof raw.op === 'string' && OP_BY_ID.has(raw.op)) {
    const by = typeof raw.by === 'number' && Number.isFinite(raw.by) ? Math.round(raw.by) : 0;
    if (by >= 1) {
      out.op = raw.op as BehaviorAmountOp;
      out.by = Math.min(MAX_BEHAVIOR_AMOUNT, by);
    }
  }
  return out;
}

/**
 * A behavior off the wire or off another device. Unlike most row sanitizers
 * here this one is strict all the way down and keeps nothing it cannot name: a
 * behavior is small, self-contained, and re-authorable in ten seconds, so
 * dropping a step nobody can parse costs far less than storing one nobody can.
 *
 * The versioned `v` is what makes that safe. A newer grammar arrives with a `v`
 * this build rejects, so it is refused whole rather than quietly stripped down
 * to the steps that happen to still parse.
 */
export function sanitizeCardBehavior(raw: unknown): CardBehavior | null {
  if (!isRecord(raw) || raw.v !== CARD_BEHAVIOR_VERSION || !Array.isArray(raw.rules)) return null;
  const rules: BehaviorRule[] = [];
  for (const r of raw.rules.slice(0, MAX_BEHAVIOR_RULES)) {
    if (!isRecord(r) || typeof r.on !== 'string' || !TRIGGER_BY_ID.has(r.on) || !Array.isArray(r.steps)) continue;
    const steps: BehaviorStep[] = [];
    for (const s of r.steps.slice(0, MAX_BEHAVIOR_STEPS)) {
      if (!isRecord(s) || typeof s.op !== 'string' || !STEP_BY_ID.has(s.op)) continue;
      const op = s.op as BehaviorStepKind;
      const from = typeof s.from === 'string' && ZONE_BY_ID.has(s.from) ? (s.from as BehaviorZone) : null;
      const to = typeof s.to === 'string' && ZONE_BY_ID.has(s.to) ? (s.to as BehaviorZone) : null;
      // How it lands, on the one destination that has two ways to. Kept only
      // where it means something, so a step moving cards to the graveyard never
      // stores an answer to a question nobody asked it.
      const landing = to === 'battlefield' && s.untapped === true ? { untapped: true as const } : {};
      if (op === 'self') {
        // One card, and it is the card the rule is on, so the amount is not a
        // choice anybody makes. Normalized rather than kept, so two saves of
        // the same rule are the same bytes.
        if (!to) continue;
        steps.push({ op, x: { kind: 'fixed', n: 1 }, to, ...landing });
        continue;
      }
      const x = cleanAmount(s.x);
      if (!x) continue;
      if (op === 'mana') {
        if (x.kind === 'all') continue;
        // All five colors and no colors at all are the same rule, so they are
        // the same bytes — see normalizeManaColors. "All of one color" says
        // nothing when there is only one on offer, so it is dropped there too.
        const colors = normalizeManaColors(typeof s.colors === 'string' ? s.colors : '');
        const one = s.oneColor === true && (colors === '' || colors.length > 1) ? { oneColor: true as const } : {};
        steps.push({ op, x, ...(colors ? { colors } : {}), ...one });
        continue;
      }
      if (op !== 'move' && op !== 'flicker') {
        if (x.kind === 'all') continue;
        steps.push({ op, x });
        continue;
      }
      // The criteria, and the amount filling any `[X]` in it. `qx` only means
      // something when the query has somewhere to put it, and "all that match"
      // is a count rather than a number, so it cannot fill one.
      const q = typeof s.q === 'string' ? s.q.trim().slice(0, MAX_BEHAVIOR_QUERY) : '';
      const qx = q && queryHasX(q) ? cleanAmount(s.qx) : null;
      const narrowed = qx && qx.kind !== 'all' ? { q, qx } : q ? { q } : {};
      if (op === 'flicker') {
        // Both ends are the battlefield, so a flicker has no zones to store.
        // "All that match" is bounded by the battlefield, which it does have.
        steps.push({ op, x, ...narrowed });
        continue;
      }
      if (!from || !to || from === to || ZONE_BY_ID.get(from)!.toOnly) continue;
      steps.push({ op, x, from, to, ...narrowed, ...landing });
    }
    if (steps.length === 0) continue;
    const on = r.on as BehaviorTrigger;
    // A watched trigger's own criteria. `[X]` is resolved to zero rather than
    // kept: a watched rule is woken by an event rather than resolved with a
    // number, so a placeholder here has nothing to read and would otherwise
    // cost twenty-one compiled rows nobody ever indexes into.
    const watch = TRIGGER_BY_ID.get(on)!.watches && typeof r.q === 'string' ? r.q.trim().slice(0, MAX_BEHAVIOR_QUERY) : '';
    const q = watch && queryHasX(watch) ? substituteQueryX(watch, 0) : watch;
    rules.push(q ? { on, q, steps } : { on, steps });
  }
  return rules.length > 0 ? { v: CARD_BEHAVIOR_VERSION, rules } : null;
}
