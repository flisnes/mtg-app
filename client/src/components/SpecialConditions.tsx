import { specialLabel, type SpecialCondition } from '@mtg/shared';

// What's remarkable about one piece of cardboard beyond its grade: altered,
// signed, misprint, miscut, crimped. Several can be true of the same card, so
// the card sheet asks for them with a checkbox list (SheetSelect's `multi`
// mode) rather than a picker with one answer.
//
// This is an annotation on cardboard you own, never a fact about the card: no
// wish, deck slot or ownership count reads it (see SpecialCondition in
// shared/user.ts). It does split the collection row it sits on, so your altered
// Bolt is its own line next to the plain one.

/**
 * The "A" mark a copy with any special condition wears in lists and on tiles.
 * Shaped like the placement badge so CardItem can carry it the same way.
 */
export function specialMark(
  special: readonly SpecialCondition[] | undefined,
): { node: string; cls: string; title: string } | undefined {
  if (!special?.length) return undefined;
  return { node: 'A', cls: 'badge-special', title: specialLabel(special) };
}
