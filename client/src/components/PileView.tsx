import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismiss } from './useDismiss.js';

// Goblin mode's pile view: every copy of every card scattered face-up-or-down
// across one big heap, like a shoebox dumped on the table. No sorting, no
// filtering — you find cards by shoving them around with your finger.
//
// Gestures (all per card):
//  - drag        move the card (mouse: immediately; touch: hold ~240ms first,
//                or start sideways — a plain vertical swipe scrolls the page)
//  - double-tap  flip the card over (DFCs show their real back face,
//                everything else the classic Magic card back)
//  - long-press  card details; on a face-down single-faced card you get the
//                card back's "details" instead — no peeking
//
// The scatter is deterministic (seeded by each copy's key) so the pile keeps
// its shape across re-renders and app restarts; drags live only in component
// state, so leaving the page shakes the box.
//
// Only the cards near the viewport are mounted. Every copy's spot is computed
// up front (it's arithmetic, not DOM), so the heap's full height is known from
// the start and the scrollbar never lies — but a 3000-card collection would be
// 3000 rotated, shadowed, layer-promoted nodes, which Chrome composites about
// as gracefully as a goblin handles a Timetwister. Scrolling mounts the band it
// reaches. Positions, flips and z-bumps therefore have to be remembered *above*
// the card component, or scrolling past a card you shoved would shake it back
// into place.

export interface PileEntry {
  key: string;
  name: string;
  image: string | null;
  /** Real back face (double-faced cards); null → the generic Magic card back. */
  imageBack: string | null;
  /** Iridescent foil sheen over the front face (foil / etched finishes). */
  foil?: boolean;
  /** Physically oversized card (Commander precon oversized, etc.) — rendered larger to scale. */
  oversized?: boolean;
  /** Physical copies owned; the pile renders up to MAX_COPIES of them. */
  count: number;
  /** Long-press / keyboard open. faceDown tells the caller what's showing. */
  onLongPress?: (faceDown: boolean) => void;
}

/** Scryfall's scan of the standard Magic card back (the "Deckmaster" design). */
export const CARD_BACK_URL = 'https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg';
/** The same back at pile size: 9 KB against 80 KB, for a face 96px wide. */
const CARD_BACK_SMALL_URL = 'https://backs.scryfall.io/small/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg';

const CARD_W = 96;
const CARD_H = 134;
/** Oversized cards (3.5"×5") run ~1.4× a standard 2.5"×3.5" card, linearly. */
const OVERSIZED_SCALE = 1.4;
/** Copies rendered per entry — enough mess without turning 40 Islands into 40 nodes. */
const MAX_COPIES = 4;
/** Average card-area overlap; higher = denser, thicker pile. */
const COVERAGE = 1.9;

/** Kept mounted above and below the viewport, so a card is ready well before it's seen. */
const WINDOW_BLEED = 420;
/** The mounted band snaps to this grid: one re-render per BAND scrolled, not per pixel. */
const BAND = 200;

const LONG_PRESS_MS = 500;
/** Touch: hold this long before a move becomes a drag instead of a scroll. */
const ARM_MS = 240;
const DRAG_SLOP = 4;
const SCROLL_SLOP = 14;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 350;

/** FNV-1a, for seeding each copy's position from its key. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spot {
  x: number;
  y: number;
  rot: number;
  z: number;
  faceDown: boolean;
  /** Per-copy footprint — oversized cards are larger than the standard CARD_W/H. */
  w: number;
  h: number;
}

/**
 * What one copy has had done to it, held by the pile rather than the card so it
 * survives the card being unmounted when it scrolls out of the window. Absent
 * fields mean "still as dealt".
 */
interface CardMemo {
  x?: number;
  y?: number;
  z?: number;
  faceDown?: boolean;
}

