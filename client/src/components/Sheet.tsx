import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useEscapeToClose } from './useEscapeToClose.js';

// The one bottom-sheet shell, so every sheet behaves identically: a portal to
// <body> (the tab bar's stacking context can otherwise cover the sheet's own
// buttons — see the CardSheet note), a click-away backdrop, Escape-to-close via
// the shared stack, and the dialog container. A couple of sheets used to skip
// the portal; routing them all through here removes that drift.
export function Sheet({
  onClose,
  title,
  label,
  className,
  children,
}: {
  onClose: () => void;
  /** Heading shown at the top of the sheet (.sheet-name). */
  title?: ReactNode;
  /** aria-label when there is no string title to name the dialog. */
  label?: string;
  /** Extra class on the .sheet container. */
  className?: string;
  children: ReactNode;
}) {
  useEscapeToClose(onClose);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
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
