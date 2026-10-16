import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close an open popover (menu, dropdown, info bubble) on a pointerdown outside
 * `ref` or on Escape. Escape is caught on window in the capture phase and
 * stopped there, so a menu inside a sheet closes on its own instead of the
 * sheet's useDismiss taking the whole sheet down with it.
 *
 * No history entry, unlike useDismiss: a popover is a moment, and the account
 * menu navigates as it closes, which would bury an entry under the new page.
 */
export function usePopover(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, ref]);
}
