import type { Condition, DeckBoard, Finish } from '@mtg/shared';
import { buildDeckText } from './deckText.js';

// A clipboard for cardboard.
//
// Copying cards writes two things at once. The plain text is a decklist, so a
// paste into Discord or a notepad reads "4 Lightning Bolt" like every other
// decklist on the internet. Alongside it goes the full slot: which printing,
// which finish, what condition it wants, what it's tagged. Pasting back into
// the app takes that and the cards arrive as they left, rather than degraded to
// names someone has to re-pick editions for.
//
// The structured half rides in a second clipboard format where the browser
// allows it, and in a module-level copy where it doesn't. The module copy is
// only trusted when the plain text still matches what we wrote: copy from the
// app, copy a decklist off a website, then paste, and you get the website's
// list. Without that check the app would paste its own stale cards over
// whatever you actually copied last.

/** The MIME type the structured half travels under, alongside text/plain. */
export const CLIPBOARD_MIME = 'application/x-mtg-cards+json';

/** One copied slot: the card, and everything the slot asked for. */
export interface ClipboardSlot {
  oracleId: string;
  /** Carried so the plain text can be written without a card-DB round trip. */
  name: string;
  quantity: number;
  board: DeckBoard;
  scryfallId?: string;
  anyBasic?: boolean;
  finish?: Finish;
  condition?: Condition;
  lang?: string;
  tags?: string[];
}

export interface ClipboardPayload {
  app: 'mtg-pwa';
  v: 1;
  slots: ClipboardSlot[];
  /**
   * Set by a cut: the slots are still sitting in their container, and pasting
   * is what actually moves them. A cut you never paste costs nothing, which is
   * the whole reason the removal waits.
   */
  cut?: { containerId: string; slotIds: string[] };
}

export function isPayload(v: unknown): v is ClipboardPayload {
  const p = v as ClipboardPayload | null;
  return !!p && p.app === 'mtg-pwa' && p.v === 1 && Array.isArray(p.slots);
}

const BOARD_ORDER: DeckBoard[] = ['commander', 'main', 'side', 'token'];

/** The decklist a paste into any other app should produce. */
export function payloadText(slots: readonly ClipboardSlot[]): string {
  const of = (board: DeckBoard) =>
    slots.filter((s) => s.board === board).map((s) => ({ name: s.name, quantity: s.quantity }));
  const [commander, main, side, token] = BOARD_ORDER.map(of);
  return buildDeckText(main!, side!, commander!, token!);
}

// ---------------------------------------------------------------------------
// The in-app copy, and who's listening for it
// ---------------------------------------------------------------------------

interface Held {
  payload: ClipboardPayload;
  /** The text written to the system clipboard at the same moment. */
  text: string;
}

let held: Held | null = null;
// Precomputed at hold time, not per read: useSyncExternalStore compares
// snapshots by identity, so handing back a freshly built Set every render would
// spin forever.
let cutMarks: { containerId: string; ids: ReadonlySet<string> } | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  listeners.forEach((fn) => fn());
}

export function subscribeClipboard(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function hold(payload: ClipboardPayload, text: string): void {
  held = { payload, text };
  cutMarks = payload.cut ? { containerId: payload.cut.containerId, ids: new Set(payload.cut.slotIds) } : null;
  announce();
}

/**
 * The structured payload, but only if the system clipboard still holds the text
 * we wrote with it. Anything else means the user copied something in between,
 * and theirs wins.
 */
export function heldFor(text: string): ClipboardPayload | null {
  if (!held) return null;
  return held.text.trim() === text.trim() ? held.payload : null;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The slots this container currently has marked as cut (empty for everyone else). */
export function cutSlotIds(containerId: string): ReadonlySet<string> {
  return cutMarks?.containerId === containerId ? cutMarks.ids : EMPTY;
}

/** Forget the cut marks once the move has happened (or been abandoned). The
 *  cards themselves stay on the clipboard, so a cut you changed your mind about
 *  can still be pasted as a copy. */
export function clearCut(): void {
  if (!held?.payload.cut) return;
  const { cut: _cut, ...rest } = held.payload;
  held = { ...held, payload: rest };
  cutMarks = null;
  announce();
}
