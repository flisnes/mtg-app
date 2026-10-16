import type { Condition, ContainerKind, DeckBoard, DeckFormat, Finish } from '@mtg/shared';
import { FINISHES } from '@mtg/shared';
import { addToWishlistBulk } from '../db/dataAccess.js';
import { describeFiling, type IntakeResult } from '../import/intake/commit.js';
import type { IntakeConfig } from '../import/intake/useIntakeReview.js';
import type { ResolvedLine } from '../import/types.js';
import { LANGS } from '../components/copyTraits.js';
import { CONTAINER_META } from '../deck/containers.js';
import { readJson } from '../util/localStore.js';
import { plural } from '../util/format.js';
import { TRADE_SCAN_PREFIX } from './tradeSessions.js';

// The scan session: what the scanner (and the drop review) piles up before
// "Add N cards" writes it. Pure, so DropSheet can share it without pulling the
// camera module into its chunk.

/** A locked-in scan, ready to be written wherever the target sends it. */
export interface ScannedCard {
  oracleId: string;
  scryfallId: string;
  name: string;
  /** From the picker bar (deck slots store no finish, so they ignore it). */
  finish: Finish;
  /** From the picker bar. A trade offer prices by condition, so it carries. */
  condition: Condition;
  /** From the picker bar: what OCR read, or the pinned pile language. */
  lang: string;
  quantity: number;
}

/** Where a scan is committed (mirrors CardSheet's context-sensitive AddTarget). */
export type ScanTarget =
  | { kind: 'collection' }
  | { kind: 'tradelist' }
  | { kind: 'wishlist' }
  // A deck, binder or box (all the same stored row — `containerKind` only picks
  // the wording and, for storage, drops the board picker). `rescan` reconciles
  // it to exactly what was scanned (add/remove/change quantities) instead of
  // only adding — see the scanner's complete().
  | {
      kind: 'deck';
      deckId: string;
      deckName?: string;
      containerKind?: ContainerKind;
      format?: DeckFormat;
      rescan?: boolean;
    }
  // The whole session lands in one call: an offer is committed as a single
  // snapshot, so adding card-by-card would have each add overwrite the last.
  // `sessionKey` scopes the persisted scan to one trade + side, so a restored
  // scan can never land in somebody else's offer.
  | { kind: 'trade'; label?: string; sessionKey?: string; onAdd: (cards: ScannedCard[]) => void };

/** One line of the scan session — what "complete" will write. */
export interface SessionEntry {
  scryfallId: string;
  oracleId: string;
  name: string;
  set: string;
  collectorNumber: string;
  image?: string;
  finish: Finish;
  lang: string;
  /** From the tray's Condition picker (NM unless changed or locked). */
  condition: Condition;
  board: DeckBoard;
  qty: number;
}

/**
 * "I've prepared a pile" pins, set in the scan settings: every card added takes
 * that value and a new lock can't reset the picker out of it (OCR won't override
 * a pinned language either). `null` = pin off. The set pin holds a set code,
 * chosen from the editions of the card in frame — it used to arm itself from
 * whatever scanned next, which on a card with twenty reprints pinned the wrong
 * set more often than the right one.
 */
export interface ScanLocks {
  lang: string | null;
  finish: Finish | null;
  set: string | null;
}

const NO_LOCKS: ScanLocks = { lang: null, finish: null, set: null };

/** Locks survive a reload (a pile takes more than one sitting); every active one
 *  shows as a chip over the camera, so a stale pin can't apply unnoticed. */
export function loadLocks(): ScanLocks {
  const p = readJson('scan-locks') as Partial<Record<keyof ScanLocks, unknown>> | undefined;
  if (!p || typeof p !== 'object') return NO_LOCKS;
  return {
    lang: typeof p.lang === 'string' && LANGS.includes(p.lang) ? p.lang : null,
    finish: FINISHES.includes(p.finish as Finish) ? (p.finish as Finish) : null,
    // '' was the old "waiting for the next card" state; there is no such
    // thing now, and a blank pin would filter nothing while showing a chip.
    set: typeof p.set === 'string' && p.set ? p.set : null,
  };
}

/**
 * One physical copy: printing, finish, condition, language and board. Language
 * is part of it (collectionKey has it too): scanning a card in Japanese and
 * later the same card in English must stay two lines, not merge into whichever
 * one landed first. Loose on purpose so a filed deck slot, whose traits are
 * optional, keys the same way.
 */
export const sessionKey = (e: { scryfallId?: string; finish?: string; condition?: string; lang?: string; board: string }) =>
  `${e.scryfallId ?? ''}|${e.finish ?? ''}|${e.condition ?? ''}|${e.lang ?? ''}|${e.board}`;

/** Collapse duplicate (printing, finish, condition, language, board) lines after a row edit. */
export function mergeSession(entries: SessionEntry[]): SessionEntry[] {
  const map = new Map<string, SessionEntry>();
  for (const e of entries) {
    const prev = map.get(sessionKey(e));
    if (prev) prev.qty += e.qty;
    else map.set(sessionKey(e), { ...e });
  }
  return [...map.values()];
}

/** Copies per printing across finishes and boards (the tray tile's badge). */
export function countByPrinting(entries: SessionEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.scryfallId, (out.get(e.scryfallId) ?? 0) + e.qty);
  return out;
}

/**
 * A wish is for a printing, not a graded copy, so its finish/condition/language
 * are wishes too: `undefined` means "any". The picker defaults (nonfoil, NM,
 * English) are what you get when you haven't said anything, so they map back to
 * "any" — anything else is a stated preference and is stored.
 */
