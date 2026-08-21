import { useCallback, useState } from 'react';
import type { ContainerKind, EventSource } from '@mtg/shared';
import { FilingChoiceSheet } from '../components/FilingChoiceSheet.js';
import { db } from '../db/schema.js';
import { getPrefs } from '../prefs.js';
import { containerKind } from './containers.js';
import {
  applyFiling,
  applyPinning,
  findFilingClashes,
  type FilingClash,
  type FilingCopy,
  type FilingMode,
  type PinTarget,
} from './filing.js';

/**
 * "File these cards there" for any screen that offers it, with the
 * already-filed-elsewhere question handled once and identically everywhere.
 *
 * Render `sheet` somewhere in the caller's tree and await `file(...)`: it settles
 * the policy (ask / move / file both), asks if it must, writes the slots, and
 * resolves with the mode it used — or null if the user backed out, so the caller
 * knows not to toast or exit its selection. `pin(...)` asks the same question for
 * a slot already sitting in the container, which the deck assembler points at a
 * real card rather than adding a second line.
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
      opts: { replacing?: boolean } = {},
    ): Promise<{ mode: FilingMode; clashes: FilingClash[] } | null> => {
      const policy = getPrefs().filingPolicy;
      // 'copy' never touches the old spot, so there's nothing to look up.
      const clashes = policy === 'copy' ? [] : await findFilingClashes(targetId, copies, opts);
      if (policy !== 'ask' || clashes.length === 0) {
        return { mode: policy === 'move' ? 'move' : 'copy', clashes };
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
      return answer ? { mode: answer, clashes } : null;
    },
    [],
  );

  const file = useCallback(
    async (
      targetId: string,
      copies: FilingCopy[],
      meta: { source?: EventSource } = {},
    ): Promise<FilingMode | null> => {
      const decided = await decide(targetId, copies);
      if (!decided) return null;
      await applyFiling(targetId, copies, decided.mode, decided.clashes, meta);
      return decided.mode;
    },
    [decide],
  );

  const pin = useCallback(
    async (slot: PinTarget, copy: FilingCopy): Promise<FilingMode | null> => {
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
