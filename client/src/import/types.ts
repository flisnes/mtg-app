import type { Condition, Finish } from '@mtg/shared';

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
}

export interface UnmatchedLine {
  raw: string;
  name: string;
  quantity: number;
  finish?: Finish;
  suggestions: string[];
}

export interface ResolveResult {
  format: ImportFormat;
  resolved: ResolvedLine[];
  unmatched: UnmatchedLine[];
  /** Total quantity across resolved lines. */
  resolvedQuantity: number;
}

// Worker messages
export interface ResolveRequest {
  text: string;
  /** Import into the collection as tradelist copies too (adds quantityForTrade). */
  asTradelist?: boolean;
}

export type ResolveResponse =
  | { type: 'progress'; label: string; fraction: number }
  | { type: 'done'; result: ResolveResult }
  | { type: 'error'; message: string };
