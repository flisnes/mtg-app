import type { Condition, ContainerKind, DeckBoard, EventSource, Finish } from '@mtg/shared';
import {
  addDeckCardsBulk,
  collectionKey,
  removeDeckCardsMatching,
  setDeckCardQuantity,
  updateDeckCard,
  type SlotWants,
} from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import { containerKind } from './containers.js';

// Filing a card, with the one rule physical cardboard obeys: a copy can only be
// in one place at a time.
//
// Every route into a deck, binder or box comes through here — the collection's
// "File away", a container's "File these somewhere else too", the card sheet, the
// search quick-add, a scan. Two modes:
//
//   'move' — take the copy out of wherever it was, then file it here. What the
//            physical act of moving a card actually does.
//   'copy' — leave the other filings alone. Brewing: the same card listed in two
//            decks you might build, only one of which is assembled right now.
//
// Which one you get is `prefs.filingPolicy`; on 'ask' the caller shows
// FilingChoiceSheet with the clashes this module found.

/**
 * The key identifying one physical copy — printing, finish, condition, language,
 * exactly a collection entry's own identity. A slot only has one when it names
 * all four (which is what filing an owned copy writes); anything vaguer is a brew
 * line that claims no cardboard, so it can never clash with anything. Kept here
 * because both the placement index and the filing prompt have to agree on it.
 */
export function claimKeyOf(s: {
  scryfallId?: string | null;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  anyBasic?: boolean;
}): string | undefined {
  if (s.anyBasic || !s.scryfallId || !s.condition || !s.finish || !s.lang) return undefined;
  return collectionKey({ scryfallId: s.scryfallId, condition: s.condition, finish: s.finish, lang: s.lang });
}

/** One line about to be filed. `label`/`sub` are for the prompt only. */
export interface FilingCopy {
  oracleId: string;
  scryfallId?: string;
  quantity: number;
  board: DeckBoard;
  anyBasic?: boolean;
  wants?: SlotWants;
  /** Card name, for the prompt. */
  label?: string;
  /** Set · condition · finish · language, for the prompt. */
  sub?: string;
}

/** Somewhere a copy is filed right now. */
export interface FilingSource {
  containerId: string;
  name: string;
  kind: ContainerKind;
  /** Copies of this exact card that container is holding. */
  quantity: number;
  /** Newest slot touch, so the stalest claim is the first to give the card up. */
  updatedAt: number;
}

/** A copy you're filing that is already filed somewhere else. */
export interface FilingClash {
  copy: FilingCopy;
  elsewhere: FilingSource[];
}

export type FilingMode = 'move' | 'copy';

/**
 * Which of these copies are already filed outside the target — the question the
 * prompt asks. Only copies that name a real card of yours can clash; a brew line
 * with no edition or no traits is nobody's cardboard, so it's never in the way.
 */
export async function findFilingClashes(targetId: string, copies: FilingCopy[]): Promise<FilingClash[]> {
  const keyed: { copy: FilingCopy; key: string }[] = [];
  for (const copy of copies) {
    const key = claimKeyOf({ ...copy.wants, scryfallId: copy.scryfallId, anyBasic: copy.anyBasic });
    if (key) keyed.push({ copy, key });
  }
  if (keyed.length === 0) return [];

  const slots = (
    await db.deckCards
      .where('oracleId')
      .anyOf([...new Set(keyed.map((k) => k.copy.oracleId))])
      .toArray()
  ).filter((s) => s.deckId !== targetId && claimKeyOf(s));
  if (slots.length === 0) return [];

  const rows = await db.decks.bulkGet([...new Set(slots.map((s) => s.deckId))]);
  const containers = new Map(rows.filter((d) => !!d).map((d) => [d.id, d]));

  const clashes: FilingClash[] = [];
  for (const { copy, key } of keyed) {
    const held = new Map<string, { quantity: number; updatedAt: number }>();
    for (const s of slots) {
      if (s.oracleId !== copy.oracleId || claimKeyOf(s) !== key) continue;
      const cur = held.get(s.deckId);
      if (cur) {
        cur.quantity += s.quantity;
        cur.updatedAt = Math.max(cur.updatedAt, s.updatedAt);
      } else held.set(s.deckId, { quantity: s.quantity, updatedAt: s.updatedAt });
    }
    const elsewhere: FilingSource[] = [];
    held.forEach((v, containerId) => {
      const row = containers.get(containerId);
      // An orphan slot (a container delete that hasn't synced) holds nothing.
      if (row) elsewhere.push({ containerId, name: row.name, kind: containerKind(row), ...v });
    });
    // Oldest claim first: that's the one the card most likely already left.
    elsewhere.sort((a, b) => a.updatedAt - b.updatedAt);
    if (elsewhere.length > 0) clashes.push({ copy, elsewhere });
  }
  return clashes;
}

