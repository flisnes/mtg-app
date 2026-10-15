import { sanitizeContainerEmblem } from '@mtg/shared';
import type { ContainerEmblem, ContainerKind, Deck, DeckFolder, DeckFormat } from '@mtg/shared';
import { db } from './schema.js';
import { boardForFormat } from '../deck/boards.js';
import { slotEvent } from './events.js';
import { filedCopy, newId } from './keys.js';
import { moveSlotRaw, setSlotsUnfiled } from './slotWrites.js';
import { DECK_FOLDER_TABLES, DECK_TABLES, deleteSynced, deleteSyncedMany, patchSynced, putSynced, write } from './write.js';
import type { WriteCtx } from './write.js';

// ---------------------------------------------------------------------------
// Decks (beta plan §4). Deck slots reference oracle cards ("4x Lightning Bolt");
// legality checking lives in deck/legality.ts.
//
// Binders and boxes are the same rows with `kind` set: storage instead of a
// brewed list. Every function below works on all three — a binder just never
// gets a format, a sideboard or a commander — so there is one code path for
// adds, scans, imports, re-scans and deletion, not three.
// ---------------------------------------------------------------------------

/** Fallback name per kind when the user creates one without typing a name. */
const UNTITLED: Record<ContainerKind, string> = {
  deck: 'Untitled deck',
  binder: 'Untitled binder',
  box: 'Untitled box',
};

/** Create a deck, binder or box. Only decks carry a format or a folder. */
export async function createContainer(
  name: string,
  kind: ContainerKind = 'deck',
  format: DeckFormat = 'casual',
  folderId?: string,
): Promise<string> {
  const now = Date.now();
  const deck: Deck = {
    id: newId(),
    name: name.trim() || UNTITLED[kind],
    kind,
    ...(kind === 'deck' ? { format, ...(folderId ? { folderId } : {}) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', [db.decks, db.outbox], async () => {
    await putSynced('decks', deck);
  });
  return deck.id;
}

export async function renameDeck(id: string, name: string): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', id, (deck) => {
      deck.name = name.trim() || UNTITLED[deck.kind ?? 'deck'];
    }),
  );
}

export async function setDeckFormat(id: string, format: DeckFormat): Promise<void> {
  await write([...DECK_TABLES, db.oracleCards], async (ctx) => {
    const deck = await ctx.touchDeck(id);
    if (!deck) return;
    deck.format = format;
    await tidyBoardsRaw(ctx, id, format === 'commander');
  });
}

/**
 * Put every slot in a zone its deck's format has (see boardForFormat): a
 * Commander deck's sideboard goes to its Companion zone and Considering, and
 * a companion leaving Commander goes back to the sideboard. No history: this
 * is the app keeping its own shape, not something you did.
 */
async function tidyBoardsRaw(ctx: WriteCtx, deckId: string, commanderDeck: boolean): Promise<number> {
  const slots = await db.deckCards.where('deckId').equals(deckId).toArray();
  const strays = slots.filter((s) => s.board === (commanderDeck ? 'side' : 'companion'));
  if (strays.length === 0) return 0;
  const oracles = await db.oracleCards.bulkGet(strays.map((s) => s.oracleId));
  let taken = slots.some((s) => s.board === 'companion');
  let moved = 0;
  for (const [i, s] of strays.entries()) {
    const board = boardForFormat(s.board, oracles[i], commanderDeck, taken);
    if (!board) continue;
    if (board === 'companion') taken = true;
    // An MTGA list names its companion twice, once up top and once in the
    // sideboard. Folding the two would make it a playset of two.
    if (board === 'side' && slots.some((o) => o.board === 'side' && o.oracleId === s.oracleId)) {
      await deleteSynced('deckCards', s.id);
      continue;
    }
    moved += await moveSlotRaw(ctx, s.id, board, null);
  }
  return moved;
}

/** Tidy a deck's zones for its format (the deck page runs this on open, which
 *  catches decks from before the Companion zone and edits from older builds). */
export async function tidyDeckBoards(deckId: string): Promise<number> {
  let moved = 0;
  await write([...DECK_TABLES, db.oracleCards], async (ctx) => {
    const deck = await ctx.getDeck(deckId);
    if (!deck || (deck.kind ?? 'deck') !== 'deck') return;
    moved = await tidyBoardsRaw(ctx, deckId, (deck.format ?? 'casual') === 'commander');
  });
  return moved;
}

/**
 * Set (or clear, with undefined) the picture or symbol this container wears in
 * the list. Sanitized on the way in like a row off the wire — the picker is the
 * only caller today, but the emblem ends up in a CSS class name.
 */
