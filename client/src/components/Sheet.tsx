import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Icon } from './icons.js';
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
//
// The action convention every sheet follows:
// - The way out is the ✕ in the header, top-right, on every sheet. A sheet
//   with a title gets it for free; a sheet with its own head (card sheet,
//   sealed item) puts a <SheetClose> at the end of it.
// - The action row (.sheet-actions) puts the primary bottom-right. Cancel or a
//   secondary answer sits left of it; nothing goes bottom-left alone.
// - A destructive action in a sheet is `danger-outline`. Solid `danger` is
//   only for ConfirmSheet's answer, the step that actually destroys.
export function Sheet({
  onClose,
  dismiss,
  title,
  subtitle,
  headerRight,
  closeButton = true,
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
  /** Heading shown at the top of the sheet (.sheet-name), in a header row
   *  that also carries the subtitle, headerRight and the ✕. */
  title?: ReactNode;
  /** Fine print under the title. */
  subtitle?: ReactNode;
  /** Controls between the title and the ✕ (a step count, a view toggle). */
  headerRight?: ReactNode;
  /** The header's ✕, which calls onClose. On by default for a titled sheet;
   *  pass an object to relabel it. Disabled while `dismiss` is null. */
  closeButton?: boolean | { label?: string; disabled?: boolean };
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
        {title !== undefined && (
          <div className="sheet-name-row">
            <div className="sheet-titles">
              <div className="sheet-name">{title}</div>
              {subtitle && <div className="fine-print sheet-subtitle">{subtitle}</div>}
            </div>
            {headerRight}
            {closeButton && (
              <SheetClose
                onClick={onClose}
                label={typeof closeButton === 'object' ? closeButton.label : undefined}
                disabled={(typeof closeButton === 'object' ? closeButton.disabled : undefined) ?? dismiss === null}
              />
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The header ✕, for a sheet that draws its own head instead of a title. */
export function SheetClose({ onClick, label = 'Close', disabled }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className="sheet-close" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Icon name="close" size={18} />
    </button>
  );
}
