import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useDismiss } from './useDismiss.js';
import { useTapGuard } from './useTapGuard.js';

// The one bottom-sheet shell, so every sheet behaves identically: a portal to
// <body> (the tab bar's stacking context can otherwise cover the sheet's own
// buttons — see the CardSheet note), a click-away backdrop, Escape-to-close via
// the shared stack, the 400ms tap guard, and the dialog container. A couple of
// sheets used to skip the portal; routing them all through here removes that
// drift.
//
// The backdrop click stops propagation and checks the target: a sheet stacked
// above another (the edition picker over the card sheet) must not close the
// one underneath, and a sheet that renders further portals as React children
// (the value charts' day list) must not close itself when clicks bubble back
// up the React tree from them.
export function Sheet({
  onClose,
  dismiss,
  title,
  label,
  className,
  backdropClassName,
  resetKey,
  children,
}: {
  onClose: () => void;
  /** Escape/back handler when it differs from onClose; null disables it (a
   *  busy sheet that must not be dismissed mid-write). Backdrop clicks still
   *  use onClose. */
  dismiss?: (() => void) | null;
  /** Heading shown at the top of the sheet (.sheet-name). */
  title?: ReactNode;
  /** aria-label when there is no string title to name the dialog. */
  label?: string;
  /** Extra class on the .sheet container. */
  className?: string;
  /** Extra class on the .sheet-backdrop (e.g. card-sheet-backdrop). */
  backdropClassName?: string;
  /** For a sheet a long-lived parent re-renders in place between steps: pass
   *  the state that makes the current step appear and the tap guard's clock
   *  restarts with it. */
  resetKey?: unknown;
  children: ReactNode;
}) {
  useDismiss(dismiss === undefined ? onClose : dismiss);
  // A sheet that opens under the finger that opened it mustn't act on that tap.
  const tapGuard = useTapGuard(undefined, resetKey);
  return createPortal(
    <div
      className={backdropClassName ? `sheet-backdrop ${backdropClassName}` : 'sheet-backdrop'}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      {...tapGuard}
    >
      <div
        className={className ? `sheet ${className}` : 'sheet'}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      >
        {title !== undefined && <div className="sheet-name">{title}</div>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
