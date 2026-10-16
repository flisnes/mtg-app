import { useRef, useState } from 'react';
import { Icon } from '../icons.js';
import { useNow } from '../useNow.js';

/**
 * How long a lock holds the tray before it goes stale (time to tap, and to fix
 * the pickers). Once stale, the *next* time the card leaves the frame the lock
 * lets go, so a second copy of the same card can lock again — the padlock badge
 * shows the time left and releases it on tap.
 */
const LOCK_HOLD_MS = 3000;

/** The current lock's lifecycle and the countdown its badge drains. */
export function useLockRing() {
  // When the current lock was taken (null = no lock held, or it was released).
  const [lockAt, setLockAt] = useState<number | null>(null);
  // The tray no longer blocks a re-lock of the same card. A ref: the camera
  // reads it between renders.
  const releasedRef = useRef(false);
  // Stops ticking the moment the hold is up: an idle scanner shouldn't re-render
  // eight times a second.
  const now = useNow(lockAt === null ? null : lockAt + LOCK_HOLD_MS, 120);
  return {
    held: lockAt !== null,
    /** Countdown ring: 1 right after a lock, 0 once the hold is up or it let go. */
    holdLeft: lockAt === null ? 0 : Math.max(0, Math.min(1, 1 - (now - lockAt) / LOCK_HOLD_MS)),
    /** Held long enough that the card leaving the frame lets it go. */
    stale: () => lockAt !== null && Date.now() - lockAt >= LOCK_HOLD_MS,
    released: () => releasedRef.current,
    start: () => {
      releasedRef.current = false;
      setLockAt(Date.now());
    },
    /**
     * Let go of the current lock: the tray stays (you can still tap it), but the
     * very next lock is accepted even if it's the same card. Called by the padlock
     * badge and by the stale-lock rule in the camera callback.
     */
    release: () => {
      releasedRef.current = true;
      setLockAt(null);
    },
  };
}

/**
 * Lock state, bottom-left over the camera. One ring, one meaning: how committed
 * the scanner is to the card in front of it. It fills as the agreeing frames
 * stack up, is full the instant the card locks, then drains through the hold
 * that keeps this same copy from re-locking. A tap at any point after the lock
 * lets go at once.
 */
export function LockBadge({
  held,
  holdLeft,
  arming,
  hasTray,
  onRelease,
}: {
  held: boolean;
  holdLeft: number;
  /** Agreeing frames banked towards a lock, 0-1 (only while nothing is held). */
  arming: number;
  hasTray: boolean;
  onRelease: () => void;
}) {
  const ringFill = held ? holdLeft : arming;
  return (
    <button
      className={`scan-lock-badge${held ? ' scan-lock-held' : ''}${held && holdLeft === 0 ? ' scan-lock-stale' : ''}${!held && arming > 0 ? ' scan-lock-arming' : ''}`}
      onClick={onRelease}
      disabled={!held}
      aria-label={held ? 'Release the locked card' : 'No card locked'}
      title={
        !held
          ? arming > 0
            ? 'Reading the card… hold steady to lock'
            : hasTray
              ? 'Released: show the next card'
              : 'Nothing locked yet'
          : holdLeft === 0
            ? 'Ready for the next card. Tap to scan this one again'
            : 'Locked on this card. Tap to release'
      }
    >
      <svg className="scan-lock-ring" viewBox="0 0 36 36" aria-hidden>
        <circle className="scan-lock-ring-track" cx="18" cy="18" r="16" />
        <circle
          className="scan-lock-ring-fill"
          cx="18"
          cy="18"
          r="16"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={(100 - 100 * ringFill).toFixed(1)}
          // An empty ring still renders a hairline at 12 o'clock; hide it
          // rather than unmount, so the first step still tweens from zero.
          style={{ opacity: ringFill > 0 ? 1 : 0 }}
        />
      </svg>
      <Icon name={held ? 'lock' : 'unlock'} size={16} />
    </button>
  );
}