function wishPreference<T extends string>(value: T, dflt: T): T | undefined {
  return value === dflt ? undefined : value;
}

/** "deck" / "binder" / "box" for a container target; the target's own name otherwise. */
export function targetNoun(target: ScanTarget): string {
  if (target.kind === 'deck') return CONTAINER_META[target.containerKind ?? 'deck'].noun;
  return target.kind === 'trade' ? 'offer' : target.kind;
}

export function targetLabel(target: ScanTarget): string {
  switch (target.kind) {
    case 'collection':
      return 'Collection';
    case 'tradelist':
      return 'Tradelist';
    case 'wishlist':
      return 'Wishlist';
    case 'deck':
      return target.deckName ?? 'Deck';
    case 'trade':
      return target.label ?? 'Trade offer';
  }
}

// A scan session survives an accidental reload: it's mirrored to localStorage
// keyed by its destination and only cleared when the user commits or discards
// it. Every destination gets its own key — a re-scan is *not* the same session
// as an add (one reconciles the deck to exactly what was scanned, the other
// appends), and a trade scan belongs to one trade and one side of it.
// (The trade prefix and its cleanup live in scan/tradeSessions.ts so Trade.tsx
// can call them without pulling this module into its chunk.)

export function sessionStorageKey(target: ScanTarget): string | null {
  switch (target.kind) {
    case 'collection':
      return 'scan-session:collection';
    case 'tradelist':
      return 'scan-session:tradelist';
    case 'wishlist':
      return 'scan-session:wishlist';
    case 'deck':
      return `scan-session:${target.rescan ? 'rescan' : 'deck'}:${target.deckId}`;
    case 'trade':
      return target.sessionKey ? `${TRADE_SCAN_PREFIX}${target.sessionKey}` : null;
  }
}

export function loadStoredSession(key: string | null): SessionEntry[] {
  if (!key) return [];
  const parsed = readJson(key);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is SessionEntry =>
      !!e && typeof e.scryfallId === 'string' && typeof e.oracleId === 'string' && typeof e.qty === 'number',
  );
}

/** One session line as an import line (the collection write is the import write). */
export function entryLine(e: SessionEntry, target: ScanTarget): ResolvedLine {
  return {
    oracleId: e.oracleId,
    scryfallId: e.scryfallId,
    name: e.name,
    quantity: e.qty,
    // Marked for trade only when the destination is the tradelist.
    quantityForTrade: target.kind === 'tradelist' ? e.qty : 0,
    condition: e.condition,
    finish: e.finish,
    lang: e.lang,
    board: e.board,
  };
}

/**
 * Write a session to its destination: what "Add N cards" does in the scanner
 * and in the drop review alike (a deck re-scan reconciles instead, and stays in
 * the scanner). Resolves to the toast to show, or null when the user backed out
 * of the questionnaire and nothing was written.
 */
export async function commitSession(
  target: ScanTarget,
  session: SessionEntry[],
  review: (cfg: IntakeConfig) => Promise<IntakeResult | null>,
  incomingLabel: string,
): Promise<string | null> {
  const label = targetLabel(target);
  const total = session.reduce((n, e) => n + e.qty, 0);
  const lines = session.map((e) => entryLine(e, target));
  // A deck, binder or box: the pile is in your hands, so the questionnaire
  // asks which cards are yours and what the collection should make of them,
  // then writes the collection and the container together.
  if (target.kind === 'deck') {
    const res = await review({
      flow: 'container',
      lines,
      source: 'scan',
      incomingLabel,
      target: { id: target.deckId, name: label, kind: target.containerKind ?? 'deck' },
    });
    if (!res) return null;
    return `Added ${total} ${plural(total, 'card')} to ${label}${res.added ? ` · ${res.added} added to collection` : ''}`;
  }
  // Collection & tradelist route through the import pipeline: the batch
  // becomes one history entry, any card already owned gets its Skip / Add /
  // Update, and the pile is offered a home while you're holding it.
  if (target.kind === 'collection' || target.kind === 'tradelist') {
    const res = await review({ flow: target.kind, lines, source: 'scan', incomingLabel });
    if (!res) return null;
    const n = res.added + res.flagged;
    return n === 0 ? 'Nothing added: every card was skipped' : `Added ${n} ${plural(n, 'card')} to ${label}${describeFiling(res)}`;
  }
  if (target.kind === 'wishlist') {
    // A scanned card is a specific printing, so the wish is for that
    // edition — plus whatever the pickers were moved off their defaults to.
    await addToWishlistBulk(
      session.map((e) => ({
        oracleId: e.oracleId,
        scryfallId: e.scryfallId,
        quantity: e.qty,
        finish: wishPreference(e.finish, 'nonfoil'),
        condition: wishPreference(e.condition, 'NM'),
        lang: wishPreference(e.lang, 'en'),
      })),
      { source: 'scan' },
    );
  } else {
    target.onAdd(
      session.map((e) => ({
        oracleId: e.oracleId,
        scryfallId: e.scryfallId,
        name: e.name,
        finish: e.finish,
        // A trade values what's actually being handed over, and the picker bar
        // is right there through the whole scan — so a played copy no longer
        // enters the offer claiming to be Near Mint.
        condition: e.condition,
        lang: e.lang,
        quantity: e.qty,
      })),
    );
  }
  return `Added ${total} ${plural(total, 'card')} to ${label}`;
}
