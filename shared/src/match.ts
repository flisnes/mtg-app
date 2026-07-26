// The one rule for "does a concrete card satisfy a wishlist line's
// preferences?", shared by the client (Community + trade board highlighting)
// and the server (/api/matches notifications) so the two never drift.

import type { Finish } from './card.js';
import type { Condition } from './user.js';

// NM best → DMG worst. A wished condition is a *minimum*: a card is acceptable
// when it's at least that good, i.e. its rank is <= the wished rank.
const CONDITION_RANK: Record<Condition, number> = { NM: 0, LP: 1, MP: 2, HP: 3, DMG: 4 };

/**
 * Does a concrete card (a tradelist line / collection entry) meet a wish's
 * finish/condition/language preferences? An undefined preference means "any".
 * Condition is a minimum — a card better than the wished condition still matches.
 */
export function wishPrefsMet(
  want: { condition?: Condition; finish?: Finish; lang?: string },
  have: { condition: Condition; finish: Finish; lang: string },
): boolean {
  if (want.finish && want.finish !== have.finish) return false;
  if (want.lang && want.lang !== have.lang) return false;
  if (want.condition && CONDITION_RANK[have.condition] > CONDITION_RANK[want.condition]) return false;
  return true;
}
