import type { EffectProfile, ManaProfile } from './card.js';

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

/** When a rule fires. */
export type BehaviorTrigger = 'play' | 'upkeep';

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

/** What one step does. */
export type BehaviorStepKind = 'draw' | 'mill' | 'discard' | 'scry' | 'surveil' | 'treasure' | 'move' | 'self';

/**
 * Where a step's number comes from.
 *
 * `prev` is the odd one: it reads no game state at all, only what the step
 * before it actually did. Windfall is "discard your hand, then draw that many",
 * and every amount here is read as its own step runs, so the second `hand`
 * would be zero — correct arithmetic, wrong card. This is the number that step
 * reached, carried forward one place.
 */
export type BehaviorAmountKind = 'fixed' | 'all' | 'prev' | 'hand' | 'library' | 'lands' | 'graveyard' | 'turn' | 'xpaid';

/**
 * Arithmetic on an amount, so "half your library" and "that many minus one" are
 * writable without a new amount kind for each of them.
 *
 * One operator and one number, applied once, and no nesting. That covers Dark
 * Deal (X - 1), Peer Into the Abyss (X / 2) and the double-up effects; an
 * expression language would cover a handful more and cost a parser, precedence
 * rules and errors pointing into the middle of a formula.
 */
export type BehaviorAmountOp = '+' | '-' | '*' | '/';

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

/** Rules on one card. Four triggers' worth is already more than any real card. */
export const MAX_BEHAVIOR_RULES = 4;
/** Steps in one rule. */
export const MAX_BEHAVIOR_STEPS = 6;
/**
 * The ceiling on any one step, authored or computed. It is a guard rather than
 * a rules statement: an amount that reads the game state can run away (a hand
 * of forty in a deck that draws its whole library), and the sequencer's arrays
 * are fixed-size.
 */
export const MAX_BEHAVIOR_AMOUNT = 20;
/**
 * Characters in a move step's criteria. Long enough for anything worth writing
 * (`t:creature mv<=3 -t:legendary` is 29) and short enough that a behavior row
 * stays comfortably inside SYNC_MAX_ROW_BYTES.
 */
export const MAX_BEHAVIOR_QUERY = 120;
/**
 * How many values of `[X]` a filter has to be compiled for. The placeholder is
 * filled by an amount and every amount is clamped to MAX_BEHAVIOR_AMOUNT, so
 * the whole range is twenty-one bitmasks — which is what keeps a runtime value
 * out of the simulator's inner loop. That bound now earns its keep twice.
 */
export const X_VARIANTS = MAX_BEHAVIOR_AMOUNT + 1;

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
}

export const BEHAVIOR_TRIGGERS: readonly TriggerOption[] = [
  {
    id: 'play',
    label: 'When played',
    lead: 'When you play it',
    hint: 'Resolves once, the turn you cast it or put it down.',
  },
  {
    id: 'upkeep',
    label: 'Each upkeep',
    lead: 'At each of your upkeeps',
    hint: 'Fires every turn from the one after it lands. For permanents that stay on the battlefield.',
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
  { id: 'move', label: 'Move X between zones', verb: 'move' },
  { id: 'self', label: 'Put this card into a zone', verb: 'put' },
];

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

export const BEHAVIOR_AMOUNTS: readonly AmountOption[] = [
  { id: 'fixed', label: 'a fixed number', phrase: '', noAdjust: true },
  { id: 'all', label: 'all that match', phrase: 'all that match', moveOnly: true, noAdjust: true },
  { id: 'prev', label: 'the previous X', phrase: 'the previous X', needsPrev: true },
  { id: 'xpaid', label: 'the mana you spent on X', phrase: 'the mana you spent on X', needsX: true },
  { id: 'hand', label: 'cards in your hand', phrase: 'cards in your hand' },
  { id: 'library', label: 'cards in your library', phrase: 'cards in your library' },
  { id: 'lands', label: 'lands you control', phrase: 'lands you control' },
  { id: 'graveyard', label: 'cards in your graveyard', phrase: 'cards in your graveyard' },
  { id: 'turn', label: 'the turn number', phrase: 'the turn number' },
];

export interface AmountOpOption {
  id: BehaviorAmountOp;
  /** For the picker, where a word is easier to hit and easier to read than a glyph. */
  label: string;
  /** For writing the rule out, where the glyph is shorter than the word. */
  sign: string;
}

export const BEHAVIOR_AMOUNT_OPS: readonly AmountOpOption[] = [
  { id: '+', label: 'plus', sign: '+' },
  { id: '-', label: 'minus', sign: '-' },
  { id: '*', label: 'times', sign: '×' },
  { id: '/', label: 'divided by', sign: '÷' },
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
 * Division rounds **down**, which is both what every card that halves something
 * prints and the direction §11.4 wants: a model that rounds up is a model that
 * over-promises. An op this build does not recognize cannot reach here —
 * compileBehavior drops the step and sanitizeCardBehavior drops the adjustment
 * — so the fallthrough is the unmodified number rather than a guess.
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
    default:
      return value;
  }
}

