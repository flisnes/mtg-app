import { useCallback, useState, type ReactNode } from 'react';
import type { ContainerKind } from '@mtg/shared';
import { ContainerPickerSheet } from '../components/ContainerPickerSheet.js';
import { Sheet } from '../components/Sheet.js';
import { useToast } from '../components/Toast.js';
import { CONTAINER_META } from './containers.js';
import { useFiling } from './useFiling.js';
import type { FilingCopy } from './filing.js';

/**
 * "Where do these live?" — the question no intake path used to ask.
 *
 * Scanning a box of cards into your collection, importing a CSV, adding a
 * precon: all of them knew you now own the cards and none of them ever asked
 * where they are. Filing meant a second trip: back to the list, Select, tick
 * every row again, File away.
 *
 * Await `offer(...)` after the cards have landed. It shows one prompt, and if
 * you pick a container it goes through the same filing engine (and the same
 * move-or-both question) that "File away" has always used. Declining is a
 * no-op — the cards stay exactly where the add put them.
 */
export function useFileThese(): {
  offer: (copies: FilingCopy[], count: number) => Promise<void>;
  sheet: ReactNode;
} {
  const { file, sheet: filingSheet } = useFiling();
  const toast = useToast();
  const [pending, setPending] = useState<{ copies: FilingCopy[]; count: number; resolve: () => void } | null>(null);
  const [picking, setPicking] = useState(false);

  const offer = useCallback(
    (copies: FilingCopy[], count: number) =>
      new Promise<void>((resolve) => {
        // Nothing to file (every line skipped, or a wishlist-shaped add).
        if (copies.length === 0) {
          resolve();
          return;
        }
        setPicking(false);
        setPending({ copies, count, resolve });
      }),
    [],
  );

  const done = () => {
    pending?.resolve();
    setPending(null);
    setPicking(false);
  };

  async function pick(containerId: string, kind: ContainerKind) {
    if (!pending) return;
    setPicking(false);
    const mode = await file(containerId, pending.copies);
    // Backed out of the move-or-both question: back to the picker, not out of
    // the whole step — they were mid-decision, not cancelling the filing.
    if (mode === null) {
      setPicking(true);
      return;
    }
    const noun = CONTAINER_META[kind].noun;
    const n = pending.count;
    toast(
      mode === 'move'
        ? `Moved ${n} card${n === 1 ? '' : 's'} to ${noun}`
        : `Filed ${n} card${n === 1 ? '' : 's'} in ${noun}`,
    );
    done();
  }

  const sheet = pending ? (
    picking ? (
      <ContainerPickerSheet
        title="Where do these live?"
        label="Choose where these cards are kept"
        onPick={(id, kind) => void pick(id, kind)}
        onClose={() => setPicking(false)}
      />
    ) : (
      <Sheet onClose={done} title="Where do these live?" label="File the cards you just added">
        <p className="search-meta">
          {pending.count} card{pending.count === 1 ? ' is' : 's are'} in your collection now. File{' '}
          {pending.count === 1 ? 'it' : 'them'} in a deck, binder or box while you have the pile in your hands?
        </p>
        <p className="fine-print">You can always do this later from the collection: Select, then File away.</p>
        <div className="sheet-actions sheet-actions-stack">
          <button className="primary" onClick={() => setPicking(true)}>
            Choose a deck, binder or box
          </button>
          <button onClick={done}>Leave {pending.count === 1 ? 'it' : 'them'} unfiled</button>
        </div>
      </Sheet>
    )
  ) : null;

  return {
    offer,
    sheet: (
      <>
        {sheet}
        {filingSheet}
      </>
    ),
  };
}
