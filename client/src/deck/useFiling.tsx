import { useCallback, useState } from 'react';
import type { ContainerKind, EventSource } from '@mtg/shared';
import { FilingChoiceSheet } from '../components/FilingChoiceSheet.js';
import { db } from '../db/schema.js';
import { getPrefs } from '../prefs.js';
import { containerKind } from './containers.js';
import {
  applyFiling,
  applyPinning,
  capToOwnedCopies,
  findFilingClashes,
  type FilingClash,
  type FilingCopy,
  type FilingMode,
  type PinTarget,
} from './filing.js';

/** What a filing did: how it settled the question, and how many copies of real
 *  cardboard actually went in (0 = the target already held every copy you own,
 *  so there was nothing left to put away). */
export interface FilingResult {
  mode: FilingMode;
  filed: number;
}

/**
 * "File these cards there" for any screen that offers it, with the
 * already-filed-elsewhere question handled once and identically everywhere.
 *
 * Render `sheet` somewhere in the caller's tree and await `file(...)`: it settles
 * the policy (ask / move / file both), caps the filing at the cardboard that
 * exists, writes the slots, and resolves with what it did — or null if the user
 * backed out, so the caller knows not to toast or exit its selection. `pin(...)`
 * asks the same question for a slot already sitting in the container, which the
 * deck assembler points at a real card rather than adding a second line.
 */
export function useFiling() {
  const [pending, setPending] = useState<{
    clashes: FilingClash[];
    targetName: string;
    targetKind: ContainerKind;
    resolve: (mode: FilingMode | null) => void;
  } | null>(null);

  /** Settle move-or-both for these copies; null means the user backed out. */
  const decide = useCallback(
    async (
      targetId: string,
      copies: FilingCopy[],
      opts: { replacing?: boolean; cap?: boolean } = {},
    ): Promise<{ mode: FilingMode; clashes: FilingClash[]; copies: FilingCopy[] } | null> => {
      const policy = getPrefs().filingPolicy;
      // The cap comes first, whatever the mode: ask the question about copies
      // that were never going in and the prompt offers to move cards out of a
      // deck to make room for cardboard that doesn't exist.
      const going = opts.cap ? await capToOwnedCopies(targetId, copies) : copies;
      // 'copy' never touches the old spot, so there's nothing to look up.
      const clashes = policy === 'copy' ? [] : await findFilingClashes(targetId, going, opts);
      if (policy !== 'ask' || clashes.length === 0) {
        return { mode: policy === 'move' ? 'move' : 'copy', clashes, copies: going };
      }
      const row = await db.decks.get(targetId);
      const answer = await new Promise<FilingMode | null>((resolve) =>
        setPending({
          clashes,
          targetName: row?.name ?? 'here',
          targetKind: containerKind(row),
          resolve,
        }),
      );
      setPending(null);
      return answer ? { mode: answer, clashes, copies: going } : null;
    },
    [],
  );

  /**
   * File these copies. `capToOwned` (on by default) is the physical rule: the
   * target ends up holding at most as many of a copy as you own. Pass false only
   * when the cardboard hasn't reached the collection yet — a scan files the deck
   * first and writes the collection after, so there'd be nothing to cap against.
   */
  const file = useCallback(
    async (
      targetId: string,
      copies: FilingCopy[],
      meta: { source?: EventSource; capToOwned?: boolean } = {},
    ): Promise<FilingResult | null> => {
      const decided = await decide(targetId, copies, { cap: meta.capToOwned ?? true });
      if (!decided) return null;
      const filed = decided.copies.reduce((n, c) => n + c.quantity, 0);
      // Nothing to put away (and so nothing to move out of the way either):
      // don't touch the container just to write the same slots back.
      if (decided.copies.length === 0) return { mode: decided.mode, filed: 0 };
      await applyFiling(
        targetId,
        decided.copies,
        decided.mode,
        decided.clashes,
        meta.source ? { source: meta.source } : {},
      );
      return { mode: decided.mode, filed };
    },
    [decide],
  );

  const pin = useCallback(
    async (slot: PinTarget, copy: FilingCopy): Promise<FilingMode | null> => {
      // No cap: pinning re-describes a slot the container already lists, so it
      // never adds cardboard and has nothing to cap against.
      const decided = await decide(slot.deckId, [copy]);
      if (!decided) return null;
      await applyPinning(slot, copy, decided.mode, decided.clashes);
      return decided.mode;
    },
    [decide],
  );

  /**
   * Settle the question without writing anything: the deck re-scan reconciles
   * its slots itself, so it needs the answer (and the clashes to act on) rather
   * than a filing. Its write replaces the container's slots, so pass
   * `replacing` — see findFilingClashes.
   */
  const ask = useCallback(
    (targetId: string, copies: FilingCopy[], opts: { replacing?: boolean } = {}) => decide(targetId, copies, opts),
    [decide],
  );

  const sheet = pending ? (
    <FilingChoiceSheet
      clashes={pending.clashes}
      targetName={pending.targetName}
      targetKind={pending.targetKind}
      onChoose={pending.resolve}
      onClose={() => pending.resolve(null)}
    />
  ) : null;

  return { file, pin, ask, sheet };
}
