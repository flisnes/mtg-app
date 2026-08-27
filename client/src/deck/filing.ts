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
// in one place at a time. The rule is about *copies*, not card names: own four
// Islands and four containers can each hold one without anybody having to give
// one up. So a filing only clashes when the containers would between them
// promise more cardboard than you own — the same `claimed > owned` test the
// filing-conflict flag uses (see db/usePlacements.ts).
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
 *
 * An unfiled slot names its copy as precisely as ever but has been emptied out by
 * hand (see DeckCard.unfiled): the list still wants the card, the container isn't
 * holding it. So it claims nothing either.
 */
export function claimKeyOf(s: {
  scryfallId?: string | null;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  anyBasic?: boolean;
  unfiled?: boolean;
}): string | undefined {
  if (s.anyBasic || s.unfiled || !s.scryfallId || !s.condition || !s.finish || !s.lang) return undefined;
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

/**
 * A copy you're filing that other containers have already promised away, with
 * `copy.quantity` narrowed to the number that is actually over-promised: file
 * two of your four Islands into a box while one sits in a deck and nothing
 * clashes, so no clash is reported at all.
 */
export interface FilingClash {
  copy: FilingCopy;
  elsewhere: FilingSource[];
}

export type FilingMode = 'move' | 'copy';

/**
 * Which of these copies the other containers have already promised away — the
 * question the prompt asks. Only copies that name a real card of yours can
 * clash; a brew line with no edition or no traits is nobody's cardboard, so it's
 * never in the way.
 *
 * Counting matters. What clashes isn't "this card is filed elsewhere" but "the
 * containers would hold more of this copy than exist": the target's own slots,
 * plus what's being filed now, plus what everyone else holds, against the number
 * in your collection. That's why cracking a box open no longer asks about the
 * copies you already had filed — the new cardboard came with the box, so there
 * is enough to go round.
 *
 * Copies sharing one physical identity are pooled, so filing the same card into
 * a deck's main and sideboard weighs on the collection once, not twice.
 *
 * `replacing` is for the deck re-scan, whose write is "this is what's in the deck
 * now" rather than "add these": what the target holds today is on its way out, so
 * it mustn't be counted against the collection alongside the copies replacing it.
 */
export async function findFilingClashes(
  targetId: string,
  copies: FilingCopy[],
  opts: { replacing?: boolean } = {},
): Promise<FilingClash[]> {
  // Pool by the copy they name, keeping the first line's card details for the
  // prompt: the removal below spends one shared pile of cardboard.
  const pooled = new Map<string, FilingCopy>();
  for (const copy of copies) {
    const key = claimKeyOf({ ...copy.wants, scryfallId: copy.scryfallId, anyBasic: copy.anyBasic });
    if (!key) continue;
    const cur = pooled.get(key);
    if (cur) cur.quantity += copy.quantity;
    else pooled.set(key, { ...copy });
  }
  if (pooled.size === 0) return [];

  const oracleIds = [...new Set([...pooled.values()].map((c) => c.oracleId))];
  const [allSlots, entries] = await Promise.all([
    db.deckCards.where('oracleId').anyOf(oracleIds).toArray(),
    db.collection.where('oracleId').anyOf(oracleIds).toArray(),
  ]);
  const slots = allSlots.filter((s) => claimKeyOf(s));
  if (slots.length === 0) return [];

  const owned = new Map<string, number>();
  for (const e of entries) {
    const k = collectionKey(e);
    owned.set(k, (owned.get(k) ?? 0) + e.quantity);
  }

  const rows = await db.decks.bulkGet([...new Set(slots.map((s) => s.deckId))]);
  const containers = new Map(rows.filter((d) => !!d).map((d) => [d.id, d]));

  const clashes: FilingClash[] = [];
  for (const [key, copy] of pooled) {
    // What the target already holds counts against you too: filing a third copy
    // into a box that has two of your two is an over-promise on its own.
    let held = 0;
    const elsewhereBy = new Map<string, { quantity: number; updatedAt: number }>();
    for (const s of slots) {
      if (s.oracleId !== copy.oracleId || claimKeyOf(s) !== key) continue;
      if (s.deckId === targetId) {
        if (!opts.replacing) held += s.quantity;
        continue;
      }
      // An orphan slot (a container delete that hasn't synced) holds nothing.
      if (!containers.has(s.deckId)) continue;
      const cur = elsewhereBy.get(s.deckId);
      if (cur) {
        cur.quantity += s.quantity;
        cur.updatedAt = Math.max(cur.updatedAt, s.updatedAt);
      } else elsewhereBy.set(s.deckId, { quantity: s.quantity, updatedAt: s.updatedAt });
    }

    const elsewhere: FilingSource[] = [];
    let promised = 0;
    elsewhereBy.forEach((v, containerId) => {
      const row = containers.get(containerId)!;
      elsewhere.push({ containerId, name: row.name, kind: containerKind(row), ...v });
      promised += v.quantity;
    });
    if (promised === 0) continue;

    // Only the copies that don't exist are in the way, and moving can free at
    // most what the other containers are holding.
    const over = Math.min(held + copy.quantity + promised - (owned.get(key) ?? 0), promised);
    if (over <= 0) continue;

    // Oldest claim first: that's the one the card most likely already left.
    elsewhere.sort((a, b) => a.updatedAt - b.updatedAt);
    clashes.push({ copy: { ...copy, quantity: over }, elsewhere });
  }
  return clashes;
}

/**
 * File the copies. Slots are written with `exact`, so the same card in two
 * printings (or two finishes) stays two lines — a box holds pieces of cardboard,
 * not decklist entries.
 *
 * On 'move' the over-promised copies come out of their old homes first, oldest
 * claim first, and only as many as the collection is short: pull one Island out
 * of a box of four and the other three stay put.
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
 * Take the over-promised copies out of wherever they were, oldest claim first
 * and only as many as `findFilingClashes` counted short: pull one Island out of
 * a box of four and the other three stay put.
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
