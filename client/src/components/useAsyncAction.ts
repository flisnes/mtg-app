import { useCallback, useRef, useState } from 'react';
import { logError } from '../errorLog.js';
import { useToast } from './Toast.js';

// `onClick={() => void save()}` is the shape of nearly every async handler in
// the app, and a throw inside one lands nowhere the user can see it: the global
// unhandledrejection hook (errorLog.ts) files it in the diagnostics log, and the
// button simply looks dead. No toast, no retry, nothing to report.
//
// The scanner hit this hard enough to grow its own wrapper ("Couldn't save the
// scan: …"), which fixed one file and left the other thirty-odd handlers exactly
// as they were. This is that wrapper, shared, so the next one gets it for free.
//
// Not a replacement for handlers that have something specific to say on failure
// (OpenSealedSheet, Settings' account flows, the filing-conflict resolver all
// catch and explain in their own words). This is the floor, not the ceiling.

export interface AsyncAction {
  /**
   * Run `fn`, and if it throws, say so and log it. `what` completes the sentence
   * "Couldn't …", so phrase it as the thing being attempted: 'save the price',
   * 'create the deck', 'rename the tag'.
   */
  run: (what: string, fn: () => Promise<unknown>) => void;
  /** True while an action from this hook is in flight (a free double-tap guard). */
  busy: boolean;
}

export function useAsyncAction(): AsyncAction {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The ref, not `busy`, is what guards: state lands a render later, which is
  // long after a double-tap.
  const running = useRef(false);

  const run = useCallback(
    (what: string, fn: () => Promise<unknown>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      void (async () => {
        try {
          await fn();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError('action', `${what}: ${message}`, err instanceof Error ? err.stack : undefined);
          toast(`Couldn't ${what}: ${message}`);
        } finally {
          running.current = false;
          setBusy(false);
        }
      })();
    },
    [toast],
  );

  return { run, busy };
}
