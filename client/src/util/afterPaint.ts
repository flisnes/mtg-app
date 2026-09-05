// Launch chores that nobody is waiting to see.
//
// The Collection is the landing screen, and everything on it comes out of the
// same IndexedDB the boot bookkeeping hammers (price snapshots, sync, exchange
// rates, image-cache pruning). Run those in the mount effect and they race the
// one query the user is actually staring at, which is how a local-only list
// ends up taking the better part of a second to appear. Hand them to the
// browser's idle time instead: nothing visible depends on any of them landing
// in the first second.

/** Run `task` once the browser is idle, or after `timeoutMs` at the latest. */
export function afterPaint(task: () => void, timeoutMs = 2000): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  // Safari only grew requestIdleCallback recently, so the timer is a real path,
  // not a formality.
  if (ric) ric(() => task(), { timeout: timeoutMs });
  else setTimeout(task, Math.min(timeoutMs, 1000));
}
