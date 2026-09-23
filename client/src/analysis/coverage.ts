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
  const tags = new Map<string, readonly number[]>();
  for (const r of rows) if (r.oracle?.tags) tags.set(r.oracle.oracleId, r.oracle.tags);
  const out: IdleEngines = { mana: [], cards: [] };
  for (const card of deck.cards) {
    if (card.role !== 'spell' || card.effect || card.behavior) continue;
    if (card.copies <= 0 && !card.commander) continue;
    const t = tags.get(card.oracleId);
    if (!t) continue;
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
 * Copies in the library that the tags call draw spells and the sequencer
 * resolves as blanks, or null when the tag vocabulary is not available. A
 * commander is not in the library, so it is not in this count.
 */
export function missedDrawCopies(idle: IdleEngines | null): number | null {
  if (!idle || !oracleTagClosure(DRAW_SLUG)) return null;
  return idle.cards.reduce((sum, c) => sum + c.copies, 0);
}
