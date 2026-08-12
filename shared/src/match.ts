// The one rule for "does a concrete card satisfy a wishlist line's
// preferences?", shared by the client (Community + trade board highlighting)
// and the server (/api/matches notifications) so the two never drift.

import type { Finish } from './card.js';
import type { Condition } from './user.js';

// NM best → DMG worst. A wished condition is a *minimum*: a card is acceptable
// when it's at least that good, i.e. its rank is <= the wished rank.
const CONDITION_RANK: Record<Condition, number> = { NM: 0, LP: 1, MP: 2, HP: 3, DMG: 4 };

/** What a wish, a deck slot or a copy says about itself. Undefined = unsaid. */
export interface CopyPrefs {
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

/**
 * Could these two be about the same piece of cardboard, when either side may
 * leave a trait unsaid? An unsaid trait matches anything on either side: a slot
 * on "any language" fits every copy, and a copy of unknown language fits every
 * slot. Condition is still a minimum on the `want` side.
 */
export function prefsCompatible(want: CopyPrefs, have: CopyPrefs): boolean {
  if (want.finish && have.finish && want.finish !== have.finish) return false;
  if (want.lang && have.lang && want.lang !== have.lang) return false;
  if (want.condition && have.condition && CONDITION_RANK[have.condition] > CONDITION_RANK[want.condition])
    return false;
  return true;
}

/**
 * Does a concrete card (a tradelist line / collection entry) meet a wish's
 * finish/condition/language preferences? An undefined preference means "any".
 * Condition is a minimum — a card better than the wished condition still matches.
 * The strict form of prefsCompatible: the card knows all three, so the wish is
 * the only side that can say "any".
 */
export function wishPrefsMet(
  want: CopyPrefs,
  have: { condition: Condition; finish: Finish; lang: string },
): boolean {
  return prefsCompatible(want, have);
}

/** A wish, as far as matching cares: the card, the printing it pinned, the prefs. */
export interface WishTarget extends CopyPrefs {
  oracleId: string;
  /** A specific printing, or null/undefined for "any printing of this card". */
  scryfallId?: string | null;
}

/** A concrete copy someone has: a tradelist line or a collection entry. */
export interface HeldCopy {
  oracleId: string;
  scryfallId?: string | null;
  condition: Condition;
  finish: Finish;
  lang: string;
}

/**
 * The whole wish-meets-copy rule in one place: same card, the printing the wish
 * pinned (unset = any printing of it), and the wish's finish/condition/language
 * preferences met. Leaving the printing out of this is how a "I want *that* Preordain"
 * wish used to light up every other Preordain in someone's binder.
 */
export function wishMatchesCopy(want: WishTarget, have: HeldCopy): boolean {
  if (want.oracleId !== have.oracleId) return false;
  if (want.scryfallId && want.scryfallId !== have.scryfallId) return false;
  return wishPrefsMet(want, have);
}