export function PileView({ items }: { items: PileEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (w && w !== prev ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { copies, spots, height } = useMemo(() => {
    const copies = items.flatMap((entry) =>
      Array.from({ length: Math.max(1, Math.min(entry.count, MAX_COPIES)) }, (_, i) => ({
        entry,
        copyKey: `${entry.key}#${i}`,
        w: entry.oversized ? Math.round(CARD_W * OVERSIZED_SCALE) : CARD_W,
        h: entry.oversized ? Math.round(CARD_H * OVERSIZED_SCALE) : CARD_H,
      })),
    );
    // Deterministic shuffle so the heap isn't secretly in collection order.
    copies.sort((a, b) => hash(a.copyKey) - hash(b.copyKey));
    if (!width) return { copies, spots: new Map<string, Spot>(), height: 420 };

    const totalArea = copies.reduce((s, c) => s + c.w * c.h, 0);
    const maxH = copies.reduce((m, c) => Math.max(m, c.h), CARD_H);
    const height = Math.max(420, Math.ceil(totalArea / (width * COVERAGE)) + maxH);
    const spots = new Map<string, Spot>();
    copies.forEach((c, i) => {
      const bleedX = c.w * 0.25;
      const bleedY = c.h * 0.2;
      const rand = mulberry32(hash(c.copyKey));
      const x = -bleedX + rand() * (width - c.w + 2 * bleedX);
      const y = -bleedY + rand() * (height - c.h + 2 * bleedY);
      let rot = (rand() * 2 - 1) * 32;
      const p = rand();
      if (p < 0.1) rot += 90;
      else if (p < 0.2) rot -= 90;
      else if (p < 0.3) rot += 180;
      spots.set(c.copyKey, { x, y, rot, z: i + 1, faceDown: rand() < 0.12, w: c.w, h: c.h });
    });
    return { copies, spots, height };
  }, [items, width]);

  // Shared "top of the pile" counter: dragging or flipping a card raises it.
  const zRef = useRef(0);
  useEffect(() => {
    zRef.current = Math.max(zRef.current, copies.length + 1);
  }, [copies.length]);
  const nextZ = useCallback(() => ++zRef.current, []);

  // What the user has done to each copy, kept here so unmounting a card that
  // scrolled away doesn't undo it.
  const memos = useRef(new Map<string, CardMemo>());
  const memoFor = useCallback((key: string): CardMemo => {
    let m = memos.current.get(key);
    if (!m) {
      m = {};
      memos.current.set(key, m);
    }
    return m;
  }, []);
  // A width change re-scatters the whole heap, so remembered drags stop meaning
  // anything (flips still do — that's about the card, not where it landed).
  useEffect(() => {
    memos.current.forEach((m) => {
      delete m.x;
      delete m.y;
    });
  }, [width]);

  // The slice of the pile worth mounting, in the pile's own coordinates. Snapped
  // to BAND so a flick of the thumb doesn't re-render on every frame.
  const [band, setBand] = useState<{ top: number; bottom: number } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const top = Math.floor((-r.top - WINDOW_BLEED) / BAND) * BAND;
      const bottom = Math.ceil((-r.top + window.innerHeight + WINDOW_BLEED) / BAND) * BAND;
      setBand((prev) => (prev && prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture, because the app scrolls an inner container (.app-main) and scroll
    // events don't bubble out of it.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const shown = useMemo(() => {
    if (!width || !band) return [];
    return copies.filter((c) => {
      const s = spots.get(c.copyKey);
      if (!s) return false;
      // A card the user dragged sits where they left it, not where it was dealt.
      const y = memos.current.get(c.copyKey)?.y ?? s.y;
      // Rotation paints outside the w×h box; half the diagonal covers the worst case.
      const bleed = Math.hypot(s.w, s.h) / 2;
      return y + s.h + bleed > band.top && y - bleed < band.bottom;
    });
  }, [copies, spots, band, width]);

  return (
    <>
      <p className="pile-hint">
        Time to rummage. Double-tap to flip a card over, press and hold for details.
      </p>
      <div className="pile" ref={containerRef} style={{ height }}>
        {shown.map((c) => (
          <PileCard
            key={c.copyKey}
            entry={c.entry}
            spot={spots.get(c.copyKey)!}
            memo={memoFor(c.copyKey)}
            boundsW={width}
            boundsH={height}
            nextZ={nextZ}
          />
        ))}
      </div>
    </>
  );
}

/** In-flight pointer interaction on one card. */
interface Gesture {
  id: number;
  touch: boolean;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  curX: number;
  curY: number;
  dist: number;
  active: boolean;
  /** Moves become drags. Mouse: immediately; touch: after ARM_MS of holding. */
  armed: boolean;
  longTimer: number;
  armTimer: number;
}

/** Swallow the click synthesized after a drag/long-press (it would land on whatever is now under the pointer, e.g. a sheet backdrop). */
function suppressNextClick(): void {
  const swallow = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 500);
}

function PileCard({
  entry,
  spot,
  memo,
  boundsW,
  boundsH,
  nextZ,
}: {
  entry: PileEntry;
  spot: Spot;
  /** This copy's remembered state, owned by the pile (see CardMemo). */
  memo: CardMemo;
  boundsW: number;
  boundsH: number;
  nextZ: () => number;
}) {
  const el = useRef<HTMLDivElement>(null);
  // Remembered state wins over the deal: this card may have been mounted,
  // shoved around, scrolled away from and mounted again.
  const [pos, setPos] = useState({ x: memo.x ?? spot.x, y: memo.y ?? spot.y });
  const [z, setZ] = useState(memo.z ?? spot.z);
  const [faceDown, setFaceDown] = useState(memo.faceDown ?? spot.faceDown);
  // The back face is only built once this card has one to show.
  const [hasBackFace, setHasBackFace] = useState(memo.faceDown ?? spot.faceDown);
  const [dragging, setDragging] = useState(false);
  const g = useRef<Gesture | null>(null);
  const lastTap = useRef(0);
  const blockScroll = useRef<(() => void) | null>(null);

  // Re-scatter only when the layout genuinely moved this copy (width change).
  // Compared by value, so mounting with a remembered drag doesn't snap it back
  // and an unrelated re-render doesn't either.
  const dealt = useRef({ x: spot.x, y: spot.y });
  useEffect(() => {
    if (dealt.current.x === spot.x && dealt.current.y === spot.y) return;
    dealt.current = { x: spot.x, y: spot.y };
    setPos({ x: spot.x, y: spot.y });
  }, [spot.x, spot.y]);

  /** Move a card to where the user let go of it, and remember it. */
  function place(x: number, y: number): void {
    memo.x = x;
    memo.y = y;
    setPos({ x, y });
  }

  /** Raise this card to the top of the heap. */
  function raise(): void {
    const next = nextZ();
    memo.z = next;
    setZ(next);
  }

  // The transform is applied imperatively (not via the style prop) so React
  // re-renders mid-drag (z bump etc.) can't snap the card back a frame.
  useLayoutEffect(() => {
    if (el.current) el.current.style.transform = transformFor(pos.x, pos.y);
  });

  function transformFor(x: number, y: number): string {
    return `translate(${x}px, ${y}px) rotate(${spot.rot}deg)`;
  }

  const clampX = (x: number) => Math.min(Math.max(x, -spot.w / 2), boundsW - spot.w / 2);
  const clampY = (y: number) => Math.min(Math.max(y, -spot.h / 2), boundsH - spot.h / 2);

  function flip(): void {
    setHasBackFace(true);
    setFaceDown((f) => {
      memo.faceDown = !f;
      return !f;
    });
    raise();
  }

  function stopScrollBlocker(): void {
    blockScroll.current?.();
    blockScroll.current = null;
  }

  function endGesture(cur: Gesture): void {
    clearTimeout(cur.longTimer);
    clearTimeout(cur.armTimer);
    g.current = null;
    stopScrollBlocker();
    try {
      el.current?.releasePointerCapture(cur.id);
    } catch {
      /* already released */
    }
  }

  function onPointerDown(e: React.PointerEvent): void {
    if (g.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const touch = e.pointerType !== 'mouse';
    el.current?.setPointerCapture(e.pointerId);
    const cur: Gesture = {
      id: e.pointerId,
      touch,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
      curX: pos.x,
      curY: pos.y,
      dist: 0,
      active: false,
      armed: !touch,
      longTimer: 0,
      armTimer: 0,
    };
    cur.longTimer = window.setTimeout(() => {
      if (g.current !== cur || cur.active || cur.dist > TAP_SLOP) return;
      endGesture(cur);
      suppressNextClick();
      entry.onLongPress?.(faceDown);
    }, LONG_PRESS_MS);
    if (touch) {
      cur.armTimer = window.setTimeout(() => {
        if (g.current === cur && !cur.active) cur.armed = true;
      }, ARM_MS);
      // Once a drag is armed we must beat the browser to the scroll: a
      // non-passive document listener that preventDefaults touchmove.
      const prevent = (ev: TouchEvent) => {
        const active = g.current;
        if (active && (active.armed || active.active)) ev.preventDefault();
      };
      document.addEventListener('touchmove', prevent, { passive: false });
      blockScroll.current = () => document.removeEventListener('touchmove', prevent);
    }
    g.current = cur;
  }

  function onPointerMove(e: React.PointerEvent): void {
    const cur = g.current;
    if (!cur || e.pointerId !== cur.id) return;
    const dx = e.clientX - cur.startX;
    const dy = e.clientY - cur.startY;
    cur.dist = Math.max(cur.dist, Math.hypot(dx, dy));
    if (!cur.active) {
      const start = cur.armed
        ? cur.dist > DRAG_SLOP
        : cur.dist > SCROLL_SLOP && Math.abs(dx) > Math.abs(dy) * 1.2;
      if (start) {
        cur.active = true;
        clearTimeout(cur.longTimer);
        clearTimeout(cur.armTimer);
        setDragging(true);
        raise();
      } else if (!cur.armed && cur.dist > SCROLL_SLOP) {
        // Mostly-vertical swipe before the hold armed: it's a page scroll.
        endGesture(cur);
        return;
      }
    }
    if (cur.active) {
      cur.curX = clampX(cur.baseX + dx);
      cur.curY = clampY(cur.baseY + dy);
      if (el.current) el.current.style.transform = transformFor(cur.curX, cur.curY);
    }
  }

  function onPointerUp(e: React.PointerEvent): void {
    const cur = g.current;
    if (!cur || e.pointerId !== cur.id) return;
    const wasDrag = cur.active;
    endGesture(cur);
    if (wasDrag) {
      setDragging(false);
      place(cur.curX, cur.curY);
      suppressNextClick();
    } else if (cur.dist <= TAP_SLOP) {
      if (e.timeStamp - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        flip();
      } else {
        lastTap.current = e.timeStamp;
      }
    }
  }

  function onPointerCancel(e: React.PointerEvent): void {
    const cur = g.current;
    if (!cur || e.pointerId !== cur.id) return;
    const wasDrag = cur.active;
    endGesture(cur);
    if (wasDrag) {
      setDragging(false);
      place(cur.curX, cur.curY);
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      entry.onLongPress?.(faceDown);
    } else if (e.key.toLowerCase() === 'f') {
      flip();
    }
  }

  // Don't leave the document-level scroll blocker behind on unmount mid-drag.
  useEffect(() => () => blockScroll.current?.(), []);

  return (
    <div
      ref={el}
      className={`pile-card${dragging ? ' pile-dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={faceDown && !entry.imageBack ? 'Face-down card' : entry.name}
      style={{ width: spot.w, height: spot.h, zIndex: z }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <div className={`pile-card-inner${faceDown ? ' pile-flipped' : ''}`}>
        <div className="pile-face pile-front">
          {entry.image ? (
            <img src={entry.image} alt="" loading="lazy" draggable={false} />
          ) : (
            <span className="pile-ph">{entry.name}</span>
          )}
          {/* Sheen only while face-up: its mix-blend-mode would otherwise flatten the
              3D flip (killing backface-visibility) and mirror the front onto the back.
              A real Magic card back is never foil, so dropping it face-down is correct. */}
          {entry.foil && entry.image && !faceDown && <span className="foil-sheen" aria-hidden />}
        </div>
        {/* At four nodes and two images a card, the heap is heavy enough without a
            hidden back on every copy that never gets turned over. */}
        {hasBackFace && (
          <div className="pile-face pile-back">
            <img src={entry.imageBack ?? CARD_BACK_SMALL_URL} alt="" loading="lazy" draggable={false} />
          </div>
        )}
      </div>
    </div>
  );
}

/** "Card info" for the Magic card back — what you get for long-pressing a face-down card. No peeking. */
export function CardBackSheet({ onClose }: { onClose: () => void }) {
  useDismiss(onClose);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Card back">
        <div className="sheet-head">
          <img className="sheet-card" src={CARD_BACK_URL} alt="The Magic: The Gathering card back" />
          <div className="sheet-info">
            <div className="sheet-name">Card back</div>
            <div className="result-sub">Card — Back</div>
            <div className="result-sub">
              The most-printed piece of Magic art there is: Jesper Myrfors&rsquo; &ldquo;Deckmaster&rdquo; design, on
              the reverse of every card since 1993.
            </div>
            <div className="result-price">Priceless</div>
          </div>
        </div>
        <p className="fine-print">
          This card is face down, so this is all you get. Double-tap it to see what it actually is or savor the
          mystery.
        </p>
        <div className="sheet-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
