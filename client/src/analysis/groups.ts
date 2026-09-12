import type { DeckBoard, Finish, OracleCard } from '@mtg/shared';
import { compileCardQuery, rowPrintingSummary, toSearchableEntry, type RowPrinting } from '../cardDb/querySyntax.js';

// A "card group" is a search query run against one deck. That is the whole
// design: the app already has a Scryfall-style query language with four
// thousand oracle tags behind it, so `otag:removal`, `type:land` and `cmc<=2`
// are groups for free, and the group picker is a text field.
//
// Groups count *copies in the library*, because that is what you draw from.
// The command zone is not the library — a commander is always available and
// never drawn, so counting it would overstate every number here. It is reported
// separately instead, so a query that matches your commander can say so.

export interface GroupRow {
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
  /** The printing this slot pins, so `set:` and `is:foil` mean this copy. */
  printing?: RowPrinting;
  finish?: Finish;
}

export interface ResolvedGroup {
  /** Copies in the library that match. */
  copies: number;
  /** Distinct cards behind those copies, by name, for the "which ones?" line. */
  names: string[];
  /** Copies in the command zone that match — always available, never drawn. */
  inCommandZone: number;
  /** Library copies whose card isn't in the local DB, so nothing could be asked of them. */
  unknown: number;
}

/** Tokens and markers sit in the deck row but never in the library. */
const isNotACard = (o: OracleCard) => {
  const t = o.typeLine.toLowerCase();
  return t.startsWith('token') || t.includes('emblem') || t === 'card';
};

const inLibrary = (r: GroupRow) => r.board === 'main' && r.quantity > 0 && !(r.oracle && isNotACard(r.oracle));

/** Cards you shuffle up: the mainboard, and nothing else. */
export function librarySize(rows: readonly GroupRow[]): number {
  let n = 0;
  for (const r of rows) if (inLibrary(r)) n += r.quantity;
  return n;
}

/**
 * Resolve a query to the copies of it in the deck. An empty query matches
 * nothing rather than everything — "the odds of drawing any card by turn 3" is
 * not a question, and a blank field should read as unfilled, not as 100%.
 */
export function resolveGroup(rows: readonly GroupRow[], query: string): ResolvedGroup {
  const q = compileCardQuery(query);
  if (q.isEmpty) return { copies: 0, names: [], inCommandZone: 0, unknown: 0 };

  let copies = 0;
  let inCommandZone = 0;
  let unknown = 0;
  const names = new Set<string>();
  for (const r of rows) {
    if (r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (!r.oracle) {
      if (r.board === 'main') unknown += r.quantity;
      continue;
    }
    if (isNotACard(r.oracle)) continue;
    if (!q.matches(toSearchableEntry(r.oracle, rowPrintingSummary(r.printing, r.finish)))) continue;
    if (r.board === 'commander') {
      inCommandZone += r.quantity;
      continue;
    }
    copies += r.quantity;
    names.add(r.oracle.name);
  }
  return { copies, names: [...names].sort((a, b) => a.localeCompare(b)), inCommandZone, unknown };
}
