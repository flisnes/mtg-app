import { useEffect, useRef } from 'react';

// One document-level Escape listener shared by every open sheet/dialog: only
// the top of the stack closes, so Escape peels overlays one at a time (a card
// sheet above the search overlay closes before the overlay does). Capture +
// stopPropagation keeps lower listeners (e.g. the global search's own Escape
// handler) from also firing.

const stack: Array<() => void> = [];

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1]!();
}

/** Close the sheet/dialog on Escape while mounted; pass null to disable. */
export function useEscapeToClose(onClose: (() => void) | null): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  const active = onClose !== null;
  useEffect(() => {
    if (!active) return;
    const entry = () => ref.current?.();
    if (stack.length === 0) document.addEventListener('keydown', onKeydown, true);
    stack.push(entry);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKeydown, true);
    };
  }, [active]);
}
