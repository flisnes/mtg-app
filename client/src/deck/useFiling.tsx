import { useCallback, useState } from 'react';
import type { ContainerKind, EventSource } from '@mtg/shared';
import { FilingChoiceSheet } from '../components/FilingChoiceSheet.js';
import { db } from '../db/schema.js';
import { getPrefs } from '../prefs.js';
import { containerKind } from './containers.js';
import { applyFiling, findFilingClashes, type FilingClash, type FilingCopy, type FilingMode } from './filing.js';

/**
 * "File these cards there" for any screen that offers it, with the
 * already-filed-elsewhere question handled once and identically everywhere.
 *
 * Render `sheet` somewhere in the caller's tree and await `file(...)`: it settles
 * the policy (ask / move / file both), asks if it must, writes the slots, and
 * resolves with the mode it used — or null if the user backed out, so the caller
 * knows not to toast or exit its selection.
 */
export function useFiling() {
  const [pending, setPending] = useState<{
    clashes: FilingClash[];
    targetName: string;
    targetKind: ContainerKind;
    resolve: (mode: FilingMode | null) => void;
  } | null>(null);

  const file = useCallback(
    async (
      targetId: string,
      copies: FilingCopy[],
      meta: { source?: EventSource } = {},
    ): Promise<FilingMode | null> => {
      const policy = getPrefs().filingPolicy;
      // 'copy' never touches the old spot, so there's nothing to look up.
      const clashes = policy === 'copy' ? [] : await findFilingClashes(targetId, copies);
      let mode: FilingMode = policy === 'move' ? 'move' : 'copy';

      if (policy === 'ask' && clashes.length > 0) {
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
        if (!answer) return null;
        mode = answer;
      }

      await applyFiling(targetId, copies, mode, clashes, meta);
      return mode;
    },
    [],
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

  return { file, sheet };
}
