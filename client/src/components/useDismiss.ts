import { useEffect, useRef } from 'react';

// Escape and the phone's back button both peel one overlay off the top of the
// stack, so sheets close one at a time (a card sheet above the search overlay
// closes before the overlay does).
//
// Escape: one document-level listener shared by every open sheet/dialog.
// Capture + stopPropagation keeps lower listeners from also firing.
//
// Back: on a phone, "back" while a sheet is up means "close the sheet", not
// "leave the deck I was looking at". Each overlay therefore pushes a throwaway
// history entry when it opens — same URL as the entry below it, so HashRouter
// never sees a change and nothing re-renders — and the back gesture pops that
// instead of navigating. A pop immediately re-pushes the entry and *then* asks
// the top overlay to close: the overlay may decline (the scanner confirms
// before discarding a session), and if it does close, its own cleanup spends
// the entry with history.back(). Either way one open overlay always owns
// exactly one entry, so back never needs two presses.
//
// The one leak we accept: an overlay closed *because* the app navigated (e.g.
// tapping a "filed in" pill) leaves its entry buried under the new one, where
// it costs one back press that looks like it did nothing.

interface Overlay {
  close: () => void;
  /** The URL we pushed under; if it has moved, our entry is buried. */
  href: string;
}

const stack: Overlay[] = [];
let popBound = false;

// Every history call goes through this queue. history.back() is asynchronous,
// and Chrome resolves the traversal against the entry that was current when we
// asked — so a pushState squeezed in before the popstate lands makes the two
// cancel out an entry too many. React's dev double-invoke of effects (mount →
// cleanup → mount) is enough to hit that, and so is closing one sheet as
// another opens. Serialising keeps one open overlay = one history entry.
let inFlight = 0;
const queued: Array<() => void> = [];

function historyOp(op: () => void): void {
  if (inFlight > 0) queued.push(op);
  else op();
}

function drain(): void {
  while (inFlight === 0 && queued.length > 0) queued.shift()!();
}

/**
 * Push a URL-identical history entry, mirroring what React Router's own push
 * does to `history.state` (it tracks its position there as `idx`) so a later
 * navigate/Link still lines up.
 */
function pushEntry(): void {
  historyOp(() => {
    const state = window.history.state as { idx?: number } | null;
    const idx = typeof state?.idx === 'number' ? { idx: state.idx + 1 } : null;
    window.history.pushState({ ...state, ...idx }, '', window.location.href);
  });
}

function popEntry(): void {
  historyOp(() => {
    inFlight += 1;
    window.history.back();
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1]!.close();
}

function onPopState(): void {
  if (inFlight > 0) {
    inFlight -= 1;
    drain();
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  pushEntry();
  top.close();
}

/** Close the sheet/dialog on Escape or the back button; pass null to disable. */
export function useDismiss(onClose: (() => void) | null): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  const active = onClose !== null;
  useEffect(() => {
    if (!active) return;
    const overlay: Overlay = { close: () => ref.current?.(), href: window.location.href };
    if (stack.length === 0) document.addEventListener('keydown', onKeydown, true);
    // The popstate listener stays for the life of the page: unbinding it here
    // would drop the pop our own history.back() is about to produce, leaving
    // inFlight stuck and the queue jammed.
    if (!popBound) {
      window.addEventListener('popstate', onPopState);
      popBound = true;
    }
    stack.push(overlay);
    pushEntry();
    return () => {
      stack.splice(stack.indexOf(overlay), 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKeydown, true);
      if (window.location.href === overlay.href) popEntry();
    };
  }, [active]);
}