export async function setDeckEmblem(id: string, emblem: ContainerEmblem | undefined): Promise<void> {
  const clean = emblem && sanitizeContainerEmblem(emblem);
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', id, (deck) => {
      if (clean) deck.emblem = clean;
      else delete deck.emblem;
    }),
  );
}

export async function deleteDeck(id: string): Promise<void> {
  await write(DECK_TABLES, async (ctx) => {
    const deck = await ctx.getDeck(id);
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    for (const c of cards) ctx.emit(slotEvent('deck.remove', c, c.quantity, ctx.now, deck));
    await deleteSyncedMany('deckCards', cards.map((c) => c.id));
    // Authored behavior belongs to the deck, so it goes with it. Tombstoned one
    // by one rather than dropped locally: a row nobody deletes on the server is
    // a row that comes back on the next pull.
    const behaviors = await db.deckBehaviors.where('deckId').equals(id).toArray();
    await deleteSyncedMany('deckBehaviors', behaviors.map((b) => b.id));
    await deleteSynced('decks', id);
    // Deleting the container unfiles everything that was in it.
    ctx.touchCopies(cards);
  });
}

// ---------------------------------------------------------------------------
// Deck folders. A flat grouping of decks (deck-only — binders/boxes don't use
// these), synced as their own table like decks themselves.
// ---------------------------------------------------------------------------

const UNTITLED_FOLDER = 'Untitled folder';

export async function createDeckFolder(name: string): Promise<string> {
  const now = Date.now();
  const folder: DeckFolder = { id: newId(), name: name.trim() || UNTITLED_FOLDER, createdAt: now, updatedAt: now };
  await db.transaction('rw', [db.deckFolders, db.outbox], async () => {
    await putSynced('deckFolders', folder);
  });
  return folder.id;
}

export async function renameDeckFolder(id: string, name: string): Promise<void> {
  await db.transaction('rw', [db.deckFolders, db.outbox], () =>
    patchSynced('deckFolders', id, (folder) => {
      folder.name = name.trim() || UNTITLED_FOLDER;
    }),
  );
}

/** Delete a folder; the decks inside it become unorganized, not deleted. */
export async function deleteDeckFolder(id: string): Promise<void> {
  await db.transaction('rw', DECK_FOLDER_TABLES, async () => {
    const now = Date.now();
    const members = await db.decks.where('folderId').equals(id).toArray();
    for (const deck of members) {
      delete deck.folderId;
      deck.updatedAt = now;
      await putSynced('decks', deck);
    }
    await deleteSynced('deckFolders', id);
  });
}

/** Move a deck into a folder, or out of any folder when folderId is undefined. */
export async function setDeckFolder(deckId: string, folderId: string | undefined): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', deckId, (deck) => {
      if (folderId) deck.folderId = folderId;
      else delete deck.folderId;
    }),
  );
}

/**
 * Archive a deck, or bring it back. Nothing is deleted: the list, the slots and
 * the history all stay exactly as they were, the deck just moves out of the deck
 * list into the Archived folder. It keeps its `folderId` too, so restoring it
 * drops it back into the folder it came from.
 *
 * Taking the cardboard out is a separate question the caller asks (see
 * `unfileWholeContainer`) — a deck you archived because the season ended is
 * still assembled in its box.
 */
export async function setDeckArchived(deckId: string, archived: boolean): Promise<void> {
  await db.transaction('rw', [db.decks, db.outbox], () =>
    patchSynced('decks', deckId, (deck) => {
      if (!!deck.archivedAt === archived) return false;
      if (archived) deck.archivedAt = Date.now();
      else delete deck.archivedAt;
    }),
  );
}

/**
 * Take every card out of a container in one go, leaving the list untouched —
 * disassembling a deck without losing what was in it. The multi-select "Unfile…"
 * with nothing left unselected; see setDeckCardsUnfiled for what a slot keeps.
 *
 * Returns the copies freed.
 */
export async function unfileWholeContainer(deckId: string): Promise<number> {
  return write(DECK_TABLES, async (ctx) =>
    setSlotsUnfiled(ctx, await db.deckCards.where('deckId').equals(deckId).toArray(), true),
  );
}

/** Copies a container is holding right now — what unfiling it would free. */
export async function countFiledCopies(deckId: string): Promise<number> {
  const slots = await db.deckCards.where('deckId').equals(deckId).toArray();
  return slots.reduce((n, s) => n + (filedCopy(s) ? s.quantity : 0), 0);
}
