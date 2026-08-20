import type { Condition, Finish, SealedProduct } from '@mtg/shared';
import { applyImport, type ImportLine } from '../db/dataAccess.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import type { FilingCopy } from '../deck/filing.js';

// Cracking a sealed product open. Shared by the two places it can happen: the
// add sheet's "Open it, add the cards" outcome, and the shelf's "Open it" on a
// box you added unopened months ago. Both land the same cards, log the same
// batch, and end with the same "where do these live?" question.

/** A product's cards joined with the installed card DB, for display + add. */
export interface OpenRow {
  scryfallId: string;
  oracleId: string;
  name: string;
  set: string;
  collectorNumber: string;
  qty: number;
  finish: Finish;
}

export interface OpenContents {
  rows: OpenRow[];
  /** Cards in the product that aren't in the installed card DB (version skew). */
  missingLocally: number;
}

/** Join one product's decklist against the installed card DB. */
export async function loadContents(product: SealedProduct): Promise<OpenContents> {
  const printings = await getPrintingsByIds(product.cards.map((c) => c.scryfallId));
  const oracles = await getOracleCardsByIds([...printings.values()].map((pr) => pr.oracleId));
  const rows: OpenRow[] = [];
  let missingLocally = 0;
  for (const c of product.cards) {
    const pr = printings.get(c.scryfallId);
    if (!pr) {
      missingLocally += c.qty;
      continue;
    }
    rows.push({
      scryfallId: c.scryfallId,
      oracleId: pr.oracleId,
      name: oracles.get(pr.oracleId)?.name ?? '(unknown card)',
      set: pr.set,
      collectorNumber: pr.collectorNumber,
      qty: c.qty,
      finish: c.finish,
    });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rows, missingLocally };
}

/** Cards in one copy of the product that the installed card DB can place. */
export function perCopyCount(rows: OpenRow[]): number {
  return rows.reduce((s, r) => s + r.qty, 0);
}

/**
 * Put the contents of `copies` copies into the collection. Returns the card
 * count for the toast and the filing copies for the prompt that follows.
 */
export async function openIntoCollection(
  rows: OpenRow[],
  opts: { copies: number; condition: Condition; lang: string; label: string },
): Promise<{ cards: number; filing: FilingCopy[] }> {
  const lines: ImportLine[] = rows.map((r) => ({
    oracleId: r.oracleId,
    scryfallId: r.scryfallId,
    condition: opts.condition,
    finish: r.finish,
    lang: opts.lang,
    quantity: r.qty * opts.copies,
    quantityForTrade: 0,
  }));
  const { cards } = await applyImport(lines, { source: 'sealed', label: opts.label });
  const filing: FilingCopy[] = rows.map((r) => ({
    oracleId: r.oracleId,
    scryfallId: r.scryfallId,
    quantity: r.qty * opts.copies,
    board: 'main' as const,
    wants: { condition: opts.condition, finish: r.finish, lang: opts.lang },
    label: r.name,
    sub: `${r.set.toUpperCase()} #${r.collectorNumber}`,
  }));
  return { cards, filing };
}
