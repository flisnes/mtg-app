import { compareCardTags } from '@mtg/shared';

// Card tags are per-container labels stored on the slot itself (DeckCard.tags),
// so "the tags this deck has" is never a stored list — it's whatever its slots
// are carrying right now. These helpers are the derivation, used by the tag
// sheet, the tag field and the group-by-tag heading order alike.
//
// Everything compares case-insensitively: two devices (or an import) can spell
// the same tag differently, and "Ramp" and "ramp" must not become two groups.

/** Heading for cards carrying no tags at all. */
export const UNTAGGED = 'Untagged';

/** Every tag in use across a set of slots, first spelling wins, in display order. */
export function deckTags(rows: { tags?: string[] }[]): string[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    for (const t of r.tags ?? []) {
      const key = t.toLocaleLowerCase();
      if (!seen.has(key)) seen.set(key, t);
    }
  }
  return [...seen.values()].sort(compareCardTags);
}

/** Whether a slot carries a given tag, however either side spelled it. */
export function hasTag(row: { tags?: string[] }, tag: string): boolean {
  const key = tag.toLocaleLowerCase();
  return !!row.tags?.some((t) => t.toLocaleLowerCase() === key);
}
