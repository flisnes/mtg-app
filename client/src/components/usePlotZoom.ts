import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

// Pan and zoom for the time axis of the price charts. The view is held as a
// fraction of the full domain (0..1 = everything), so each chart keeps its own
// scales: it reads `lo`/`hi` and narrows its own window with them.
//
// Gestures, in the order they're claimed: two fingers pinch, one finger (or a
// held mouse button) drags to pan once the chart is zoomed in, and a drag on a
// chart showing everything scrubs like it always did — there is nothing to pan
// to. The wheel zooms around the pointer, on a listener attached by hand
// because React's is passive and a passive listener can't stop the page
// scrolling out from under the gesture.

/** Pixels a press has to travel before it counts as a drag rather than a tap. */
const MIN_DRAG = 4;
/** Fewest readings a zoomed-in view will squeeze down to. */
const MIN_POINTS = 4;

type Gesture =
  | { kind: 'pan'; x: number; lo: number; hi: number }
  | { kind: 'pinch'; d: number; anchor: number; lo: number; hi: number };

export interface PlotZoomOpts {
  /** Readings in the full domain; the view never zooms past a handful of them. */
  points: number;
  /** Plot padding and viewBox width, in SVG user units — the client-x mapping. */
  padL: number;
  padR: number;
  viewW: number;
  /** A press that never became a drag, at this client x. */
  onTap?: (clientX: number) => void;
  /** The pointer moved over the plot without dragging it. */
  onHover?: (clientX: number) => void;
  /** True when a mouse moving with no button held should scrub. */
  hoverScrub?: boolean;
}

export interface PlotZoom {
  /** Visible slice of the full domain, as fractions of it. */
  lo: number;
  hi: number;
  zoomed: boolean;
  reset: () => void;
  /** Spread onto the plot's <svg>. */
  bind: {
    ref: (el: SVGSVGElement | null) => void;
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerCancel: (e: React.PointerEvent<SVGSVGElement>) => void;
    onDoubleClick: () => void;
  };
}

export function usePlotZoom(opts: PlotZoomOpts): PlotZoom {
  const [view, setView] = useState({ lo: 0, hi: 1 });
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const viewRef = useRef(view);
  viewRef.current = view;
  const elRef = useRef<SVGSVGElement | null>(null);
  /** Live pointers on the plot, by id, at their latest client x. */
  const pointers = useRef(new Map<number, number>());
  const gesture = useRef<Gesture | null>(null);
  /** Set once a press travels far enough to be a drag, so it isn't also a tap. */
  const dragged = useRef(false);

  const ref = useCallback((node: SVGSVGElement | null) => {
    elRef.current = node;
    setEl(node);
  }, []);

  const reset = useCallback(() => setView({ lo: 0, hi: 1 }), []);

  /** Narrowest span the readings support, so zoom stops before the line does. */
  function minSpan(): number {
    const n = optsRef.current.points;
    return n > MIN_POINTS ? Math.min(1, MIN_POINTS / (n - 1)) : 1;
  }

  /** Width of the plot area in client pixels, or 0 before it's laid out. */
  function plotPx(): number {
    const node = elRef.current;
    const { padL, padR, viewW } = optsRef.current;
    if (!node || !viewW) return 0;
    const rect = node.getBoundingClientRect();
    if (!rect.width) return 0;
    return ((viewW - padL - padR) * rect.width) / viewW;
  }

  /** Client x → fraction of the *full* domain, clamped to the plot. */
  function fracOf(clientX: number): number | null {
    const node = elRef.current;
    const { padL, viewW } = optsRef.current;
    if (!node || !viewW) return null;
    const rect = node.getBoundingClientRect();
    const w = plotPx();
    if (!w) return null;
    const left = rect.left + (padL * rect.width) / viewW;
    const t = Math.min(1, Math.max(0, (clientX - left) / w));
    const { lo, hi } = viewRef.current;
    return lo + t * (hi - lo);
  }

  /** Scale the window by `factor` while holding `frac` under the pointer. */
  function zoomTo(frac: number, span: number, lo: number, hi: number): void {
    const next = Math.min(1, Math.max(minSpan(), span));
    const cur = hi - lo || 1;
    let nlo = frac - ((frac - lo) / cur) * next;
    nlo = Math.min(Math.max(0, nlo), 1 - next);
    setView({ lo: nlo, hi: nlo + next });
  }

  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const frac = fracOf(e.clientX);
      if (frac == null) return;
      e.preventDefault();
      const { lo, hi } = viewRef.current;
      zoomTo(frac, (hi - lo) * (e.deltaY > 0 ? 1.3 : 1 / 1.3), lo, hi);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  /** Start (or restart) a one-finger pan from whatever pointer is still down. */
  function beginPan(clientX: number): void {
    const { lo, hi } = viewRef.current;
    gesture.current = { kind: 'pan', x: clientX, lo, hi };
  }

  function beginPinch(): void {
    const xs = [...pointers.current.values()];
    if (xs.length < 2) return;
    const [a, b] = [xs[0]!, xs[1]!];
    const anchor = fracOf((a + b) / 2);
    const { lo, hi } = viewRef.current;
    gesture.current = { kind: 'pinch', d: Math.max(1, Math.abs(a - b)), anchor: anchor ?? (lo + hi) / 2, lo, hi };
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size >= 2) {
      beginPinch();
      return;
    }
    dragged.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; the gesture still works without it */
    }
    beginPan(e.clientX);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>): void {
    const held = pointers.current.has(e.pointerId);
    if (held) pointers.current.set(e.pointerId, e.clientX);
    const g = gesture.current;

    if (g?.kind === 'pinch' && pointers.current.size >= 2) {
      const xs = [...pointers.current.values()];
      const d = Math.max(1, Math.abs(xs[0]! - xs[1]!));
      dragged.current = true;
      zoomTo(g.anchor, (g.hi - g.lo) * (g.d / d), g.lo, g.hi);
      return;
    }

    if (g?.kind === 'pan' && held) {
      const dx = e.clientX - g.x;
      if (!dragged.current && Math.abs(dx) < MIN_DRAG) return;
      dragged.current = true;
      const span = g.hi - g.lo;
      // Nothing to pan to on a chart already showing everything, so a drag
      // there keeps scrubbing the crosshair like it used to.
      if (span > 0.999) {
        optsRef.current.onHover?.(e.clientX);
        return;
      }
      const w = plotPx();
      if (!w) return;
      const nlo = Math.min(Math.max(0, g.lo - (dx / w) * span), 1 - span);
      setView({ lo: nlo, hi: nlo + span });
      return;
    }

    if (optsRef.current.hoverScrub && e.pointerType === 'mouse' && !e.buttons) {
      optsRef.current.onHover?.(e.clientX);
    }
  }

  function endPointer(e: React.PointerEvent<SVGSVGElement>): void {
    pointers.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* never captured, or already released */
    }
    const rest = [...pointers.current.values()];
    if (rest.length === 1) {
      beginPan(rest[0]!);
      return;
    }
    if (rest.length > 1) return;
    gesture.current = null;
    // A press that stayed put was aiming at a point, not at the view.
    if (!dragged.current) optsRef.current.onTap?.(e.clientX);
  }

  return {
    lo: view.lo,
    hi: view.hi,
    zoomed: view.hi - view.lo < 0.999,
    reset,
    bind: {
      ref,
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onDoubleClick: reset,
    },
  };
}
