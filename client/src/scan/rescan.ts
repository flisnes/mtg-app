import type { DeckBoard, DeckCard } from '@mtg/shared';
import type { SlotWants } from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { sessionKey, type SessionEntry } from './session.js';

/** A deck re-scan target slot: one physical copy (printing + traits + board), as filed. */
export interface RescanSlot {
  oracleId: string;
  board: DeckBoard;
  quantity: number;
  scryfallId?: string;
  wants: SlotWants;
  name: string;
  image?: string;
}

/** One line of the re-scan diff shown before the deck is reconciled. */
export type DeckChange =
  | { kind: 'add'; oracleId: string; board: DeckBoard; name: string; image?: string; quantity: number }
  | { kind: 'remove'; oracleId: string; board: DeckBoard; name: string; image?: string; quantity: number }
  | { kind: 'change'; oracleId: string; board: DeckBoard; name: string; image?: string; from: number; to: number };

/** Everything a deck re-scan needs to review before committing. */
export interface RescanReview {
  /** The deck's desired final slots (what reconcileDeck receives). */
  slots: RescanSlot[];
  /** Human-readable diff vs the deck's current contents (unchanged slots omitted). */
  changes: DeckChange[];
  /** The write would file copies the deck isn't holding, even where the diff is
   *  empty: same cards, but listed rather than filed, or a different printing. */
  refiles: boolean;
}

/** A decklist line: one card on one board, whatever printing it is. */
const cardKey = (c: { oracleId: string; board: DeckBoard }) => `${c.oracleId}|${c.board}`;

/**
 * Deck re-scan: collapse the session to deck slots (one per physical copy and
 * board) and diff it against the deck's current contents for the preview.
 */
export async function buildRescanReview(session: SessionEntry[], deckId: string): Promise<RescanReview> {
  // What gets written: one slot per physical copy, exactly as filing writes
  // them, so the deck holds the cardboard the camera saw.
  const slotMap = new Map<string, RescanSlot>();
  for (const e of session) {
    const cur = slotMap.get(sessionKey(e));
    if (cur) cur.quantity += e.qty;
    else
      slotMap.set(sessionKey(e), {
        oracleId: e.oracleId,
        board: e.board,
        quantity: e.qty,
        scryfallId: e.scryfallId,
        wants: { condition: e.condition, finish: e.finish, lang: e.lang },
        name: e.name,
        image: e.image,
      });
  }
  // "Any printing" basics are invisible to a scan — reconcileDeck leaves them
  // alone, so the preview mustn't offer to sweep them away either.
  const current = (await db.deckCards.where('deckId').equals(deckId).toArray()).filter((c) => !c.anyBasic);
  const oracleMap = await getOracleCardsByIds(current.map((c) => c.oracleId));

  // What the user reads: the diff per card and board, which is how a deck
  // lists itself. Swapping a Sol Ring for another printing of the same Sol
  // Ring is no change to a decklist, so it stays off this list.
  const scanned = new Map<string, { slot: RescanSlot; quantity: number }>();
  for (const s of slotMap.values()) {
    const cur = scanned.get(cardKey(s));
    if (cur) cur.quantity += s.quantity;
    else scanned.set(cardKey(s), { slot: s, quantity: s.quantity });
  }
  const held = new Map<string, { card: DeckCard; quantity: number }>();
  for (const c of current) {
    const cur = held.get(cardKey(c));
    if (cur) cur.quantity += c.quantity;
    else held.set(cardKey(c), { card: c, quantity: c.quantity });
  }

  const changes: DeckChange[] = [];
  for (const [key, { slot: s, quantity }] of scanned) {
    const cur = held.get(key);
    if (!cur) changes.push({ kind: 'add', oracleId: s.oracleId, board: s.board, name: s.name, image: s.image, quantity });
    else if (cur.quantity !== quantity)
      changes.push({ kind: 'change', oracleId: s.oracleId, board: s.board, name: s.name, image: s.image, from: cur.quantity, to: quantity });
  }
  for (const [key, { card, quantity }] of held) {
    if (scanned.has(key)) continue;
    changes.push({ kind: 'remove', oracleId: card.oracleId, board: card.board, name: oracleMap.get(card.oracleId)?.name ?? 'Unknown card', quantity });
  }

  // A deck can list every card the scan saw and still be holding none of it:
  // pasted decklist lines name no copy, so nothing in them is filed. Then the
  // diff above is empty while the write is anything but, and the re-scan must
  // not bow out with "already matches your scan".
  const filed = new Map<string, number>();
  for (const c of current) {
    // An emptied-out slot (DeckCard.unfiled) holds nothing, so it can never
    // match a scanned copy.
    if (c.unfiled) continue;
    const key = sessionKey(c);
    filed.set(key, (filed.get(key) ?? 0) + c.quantity);
  }
  const refiles = filed.size !== slotMap.size || [...slotMap].some(([key, s]) => filed.get(key) !== s.quantity);

  return { slots: [...slotMap.values()], changes, refiles };
}
