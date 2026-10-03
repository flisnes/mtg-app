// Rebuild plan E1: goals. "A ramp piece in play, four mana and my commander
// cast by turn four" is a conjunction over correlated events, which no
// hypergeometric can express and the simulator gets for nothing: each game is
// one yes or no, read at the end of each turn (mana-model notes §14.6).
//
// A goal is a list of terms and a turn. Every term has to hold at the end of
// the same turn, on or before the goal's turn. `cast` and `drawn` only ever
// grow through a game, so for them "by turn N" is the plain reading; `have`,
// `inPlay` and `mana` are read as the turn ends, which in a goldfish is close
// to the same thing (nothing across the table takes anything away).
//
// Goals live with the deck's play policy and keep rule rather than in a synced
// table: they are a lens you look at the deck through, and a schema change
// plus a repair on every older device is a lot to pay for one. That stays
// open; see the plan's log.

export type GoalTermKind = 'have' | 'cast' | 'inPlay' | 'drawn' | 'mana' | 'commander';

export interface GoalTerm {
  kind: GoalTermKind;
  /** At least this many. */
  n: number;
  /**
   * Which cards count, as a Scryfall query matched against this deck, the
   * same syntax a card rule's criteria use. Empty is every card. Unused by
   * `mana` and `commander`.
   */
  q?: string;
}

export interface SimGoal {
  /** Stable id, for the list and the result. */
  id: string;
  /** By the end of this turn. */
  turn: number;
  /** All of them at once. */
  terms: GoalTerm[];
}

/** How one goal came out: P(every term held at the end of some turn up to t). */
export interface SimGoalResult {
  id: string;
  /** Cumulative, indexed by turn; index 0 is unused. */
  byTurn: number[];
  /** `byTurn` at the goal's turn. */
  p: number;
}

export interface GoalTermOption {
  id: GoalTermKind;
  label: string;
  /** How the term reads in a sentence, with the count and criteria filled in. */
  phrase: (n: number, q: string) => string;
  /** It names cards, so it has a criteria box. */
  cards: boolean;
}

const cardsPhrase = (n: number, q: string): string => (q ? `${n} ${n === 1 ? 'card' : 'cards'} matching ${q}` : `${n} ${n === 1 ? 'card' : 'cards'}`);

export const GOAL_TERMS: readonly GoalTermOption[] = [
  { id: 'inPlay', label: 'On the battlefield', phrase: (n, q) => `${cardsPhrase(n, q)} on the battlefield`, cards: true },
  { id: 'cast', label: 'Cast or played this game', phrase: (n, q) => `${cardsPhrase(n, q)} cast or played`, cards: true },
  { id: 'have', label: 'In hand', phrase: (n, q) => `${cardsPhrase(n, q)} in hand`, cards: true },
  { id: 'drawn', label: 'Seen this game', phrase: (n, q) => `${cardsPhrase(n, q)} seen`, cards: true },
  { id: 'mana', label: 'Mana available', phrase: (n) => `${n} mana available`, cards: false },
  { id: 'commander', label: 'Commander cast', phrase: () => 'your commander cast', cards: false },
];

const TERM_BY_ID = new Map(GOAL_TERMS.map((t) => [t.id as string, t]));

/** Goals one deck can hold, and terms one goal can hold. */
export const MAX_GOALS = 8;
export const MAX_GOAL_TERMS = 4;
export const MAX_GOAL_TERM_N = 20;
/** Characters in a term's criteria, the card rules' ceiling. */
export const MAX_GOAL_QUERY = 120;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One goal as stored, or null when nothing of it survives. */
export function cleanGoal(raw: unknown, maxTurn: number): SimGoal | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const turnRaw = typeof raw.turn === 'number' ? Math.round(raw.turn) : NaN;
  const turn = Number.isFinite(turnRaw) ? Math.min(maxTurn, Math.max(1, turnRaw)) : maxTurn;
  const terms: GoalTerm[] = [];
  if (Array.isArray(raw.terms)) {
    for (const t of raw.terms) {
      if (terms.length >= MAX_GOAL_TERMS || !isRecord(t)) continue;
      const opt = TERM_BY_ID.get(String(t.kind));
      if (!opt) continue;
      const nRaw = typeof t.n === 'number' ? Math.round(t.n) : 1;
      const n = opt.id === 'commander' ? 1 : Math.min(MAX_GOAL_TERM_N, Math.max(1, Number.isFinite(nRaw) ? nRaw : 1));
      const q = opt.cards && typeof t.q === 'string' ? t.q.trim().slice(0, MAX_GOAL_QUERY) : '';
      terms.push(q ? { kind: opt.id, n, q } : { kind: opt.id, n });
    }
  }
  if (terms.length === 0) return null;
  return { id: raw.id.slice(0, 40), turn, terms };
}

/** A list as stored (localStorage, a JSON array), cleaned and capped. */
export function cleanGoals(raw: unknown, maxTurn: number): SimGoal[] {
  if (!Array.isArray(raw)) return [];
  const out: SimGoal[] = [];
  const ids = new Set<string>();
  for (const g of raw) {
    const goal = cleanGoal(g, maxTurn);
    if (!goal || ids.has(goal.id)) continue;
    ids.add(goal.id);
    out.push(goal);
    if (out.length >= MAX_GOALS) break;
  }
  return out;
}

/** "4 lands on the battlefield and your commander cast, by turn 4". */
export function describeGoal(goal: SimGoal): string {
  const bits = goal.terms.map((t) => TERM_BY_ID.get(t.kind)!.phrase(t.n, t.q ?? ''));
  const all = bits.length <= 1 ? (bits[0] ?? '') : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`;
  return `${all}, by turn ${goal.turn}`;
}

/** Every criteria string the goals use, for the deck's filter build. */
export function collectGoalQueries(goals: readonly SimGoal[] | undefined, into: Set<string>): void {
  for (const g of goals ?? []) for (const t of g.terms) if (t.q) into.add(t.q);
}

/**
 * The goals the Plan tab offers to start from. Plain queries only, so they
 * work before the tag vocabulary has loaded; the turn is the usual one for
 * each and the panel lets you move it.
 */
export interface GoalPreset {
  label: string;
  turn: number;
  terms: GoalTerm[];
}

export const GOAL_PRESETS: readonly GoalPreset[] = [
  { label: 'Four lands by turn 4', turn: 4, terms: [{ kind: 'inPlay', n: 4, q: 't:land' }] },
  { label: 'Five mana on turn 4', turn: 4, terms: [{ kind: 'mana', n: 5 }] },
  { label: 'A creature by turn 3', turn: 3, terms: [{ kind: 'inPlay', n: 1, q: 't:creature' }] },
  { label: 'Three creatures by turn 5', turn: 5, terms: [{ kind: 'inPlay', n: 3, q: 't:creature' }] },
  { label: 'Commander cast by turn 4', turn: 4, terms: [{ kind: 'commander', n: 1 }] },
  { label: 'Commander and a ramp piece by turn 4', turn: 4, terms: [{ kind: 'commander', n: 1 }, { kind: 'inPlay', n: 1, q: 'otag:ramp' }] },
];

let seq = 0;
/** An id for a new goal: time plus a counter, unique enough for one device's list. */
export const newGoalId = (): string => `g${Date.now().toString(36)}${(seq++).toString(36)}`;
