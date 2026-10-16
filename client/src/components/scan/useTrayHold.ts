import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNow } from '../useNow.js';

/**
 * How long the tray belongs to the user after they scroll or tap it: while it's
 * held, a new lock can't swap the row out from under the finger that is reaching
 * for a printing. Every further touch refreshes it, a thin bar drains it, and
 * taking the card out of frame hands it straight back.
 */
const TRAY_HOLD_MS = 4000;
/** Touch this recent counts as "still browsing", so the card leaving the frame
 *  doesn't cut the hold short mid-scroll. */
const TRAY_TOUCH_GRACE_MS = 1000;

/**
 * The tray is the user's while they browse it. `pendingId` is a different card
 * that locked meanwhile and was dropped: the camera never stops, so it re-locks
 * on its own the moment the hold drains. `seq` is the tray's lock counter.
 */
export function useTrayHold(seq: number | undefined) {
  // When the row goes back to the scanner (null = not held).
  const [holdUntil, setHoldUntil] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const touchedAtRef = useRef(0);
  /** Scrolled or tapped since this tray appeared: a late OCR result may badge
   *  the confirmed edition but must not re-front it in a row you're reading. */
  const touchedRef = useRef(false);
  const elRef = useRef<HTMLDivElement>(null);
  const now = useNow(holdUntil, 100);

  /** Give it back: the hold ran out, the row was scrolled home, or the card left. */
  const release = () => {
    if (holdUntil === null) return;
    setHoldUntil(null);
    setPendingId(null);
  };

  // The hold bar drained: hand the row back.
  useEffect(() => {
    if (holdUntil !== null && now >= holdUntil) release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, holdUntil]);

  // Every new lock — a different card, or the next copy of the same one — starts
  // the row from the left, so a printing you scrolled to on the last card isn't
  // what's under your thumb on this one. Keyed on the lock counter rather than
  // the card, and laid out before paint so the old offset never flashes.
  useLayoutEffect(() => {
    touchedRef.current = false;
    if (elRef.current) elRef.current.scrollLeft = 0;
  }, [seq]);

  return {
    elRef,
    touchedRef,
    pendingId,
    setPendingId,
    /** 1 right after a touch, 0 once the row is the scanner's again. */
    left: holdUntil === null ? 0 : Math.max(0, Math.min(1, (holdUntil - now) / TRAY_HOLD_MS)),
    isHeld: () => holdUntil !== null && Date.now() < holdUntil,
    browsing: () => Date.now() - touchedAtRef.current <= TRAY_TOUCH_GRACE_MS,
    /** Hand the row to the user for a while (any scroll or tap inside it). */
    hold: () => {
      touchedRef.current = true;
      touchedAtRef.current = Date.now();
      setHoldUntil(touchedAtRef.current + TRAY_HOLD_MS);
    },
    release,
  };
}
