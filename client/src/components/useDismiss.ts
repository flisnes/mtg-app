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

// Every entry we push is stamped, and an overlay only ever spends the entry
// carrying its own stamp. Matching on the URL instead is not enough: the URL
// is identical for every entry in the stack, so a lower overlay unregistering
// while a higher one is up would spend the *higher* one's entry, and the next
// close would then eat a real page and throw you off the deck you were on.
// Same story if a pushState is ever dropped (Chrome throttles them) — no
// stamp, so nothing to spend, instead of a back that leaves the page.
const STAMP = '__dismissEntry';
// Per page load: a stamped entry left over from before a reload belongs to a
// dead run and must not read as ours.
const RUN = Math.random().toString(36).slice(2);
let nextToken = 0;

interface Overlay {
  close: () => void;
  /** Stamped into the entry we push, so we only ever spend our own. */
  token: string;
  /** False while our pushState is still queued behind an in-flight back(). */
  pushed: boolean;
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
 * navigate/Link still lines up, plus this overlay's stamp.
 */
function pushEntry(overlay: Overlay): void {
  historyOp(() => {
    const state = window.history.state as { idx?: number } | null;
    const idx = typeof state?.idx === 'number' ? { idx: state.idx + 1 } : null;
    window.history.pushState({ ...state, ...idx, [STAMP]: overlay.token }, '', window.location.href);
    overlay.pushed = true;
  });
}

function popEntry(): void {
  historyOp(() => {
    inFlight += 1;
    window.history.back();
  });
}

/** Is the entry we're sitting on the one this overlay pushed? */
function ownsTopEntry(overlay: Overlay): boolean {
  // Still queued: the push is guaranteed to land before the pop we're about to
  // queue behind it, so the pair still cancels out.
  if (!overlay.pushed) return true;
  return (window.history.state as Record<string, unknown> | null)?.[STAMP] === overlay.token;
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
  // Re-stamped with the top overlay's token: it's that overlay's entry again,
  // and its cleanup is what spends it.
  top.pushed = false;
  pushEntry(top);
  top.close();
}

/**
 * Is any sheet, menu or overlay currently up? The top one owns the keyboard
 * while it is, which is what keeps a global shortcut from firing at the page
 * behind it (see components/useShortcuts.ts).
 */
export function overlayOpen(): boolean {
  return stack.length > 0;
}

/** Close the sheet/dialog on Escape or the back button; pass null to disable. */
export function useDismiss(onClose: (() => void) | null): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  const active = onClose !== null;
  useEffect(() => {
    if (!active) return;
    const overlay: Overlay = { close: () => ref.current?.(), token: `${RUN}:${(nextToken += 1)}`, pushed: false };
    if (stack.length === 0) document.addEventListener('keydown', onKeydown, true);
    // The popstate listener stays for the life of the page: unbinding it here
    // would drop the pop our own history.back() is about to produce, leaving
    // inFlight stuck and the queue jammed.
    if (!popBound) {
      window.addEventListener('popstate', onPopState);
      popBound = true;
    }
    stack.push(overlay);
    pushEntry(overlay);
    return () => {
      stack.splice(stack.indexOf(overlay), 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKeydown, true);
      if (ownsTopEntry(overlay)) popEntry();
    };
  }, [active]);
}
