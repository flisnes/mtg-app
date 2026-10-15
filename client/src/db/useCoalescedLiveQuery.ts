import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';

/** Quiet time that ends a burst. */
const QUIET_MS = 150;
/** A burst still shows progress this often. */
const MAX_WAIT_MS = 1000;
/** While held (a sync is running), the longest a change is kept back. */
const HOLD_MAX_MS = 4000;

/**
 * A live query whose emissions are coalesced. The first result and a lone
 * write land at once; a burst of writes (a sync's pages, a bulk import, a batch
 * undo) lands as one update after it goes quiet, or every MAX_WAIT_MS while it
 * keeps going. `hold` keeps changes back while it's true (capped at
 * HOLD_MAX_MS) and lets the latest through the moment it drops.
 *
 * Dexie still re-reads per write; what's saved is everything downstream of the
 * value: the collection join, the index builds and every consumer's render.
 */
export function useCoalescedLiveQuery<T>(querier: () => Promise<T>, hold = false): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    let seeded = false;
    let pending: { v: T } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // When the current burst started (0 = no burst), to cap how long it waits.
    let burstAt = 0;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      burstAt = 0;
      if (pending) {
        const { v } = pending;
        pending = null;
        setValue(() => v);
      }
    };
    flushRef.current = flush;
    const schedule = () => {
      const cap = holdRef.current ? HOLD_MAX_MS : MAX_WAIT_MS;
      const left = cap - (Date.now() - burstAt);
      clearTimeout(timer);
      timer = setTimeout(flush, Math.max(0, holdRef.current ? left : Math.min(QUIET_MS, left)));
    };
    const sub = liveQuery(querier).subscribe({
      next: (v) => {
        if (!seeded || (!timer && !holdRef.current)) {
          // Leading edge: show it now, and open a quiet window that catches
          // whatever follows.
          seeded = true;
          setValue(() => v);
          burstAt = Date.now();
          schedule();
          return;
        }
        pending = { v };
        if (!burstAt) burstAt = Date.now();
        schedule();
      },
      error: (e) => console.error('[liveQuery]', e),
    });
    return () => {
      sub.unsubscribe();
      clearTimeout(timer);
      flushRef.current = () => {};
    };
    // The querier is fixed for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hold) flushRef.current();
  }, [hold]);

  return value;
}
