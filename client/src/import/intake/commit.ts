import type { EventSource } from '@mtg/shared';
import { applyImport, markOwnedForTrade, newId, reconcileDeck } from '../../db/dataAccess.js';
import {
  applyFiling,
  capToOwnedCopies,
  claimKeyOf,
  findFilingClashes,
  unfileClashes,
  type FilingClash,
  type FilingMode,
} from '../../deck/filing.js';
import { getPrefs } from '../../prefs.js';
import { filingCopies, importLines, plansOf, tradeRequests, type IntakeState } from './model.js';

// The one write at the end of the questionnaire. Everything the answers imply
// lands under a single batch id: trade flags, the collection rows (with the
// swaps carrying their filing along), then the container. One history entry,
// one undo.

export interface IntakeResult {
  /** Copies added to the collection. */
  added: number;
  /** Copies you already owned that were flagged for trade instead. */
  flagged: number;
  entries: number;
  /** Lines that did nothing at all. */
  skipped: number;
  /** Copies of real cardboard filed into the target (after the cap). */
  filed: number;
  /** Lines put on a container's list without naming a copy of yours. */
  listed: number;
  mode: FilingMode | null;
  /** Where they went, if anywhere. */
  target: { id: string; name: string } | null;
}

/** What the move step settled: the answer, and which copies it was asked about. */
export interface FilingAnswer {
  mode: FilingMode;
  /** Claim keys of the clashes the user saw. Anything else that turns up at
   *  commit time was never asked about, so it's filed as 'copy' (a flag, never
   *  a card pulled out of a deck unasked). */
  askedKeys: Set<string>;
}

export const clashKey = (c: FilingClash): string =>
  claimKeyOf({ ...c.copy.wants, scryfallId: c.copy.scryfallId, anyBasic: c.copy.anyBasic }) ?? '';

/** The mode a policy other than 'ask' settles on without asking. */
export const policyMode = (): FilingMode => (getPrefs().filingPolicy === 'move' ? 'move' : 'copy');

export async function commitIntake(
  st: IntakeState,
  meta: { source: Extract<EventSource, 'import' | 'scan' | 'sealed'>; label?: string },
  answer: FilingAnswer | null,
): Promise<IntakeResult> {
  const batchId = newId();
  const shared = { source: meta.source, batchId, ...(meta.label ? { batchLabel: meta.label } : {}) };

  const plans = plansOf(st);
  const flagged = await markOwnedForTrade(tradeRequests(st), shared);

  const lines = importLines(st);
  const removals = plans.flatMap(({ plan }) => plan.removals);
  const res =
    lines.length > 0 || removals.length > 0
      ? await applyImport(lines, { ...shared, ...(meta.label ? { label: meta.label } : {}), removals })
      : { cards: 0, entries: 0 };

  let filed = 0;
  let listed = 0;
  let mode: FilingMode | null = null;
  if (st.target) {
    const copies = filingCopies(st);
    listed = copies.filter((c) => !c.wants).reduce((n, c) => n + c.quantity, 0);
    // The answer covers the clashes the user was shown; the rest were never a
    // question, so they stay put. A policy that never asks applies to all.
    const settle = (clashes: FilingClash[]): { mode: FilingMode; unfile: FilingClash[] } => {
      const m = answer?.mode ?? (getPrefs().filingPolicy === 'ask' ? 'copy' : policyMode());
      if (m !== 'move') return { mode: m, unfile: [] };
      return { mode: m, unfile: answer ? clashes.filter((c) => answer.askedKeys.has(clashKey(c))) : clashes };
    };

    if (st.flow === 'rescan') {
      // "This is what's in the deck now": the container's slots are replaced,
      // so what it holds today isn't counted against the collection.
      const clashes = await findFilingClashes(st.target.id, copies, { replacing: true });
      const s = settle(clashes);
      mode = s.mode;
      await unfileClashes(s.unfile, shared);
      await reconcileDeck(
        st.target.id,
        copies.map((c) => ({
          oracleId: c.oracleId,
          board: c.board,
          quantity: c.quantity,
          ...(c.scryfallId ? { scryfallId: c.scryfallId } : {}),
          ...(c.wants ? { wants: c.wants } : {}),
        })),
        shared,
      );
      filed = copies.filter((c) => c.wants).reduce((n, c) => n + c.quantity, 0);
    } else {
      // Real data now: the collection write above is in, so the cap and the
      // clash check see exactly the cardboard that exists.
      const going = await capToOwnedCopies(st.target.id, copies);
      if (going.length > 0) {
        const clashes = await findFilingClashes(st.target.id, going);
        const s = settle(clashes);
        mode = s.mode;
        await applyFiling(st.target.id, going, s.mode, s.unfile, shared);
      }
      filed = going.filter((c) => c.wants).reduce((n, c) => n + c.quantity, 0);
    }
  }

  return {
    added: res.cards,
    flagged,
    entries: res.entries,
    skipped: plans.filter(({ plan }) => plan.skipped).length,
    filed,
    listed,
    mode,
    target: st.target ? { id: st.target.id, name: st.target.name } : null,
  };
}
