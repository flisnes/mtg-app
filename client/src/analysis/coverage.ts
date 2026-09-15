import { oracleTagClosure } from '../cardDb/oracleTags.js';
import type { DeckRow } from './simDeck.js';

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

/** The tag whose subtree this counts. Everything under "draw" is a draw card. */
const DRAW_SLUG = 'draw';

/**
 * Copies in the library that the tags call draw spells and the sequencer
 * resolves as blanks, or null when the tag vocabulary is not available.
 *
 * A card that already carries an `effect` is excluded whatever its tags say:
 * Faithless Looting is a draw card we do model, and counting it here would turn
 * the coverage line into a complaint about the cards that work.
 *
 * Lands are excluded too. A cycling land is tagged as draw, is modelled as a
 * land, and its draw is an activated ability nothing here would pay for — so
 * naming it as a gap would be pointing at the wrong thing.
 */
export function missedDrawCopies(rows: readonly DeckRow[]): number | null {
  const draw = oracleTagClosure(DRAW_SLUG);
  if (!draw) return null;
  let copies = 0;
  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0 || r.board !== 'main') continue;
    if (o.effect || o.mana || o.fetch) continue;
    if (/\bLand\b/.test(o.typeLine)) continue;
    if (!o.tags?.some((t) => draw.has(t))) continue;
    copies += r.quantity;
  }
  return copies;
}