export function describeAmount(x: BehaviorAmount): string {
  const base = x.kind === 'fixed' ? String(x.n ?? 0) : (AMOUNT_BY_ID.get(x.kind)?.phrase ?? '?');
  if (!x.op || !x.by) return base;
  return `${base} ${OP_BY_ID.get(x.op)?.sign ?? x.op} ${x.by}`;
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

export function describeStep(step: BehaviorStep): string {
  const verb = STEP_BY_ID.get(step.op)?.verb ?? step.op;
  const computed = step.x.kind !== 'fixed';
  const count = computed ? 'X' : String(step.x.n ?? 0);
  const tail = computed ? ` (X = ${describeAmount(step.x)})` : '';
  // The one step that is about the card holding the rule rather than about the
  // cards it can reach, so it has no count and no criteria to read out.
  if (step.op === 'self') return `put this card ${intoPrep(step.to)} ${intoPhrase(step.to)}`;
  if (step.op === 'move') {
    const from = ZONE_BY_ID.get(step.from ?? '')?.phrase ?? 'somewhere';
    const to = intoPhrase(step.to);
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
  if (step.op === 'treasure') {
    const many = computed || (step.x.n ?? 0) !== 1;
    return `${verb} ${count} Treasure${many ? 's' : ''}${tail}`;
  }
  return `${verb} ${count}${tail}`;
}

/** One rule as a sentence: "When you play it: draw 2, then discard 1". */
export function describeRule(rule: BehaviorRule): string {
  const lead = TRIGGER_BY_ID.get(rule.on)?.lead ?? rule.on;
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
export interface CompiledBehavior {
  play: BehaviorStep[];
  upkeep: BehaviorStep[];
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
  const out: CompiledBehavior = { play: [], upkeep: [] };
  for (const rule of b.rules) {
    const bucket = rule?.on === 'play' ? out.play : rule?.on === 'upkeep' ? out.upkeep : null;
    if (!bucket || !Array.isArray(rule.steps)) continue;
    for (const step of rule.steps) {
      if (!step || !STEP_BY_ID.has(step.op) || !knownAmount(step.x)) continue;
      if (step.op === 'self') {
        if (!step.to || !ZONE_BY_ID.has(step.to)) continue;
      } else if (step.op === 'move') {
        // A move with no zones, or with the same zone twice, is not a move.
        if (!step.from || !step.to || !ZONE_BY_ID.has(step.from) || !ZONE_BY_ID.has(step.to)) continue;
        if (step.from === step.to || ZONE_BY_ID.get(step.from)!.toOnly) continue;
        if (step.qx && (!knownAmount(step.qx) || step.qx.kind === 'all')) continue;
      } else if (step.x.kind === 'all') {
        // "All that match" is bounded by the zone it draws from, and only a
        // move has one. "Draw all" would be MAX_BEHAVIOR_AMOUNT wearing a hat.
        continue;
      }
      bucket.push(step);
    }
  }
  return out.play.length > 0 || out.upkeep.length > 0 ? out : null;
}

/**
 * Every distinct criteria string a compiled behavior uses, for the caller that
 * has to turn them into per-card bitmasks. Lives here because the grammar is
 * what knows which steps carry a query.
 */
export function collectBehaviorQueries(b: CompiledBehavior | null | undefined, into: Set<string>): void {
  if (!b) return;
  for (const step of b.play) if (step.q) into.add(step.q);
  for (const step of b.upkeep) if (step.q) into.add(step.q);
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
      if (op === 'self') {
        // One card, and it is the card the rule is on, so the amount is not a
        // choice anybody makes. Normalized rather than kept, so two saves of
        // the same rule are the same bytes.
        if (!to) continue;
        steps.push({ op, x: { kind: 'fixed', n: 1 }, to });
        continue;
      }
      const x = cleanAmount(s.x);
      if (!x) continue;
      if (op !== 'move') {
        if (x.kind === 'all') continue;
        steps.push({ op, x });
        continue;
      }
      if (!from || !to || from === to || ZONE_BY_ID.get(from)!.toOnly) continue;
      const q = typeof s.q === 'string' ? s.q.trim().slice(0, MAX_BEHAVIOR_QUERY) : '';
      if (!q) {
        steps.push({ op, x, from, to });
        continue;
      }
      // `qx` only means something when the query has somewhere to put it, and
      // "all that match" is a count rather than a number, so it cannot fill one.
      const qx = queryHasX(q) ? cleanAmount(s.qx) : null;
      steps.push(qx && qx.kind !== 'all' ? { op, x, from, to, q, qx } : { op, x, from, to, q });
    }
    if (steps.length > 0) rules.push({ on: r.on as BehaviorTrigger, steps });
  }
  return rules.length > 0 ? { v: CARD_BEHAVIOR_VERSION, rules } : null;
}
