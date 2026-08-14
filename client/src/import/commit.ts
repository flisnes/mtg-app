import type { EventSource } from '@mtg/shared';
import { applyImport, markOwnedForTrade } from '../db/dataAccess.js';
import { FINISH_LABELS } from '../components/CardSheet.js';
import type { FilingCopy } from '../deck/filing.js';
import type { ConflictChoice } from './conflicts.js';
import type { ReplaceOutcome } from './useReplaceFlow.js';
import type { ResolvedLine } from './types.js';

// The single write for anything that lands in the collection: a pasted list, a
// CSV, a scan of a shoebox, a tradelist import. Every caller used to roll its
// own version of "honor the per-card choices, then write", which is how the
// scanner ended up with a Trade option the importer didn't have and the
// importer ended up with a Replace that deleted more than the scanner's did.

export interface CommitResult {
  /** Copies added to the collection. */
  added: number;
  /** Copies of cards you already owned that were flagged for trade instead. */
  flagged: number;
  entries: number;
  /** The lines that actually landed — what a follow-up "where do these live?" files. */
  written: ResolvedLine[];
}

/**
 * Apply resolved lines with the duplicate screen's per-card choices:
 *
 *  - 'skip'    — changes nothing.
 *  - 'trade'   — flags copies you already own for trade, adds nothing.
 *  - 'add'     — stacks the incoming copies on top (merging into an identical entry).
 *  - 'replace' — swaps the copies named in `outcome.removals` for the incoming
 *                printing, leaving your count for that card unchanged.
 */
export async function commitResolvedLines(
  lines: ResolvedLine[],
  choices: Map<string, ConflictChoice>,
  outcome: ReplaceOutcome | null,
  meta: { source: Extract<EventSource, 'import' | 'scan' | 'sealed'>; label?: string },
): Promise<CommitResult> {
  const noSource = outcome?.noSource ?? new Set<string>();
  const tradeReqs = lines.filter((l) => choices.get(l.oracleId) === 'trade');
  const written = lines.filter((l) => {
    const c = choices.get(l.oracleId);
    if (c === 'skip' || c === 'trade') return false;
    // An "Update" with nothing distinct to replace is a no-op, not an add.
    return !noSource.has(l.oracleId);
  });

  const flagged = tradeReqs.length
    ? await markOwnedForTrade(
        tradeReqs.map((l) => ({
          oracleId: l.oracleId,
          scryfallId: l.scryfallId,
          condition: l.condition,
          finish: l.finish,
          lang: l.lang,
          quantity: l.quantity,
        })),
        { source: meta.source },
      )
    : 0;

  const res = written.length
    ? await applyImport(written, {
        source: meta.source,
        ...(meta.label ? { label: meta.label } : {}),
        removals: outcome?.removals ?? [],
      })
    : { cards: 0, entries: 0 };

  return { added: res.cards, flagged, entries: res.entries, written };
}

/**
 * Lines that just landed, as filing-engine copies — what the follow-up "where do
 * these live?" step files. Each names a printing, condition, finish and language,
 * so it claims the exact piece of cardboard it came from.
 */
export function filingCopiesFor(lines: ResolvedLine[]): FilingCopy[] {
  return lines.map((l) => ({
    oracleId: l.oracleId,
    scryfallId: l.scryfallId,
    quantity: l.quantity,
    board: 'main' as const,
    wants: { condition: l.condition, finish: l.finish, lang: l.lang },
    label: l.name,
    sub: [l.condition, FINISH_LABELS[l.finish], l.lang !== 'en' ? l.lang : null].filter(Boolean).join(' · '),
  }));
}
