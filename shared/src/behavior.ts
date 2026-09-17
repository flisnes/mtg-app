import type { EffectProfile } from './card.js';

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

/** What one step does. */
export type BehaviorStepKind = 'draw' | 'mill' | 'discard' | 'scry' | 'surveil' | 'treasure';

/** Where a step's number comes from. */
export type BehaviorAmountKind = 'fixed' | 'hand' | 'lands' | 'turn';

export interface BehaviorAmount {
  kind: BehaviorAmountKind;
  /** The number, for `fixed` only. Ignored (and unset) on every other kind. */
  n?: number;
}

export interface BehaviorStep {
  op: BehaviorStepKind;
  x: BehaviorAmount;
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
];

export interface AmountOption {
  id: BehaviorAmountKind;
  /** For the picker: what X equals. */
  label: string;
  /** For writing the rule out, where it follows the verb. */
  phrase: string;
}

export const BEHAVIOR_AMOUNTS: readonly AmountOption[] = [
  { id: 'fixed', label: 'a fixed number', phrase: '' },
  { id: 'hand', label: 'cards in your hand', phrase: 'cards in your hand' },
  { id: 'lands', label: 'lands you control', phrase: 'lands you control' },
  { id: 'turn', label: 'the turn number', phrase: 'the turn number' },
];

const TRIGGER_BY_ID = new Map(BEHAVIOR_TRIGGERS.map((t) => [t.id as string, t]));
const STEP_BY_ID = new Map(BEHAVIOR_STEPS.map((s) => [s.id as string, s]));
const AMOUNT_BY_ID = new Map(BEHAVIOR_AMOUNTS.map((a) => [a.id as string, a]));

// ---------------------------------------------------------------------------
// Reading one out loud
// ---------------------------------------------------------------------------

export function describeAmount(x: BehaviorAmount): string {
  if (x.kind === 'fixed') return String(x.n ?? 0);
  return AMOUNT_BY_ID.get(x.kind)?.phrase ?? '?';
}

/**
 * One step as a phrase: "draw 2", or "draw X (X = cards in your hand)".
 *
 * A computed amount keeps the X rather than reading as one — "draw cards in
 * your hand" is a sentence about what you draw, not how many — and naming it
 * the same way the editor's own dropdown does means the sentence and the
 * control you set it with say the identical thing.
 */
export function describeStep(step: BehaviorStep): string {
  const verb = STEP_BY_ID.get(step.op)?.verb ?? step.op;
  const computed = step.x.kind !== 'fixed';
  const count = computed ? 'X' : String(step.x.n ?? 0);
  const tail = computed ? ` (X = ${describeAmount(step.x)})` : '';
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

export function compileBehavior(b: CardBehavior | null | undefined): CompiledBehavior | null {
  if (!b || b.v !== CARD_BEHAVIOR_VERSION || !Array.isArray(b.rules)) return null;
  const out: CompiledBehavior = { play: [], upkeep: [] };
  for (const rule of b.rules) {
    const bucket = rule?.on === 'play' ? out.play : rule?.on === 'upkeep' ? out.upkeep : null;
    if (!bucket || !Array.isArray(rule.steps)) continue;
    for (const step of rule.steps) {
      if (!step || !STEP_BY_ID.has(step.op) || !step.x || !AMOUNT_BY_ID.has(step.x.kind)) continue;
      bucket.push(step);
    }
  }
  return out.play.length > 0 || out.upkeep.length > 0 ? out : null;
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
  if (kind !== 'fixed') return { kind: kind as BehaviorAmountKind };
  const n = typeof raw.n === 'number' && Number.isFinite(raw.n) ? Math.round(raw.n) : 0;
  return { kind: 'fixed', n: Math.max(0, Math.min(MAX_BEHAVIOR_AMOUNT, n)) };
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
      const x = cleanAmount(s.x);
      if (!x) continue;
      steps.push({ op: s.op as BehaviorStepKind, x });
    }
    if (steps.length > 0) rules.push({ on: r.on as BehaviorTrigger, steps });
  }
  return rules.length > 0 ? { v: CARD_BEHAVIOR_VERSION, rules } : null;
}