/**
 * File the copies. Slots are written with `exact`, so the same card in two
 * printings (or two finishes) stays two lines — a box holds pieces of cardboard,
 * not decklist entries.
 *
 * On 'move' the clashing copies come out of their old homes first, oldest claim
 * first, and only up to the number being filed: pull one Island out of a box of
 * four and the other three stay put.
 */
export async function applyFiling(
  targetId: string,
  copies: FilingCopy[],
  mode: FilingMode,
  clashes: FilingClash[] = [],
  meta: { source?: EventSource } = {},
): Promise<void> {
  if (mode === 'move') await unfileClashes(clashes);

  await addDeckCardsBulk(
    targetId,
    copies.map((c) => ({
      oracleId: c.oracleId,
      quantity: c.quantity,
      board: c.board,
      ...(c.scryfallId ? { scryfallId: c.scryfallId } : {}),
      ...(c.anyBasic ? { anyBasic: true } : {}),
      ...(c.wants ? { wants: c.wants } : {}),
    })),
    { exact: true, ...meta },
  );
}

/**
 * Take the clashing copies out of wherever they were, oldest claim first and
 * only up to the number being filed: pull one Island out of a box of four and
 * the other three stay put.
 *
 * Exported for the deck re-scan, which writes its slots through `reconcileDeck`
 * rather than by adding, and so has to settle the same question by hand.
 */
export async function unfileClashes(clashes: FilingClash[]): Promise<void> {
  if (clashes.length === 0) return;
  const bySource = new Map<string, { oracleId: string; scryfallId?: string; quantity: number; wants?: SlotWants }[]>();
  for (const clash of clashes) {
    let remaining = clash.copy.quantity;
    for (const place of clash.elsewhere) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, place.quantity);
      remaining -= take;
      const arr = bySource.get(place.containerId) ?? [];
      arr.push({
        oracleId: clash.copy.oracleId,
        ...(clash.copy.scryfallId ? { scryfallId: clash.copy.scryfallId } : {}),
        quantity: take,
        ...(clash.copy.wants ? { wants: clash.copy.wants } : {}),
      });
      bySource.set(place.containerId, arr);
    }
  }
  for (const [containerId, cards] of bySource) await removeDeckCardsMatching(containerId, cards);
}

/** A slot the assembler is about to point at a real card. */
export interface PinTarget {
  id: string;
  deckId: string;
  oracleId: string;
  board: DeckBoard;
  /** Copies the slot is asking for right now. */
  quantity: number;
}

/**
 * Point a slot that's already in the container at one of your copies — what
 * "assemble this deck from my collection" does, card by card.
 *
 * Filing *adds* cardboard to a container; pinning re-describes cardboard that's
 * already listed there, so it must never change the count. When the chosen copy
 * covers the whole slot the slot simply takes on its printing and traits. When
 * it covers only part of it (four Bolts wanted, two of that printing owned) the
 * slot splits: the pinned copies become their own line and the rest stays the
 * vague slot it was, ready for the next copy.
 */
export async function applyPinning(
  slot: PinTarget,
  copy: FilingCopy,
  mode: FilingMode,
  clashes: FilingClash[] = [],
): Promise<void> {
  if (mode === 'move') await unfileClashes(clashes);
  const take = Math.min(copy.quantity, slot.quantity);
  if (take >= slot.quantity) {
    await updateDeckCard(slot.id, {
      quantity: slot.quantity,
      scryfallId: copy.scryfallId ?? '',
      ...(copy.wants ? { wants: copy.wants } : {}),
    });
    return;
  }
  await setDeckCardQuantity(slot.id, slot.quantity - take);
  await addDeckCardsBulk(
    slot.deckId,
    [
      {
        oracleId: slot.oracleId,
        quantity: take,
        board: slot.board,
        ...(copy.scryfallId ? { scryfallId: copy.scryfallId } : {}),
        ...(copy.wants ? { wants: copy.wants } : {}),
      },
    ],
    { exact: true },
  );
}
