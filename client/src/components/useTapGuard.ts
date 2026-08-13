import { useCallback, useEffect, useRef, type MouseEvent } from 'react';

// A sheet that opens *after* an async read lands under the finger that opened
// it. The scanner's "Add N cards to …" is the case that bit a tester: the tap
// starts a collection lookup, the "Already filed somewhere else" prompt appears
// a moment later with its Cancel button sitting exactly where that button was,
// and the second tap — the one you make when a button seems not to have
// registered — silently cancels the whole scan.
//
// A tap can't have been aimed at something that wasn't on screen when the press
// began, so for the first few hundred milliseconds of a sheet's life its clicks
// are swallowed in the capture phase, before React dispatches them to anything
// inside (or to the backdrop's own dismiss). Deliberate presses land a blink
// later, which nobody can tap fast enough to notice.

/** How long a freshly opened sheet ignores clicks. Long enough to cover a
 *  double-tap, short enough that a deliberate press never feels ignored. */
export const TAP_GUARD_MS = 400;

/**
 * Spread the result onto a sheet's `.sheet-backdrop` element. `resetKey` is for
 * a sheet whose markup is rendered inline by a long-lived parent instead of
 * being mounted fresh: pass the state that makes it appear and the clock
 * restarts with it, not with the parent.
 */
export function useTapGuard(ms: number = TAP_GUARD_MS, resetKey?: unknown): { onClickCapture: (e: MouseEvent) => void } {
  const openedAt = useRef(performance.now());
  useEffect(() => {
    openedAt.current = performance.now();
  }, [resetKey]);
  const onClickCapture = useCallback(
    (e: MouseEvent) => {
      if (performance.now() - openedAt.current >= ms) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [ms],
  );
  return { onClickCapture };
}
