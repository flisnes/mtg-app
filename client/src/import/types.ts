import type { Condition, DeckBoard, Finish } from '@mtg/shared';
import type { PrintingPrefs } from '../cardDb/preferredPrinting.js';

// Import pipeline types (beta plan §5). Text/CSV → ParsedLine → resolved
// against the card DB → applied to the collection, with unmatched lines sent
// to a review screen instead of failing the whole import.

export type ImportFormat = 'text' | 'moxfield' | 'archidekt' | 'csv';

export interface ParsedLine {
  raw: string;
  quantity: number;
  quantityForTrade?: number;
  name: string;
  setCode?: string;
  collectorNumber?: string;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  /** Some exports (Archidekt) carry the Scryfall id directly. */
  scryfallId?: string;
  /** Which board a deck-list line belongs to. Ignored by collection import. */
  board?: DeckBoard;
}

export interface ResolvedLine {
  oracleId: string;
  scryfallId: string;
  name: string;
  quantity: number;
  quantityForTrade: number;
  condition: Condition;
  finish: Finish;
  lang: string;
  /** Set for deck imports so the slot lands on the right board. */
  board?: DeckBoard;
  /**
   * The list named this edition itself (a Scryfall id, or a set code) instead of
   * falling through to the printing preference. The wishlist wishes for a
   * printing only when it was actually asked for one.
   */
  pinnedPrinting?: boolean;
}

/**
 * What a line takes when it doesn't say for itself — the scanner's pile pins,
 * for a pasted list. Set on the import screen before analyzing; a CSV's own
 * condition/finish/language columns still win, line by line.
 */
export interface ImportDefaults {
  condition: Condition;
  finish: Finish;
  lang: string;
}

export interface UnmatchedLine {
  raw: string;
  name: string;
  quantity: number;
  finish?: Finish;
  suggestions: string[];
  /** Carried so a hand-fixed line keeps its deck board. */
  board?: DeckBoard;
}

export interface ResolveResult {
  format: ImportFormat;
  resolved: ResolvedLine[];
  unmatched: UnmatchedLine[];
  /** Total quantity across resolved lines. */
  resolvedQuantity: number;
}

/**
 * What to do about the tradelist when importing:
 *  - 'none' (default): nothing gets marked for trade, even if the file has
 *    tradelist counts (Moxfield exports often mark everything tradable).
 *  - 'file': honor the file's tradelist counts (e.g. Moxfield "Tradelist Count").
 *  - 'all': mark every imported copy for trade.
 */
export type TradelistMode = 'none' | 'file' | 'all';

// Worker messages
export interface ResolveRequest {
  text: string;
  tradelistMode?: TradelistMode;
  /** Condition/finish/language for lines that don't state their own. */
  defaults?: ImportDefaults;
  /**
   * The printing preferences, snapshotted by the caller. Workers can't read
   * localStorage, so a line that names no set gets the user's preferred printing
   * only because it's passed in here.
   */
  printingPrefs?: PrintingPrefs;
}

export type ResolveResponse =
  | { type: 'progress'; label: string; fraction: number }
  | { type: 'done'; result: ResolveResult }
  | { type: 'error'; message: string };
