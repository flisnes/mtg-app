import { namesCopy, specialKey } from '@mtg/shared';
import type { CollectionEntry, Condition, DeckBoard, DeckCard, Finish, SlotCopyFields, SpecialCondition } from '@mtg/shared';
import { db } from './schema.js';

// What identifies a row: ids, the collection and wishlist keys, the slot keys,
// and the small helpers every write module shares.

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * What one piece of cardboard IS, for matching purposes: printing, condition,
 * finish, language. This is the key a deck slot claims a copy with, the key the
 * placement index counts owned copies by, and the key a trade or import line
 * spells out. Special conditions are deliberately absent — nothing about
 * matching a card cares whether it's signed.
 *
 * Not the same as a collection ROW's identity: two rows can share this key and
 * differ in their special conditions. See entryKey.
 */
export function collectionKey(e: { scryfallId: string; condition: string; finish: string; lang?: string }): string {
  return `${e.scryfallId}|${e.condition}|${e.finish}|${e.lang || 'en'}`;
}

/**
 * The uniqueness key of a collection ROW: what the card is, plus what's
 * remarkable about this particular copy. Your altered Bolt and your plain one
 * are one printing in one grade, but two lines on the shelf — marking one
 * altered must not mark the other, and adding a plain copy must not land on the
 * altered row.
 *
 * The Dexie index only covers collectionKey's four fields (a row's specials are
 * an array, which an index can't spell), so a lookup by this key queries the
 * index and then picks the row whose specials match — see findCollectionRow.
 */
export function entryKey(e: {
  scryfallId: string;
  condition: string;
  finish: string;
  lang?: string;
  special?: readonly SpecialCondition[];
}): string {
  return `${collectionKey(e)}|${specialKey(e.special)}`;
}

/**
 * The one row for a copy identity + special conditions, via the compound index.
 * Callers with no specials to name (an import line, a received trade card, an
 * undo of an add) get the ordinary copy, which is what they mean.
 */
export async function findCollectionRow(
  e: { scryfallId: string; condition: Condition; finish: Finish; lang: string; special?: readonly SpecialCondition[] },
): Promise<CollectionEntry | undefined> {
  const rows = await db.collection
    .where('[scryfallId+condition+finish+lang]')
    .equals([e.scryfallId, e.condition, e.finish, e.lang])
    .toArray();
  const want = specialKey(e.special);
  return rows.find((r) => specialKey(r.special) === want);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Everything a slot says about the copy it names — what it takes to find that
 *  copy's rows. A lands-box basic and a vague brew line name nothing.
 *
 *  Deliberately ignores `unfiled`, unlike claimKeyOf in deck/filing.ts: an
 *  emptied slot still names its copy, and flipping that flag is precisely the
 *  filing change worth stamping on it. */
export function namedCopy(s: SlotCopyFields): CopyRef | undefined {
  if (!namesCopy(s)) return undefined;
  return { scryfallId: s.scryfallId, condition: s.condition, finish: s.finish, lang: s.lang };
}

export type CopyRef = { scryfallId: string; condition: Condition; finish: Finish; lang: string };

/** The one physical copy a slot names, when it names one at all — the collection
 *  key its own fields spell out. The same rule as claimKeyOf in deck/filing.ts,
 *  restated here so the mutation layer needn't import from the deck layer. */
export function slotClaimKey(s: DeckCard): string | undefined {
  const ref = namedCopy(s);
  return ref && collectionKey(ref);
}

/** Identity of a wish line: printing + desired condition/finish/lang (undefined
 *  = "any"). Two wishes that differ on any of these are distinct lines, exactly
 *  as collection entries are unique on (scryfallId, condition, finish, lang). */
export function wishKey(w: { scryfallId: string | null; condition?: Condition; finish?: Finish; lang?: string }): string {
  return `${w.scryfallId ?? ''}|${w.condition ?? ''}|${w.finish ?? ''}|${w.lang ?? ''}`;
}

/**
 * What makes a container slot unique: the card, the board, and whether it's an
 * "any printing" basic. The last part keeps the lands-box Islands out of the
 * slot holding the Islands you actually own.
 */
export const slotKey = (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean }) =>
  `${c.oracleId}|${c.board}|${c.anyBasic ? 'any' : ''}`;

/** What a slot asks of the copy filling it; every field undefined = "any". */
export interface SlotWants {
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

/**
 * The stricter identity, for filing copies you physically own: printing, finish,
 * condition and language all count. A decklist line is happy to fold "Wrath of
 * God" into one slot however many editions you feed it; a box of cards is not,
 * because the Alpha one and the beat-up Portal one are different pieces of
 * cardboard sitting in there. "Any printing" basics stay their own slot as ever.
 */
export const exactSlotKey = (
  c: { oracleId: string; board: DeckBoard; anyBasic?: boolean; scryfallId?: string; unfiled?: boolean },
  wants: SlotWants | undefined,
) =>
  c.anyBasic
    ? slotKey(c)
    : // An emptied-out slot (DeckCard.unfiled) is its own line: filing the card
      // back in must land on cardboard that's actually here, not quietly bump
      // the line that says the deck is missing it.
      `${c.oracleId}|${c.board}|${c.scryfallId ?? ''}|${wants?.condition ?? ''}|${wants?.finish ?? ''}|${wants?.lang ?? ''}|${c.unfiled ? 'out' : ''}`;

