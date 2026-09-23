import { oracleTagClosure } from '../cardDb/oracleTags.js';
import type { DeckRow, SimDeck } from './simDeck.js';

// The half of §11.4's coverage report that `SimDeck.coverage` cannot produce.
//
// The simulator knows what it modelled. It does not know what it *should* have
// modelled, because an OracleCard with no `effect` looks the same whether the
// card genuinely does nothing to your hand or whether its draw hangs off a
// combat trigger that the pipeline's rule 2 deliberately refused to read.
//
// Scryfall's oracle tags know, and this app already ships them for `otag:`
// search. So the honest number is the intersection: cards Tagger calls draw
// spells that reach the sequencer as blanks. Across the whole card DB that is
// 3,459 of 4,310 draw-tagged cards, so for most decks it is not a rounding
// error and it has no business being left off the panel.
//
// Best-effort. With no vocabulary loaded (offline on a first run, or a card DB
// built before the tags artifact existed) this returns null and the line goes
// unsaid, which is the right answer to a question we could not ask.

/** The tags whose subtrees this counts. Everything under "draw" is a draw card. */
const DRAW_SLUG = 'draw';
const RAMP_SLUG = 'ramp';

/** A card the tags say should be doing work and the simulator plays as nothing. */
export interface IdleEngine {
  oracleId: string;
  name: string;
  /** Copies in the library. Zero for a commander, which is never drawn. */
  copies: number;
  commander: boolean;
}

/** The two lenses of "Who does the work", each with its cards stuck at zero. */
export interface IdleEngines {
  /** Tagged ramp, and nothing about it makes mana in the simulator. */
  mana: IdleEngine[];
  /** Tagged draw, and it draws nothing in the simulator. */
  cards: IdleEngine[];
}

/**
 * Cards the tags call draw or ramp that the sequencer resolves as nothing, or
 * null when the tag vocabulary is not available (rebuild plan B3).
 *
 * Read off the built deck rather than the rows, because the deck knows what the
 * user wrote: a Korvold with a behavior on it is theirs, not a gap.
 *
 * A card that already carries an `effect` is excluded whatever its tags say:
 * Faithless Looting is a draw card we do model, and listing it here would turn
 * the panel into a complaint about the cards that work. Anything the sequencer
 * files as a mana source (rock, dork, land ramp, ritual, extra land) is
 * modelled for the same reason.
 *
 * Lands are excluded too. A cycling land is tagged as draw, is modelled as a
 * land, and its draw is an activated ability nothing here would pay for, so
 * naming it as a gap would be pointing at the wrong thing.
 */
export function idleEngines(rows: readonly DeckRow[], deck: SimDeck): IdleEngines | null {
  const draw = oracleTagClosure(DRAW_SLUG);
  const ramp = oracleTagClosure(RAMP_SLUG);
  if (!draw && !ramp) return null;
  const out: IdleEngines = { mana: [], cards: [] };
  for (const { card, tags: t } of blankSpells(rows, deck)) {
    const idle: IdleEngine = { oracleId: card.oracleId, name: card.name, copies: card.copies, commander: card.commander };
    if (draw && t.some((i) => draw.has(i))) out.cards.push(idle);
    if (ramp && t.some((i) => ramp.has(i))) out.mana.push(idle);
  }
  const byName = (a: IdleEngine, b: IdleEngine) => a.name.localeCompare(b.name);
  out.cards.sort(byName);
  out.mana.sort(byName);
  return out;
}

/**
 * The spells the sequencer resolves as nothing, with their tags. Shared by
 * the two questions below so "doing nothing" means one thing on both tabs.
 */
function* blankSpells(rows: readonly DeckRow[], deck: SimDeck) {
  const tags = new Map<string, readonly number[]>();
  for (const r of rows) if (r.oracle?.tags) tags.set(r.oracle.oracleId, r.oracle.tags);
  for (const card of deck.cards) {
    if (card.role !== 'spell' || card.effect || card.behavior) continue;
    if (card.copies <= 0 && !card.commander) continue;
    const t = tags.get(card.oracleId);
    if (t) yield { card, tags: t };
  }
}

/**
 * Why a card is in the Model tab's queue, in the order the queue ranks them.
 * Draw and ramp first because Flow and Mana measure exactly those; a tutor or
 * an engine moves the plan, which the simulator only half sees until E1.
 */
export type QueueReason = 'draw' | 'ramp' | 'tutor' | 'engine';
const QUEUE_RANK: Record<QueueReason, number> = { draw: 0, ramp: 1, tutor: 2, engine: 3 };

/**
 * Tags that make a card an engine for the queue: card advantage that is not a
 * draw (impulse, regrowth), repeatable tokens, and recursion. A Grave Titan
 * resolving as a 6/6 and nothing else is a gap; a Murder resolving as nothing
 * is the model being right.
 */
const ENGINE_SLUGS = ['card-advantage', 'repeatable-token-generator', 'recursion'];
const TUTOR_SLUG = 'tutor';

/** One card worth writing a rule for, and why it made the list. */
export interface QueueCard extends IdleEngine {
  reason: QueueReason;
}

/**
 * The cards worth modelling first (rebuild plan C1), or null when the tag
 * vocabulary is not there to ask.
 *
 * Same test as idleEngines, wider net: a spell the tags say should be doing
 * work and the simulator plays as nothing. Ranked by what writing it moves:
 * the commander first (every game has it), then by reason, then cheaper
 * first (cast earlier, so it is working for more of the turns we measure),
 * then more copies.
 */
export function modelQueue(rows: readonly DeckRow[], deck: SimDeck): QueueCard[] | null {
  const lists: [QueueReason, ReadonlySet<number> | null][] = [
    ['draw', oracleTagClosure(DRAW_SLUG)],
    ['ramp', oracleTagClosure(RAMP_SLUG)],
    ['tutor', oracleTagClosure(TUTOR_SLUG)],
    ['engine', union(ENGINE_SLUGS.map(oracleTagClosure))],
  ];
  if (lists.every(([, set]) => !set)) return null;
  const mv = new Map<string, number>();
  for (const r of rows) if (r.oracle) mv.set(r.oracle.oracleId, r.oracle.cmc);
  const out: QueueCard[] = [];
  for (const { card, tags: t } of blankSpells(rows, deck)) {
    const hit = lists.find(([, set]) => set && t.some((i) => set.has(i)));
    if (!hit) continue;
    out.push({ oracleId: card.oracleId, name: card.name, copies: card.copies, commander: card.commander, reason: hit[0] });
  }
  const cost = (c: QueueCard) => mv.get(c.oracleId) ?? 0;
  return out.sort(
    (a, b) =>
      Number(b.commander) - Number(a.commander) ||
      QUEUE_RANK[a.reason] - QUEUE_RANK[b.reason] ||
      cost(a) - cost(b) ||
      b.copies - a.copies ||
      a.name.localeCompare(b.name),
  );
}

function union(sets: (ReadonlySet<number> | null)[]): ReadonlySet<number> | null {
  const present = sets.filter((s): s is ReadonlySet<number> => !!s);
  if (present.length === 0) return null;
  const out = new Set<number>();
  for (const s of present) for (const i of s) out.add(i);
  return out;
}

/**
 * Copies in the library that the tags call draw spells and the sequencer
 * resolves as blanks, or null when the tag vocabulary is not available. A
 * commander is not in the library, so it is not in this count.
 */
export function missedDrawCopies(idle: IdleEngines | null): number | null {
  if (!idle || !oracleTagClosure(DRAW_SLUG)) return null;
  return idle.cards.reduce((sum, c) => sum + c.copies, 0);
}
