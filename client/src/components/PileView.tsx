import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeToClose } from './useEscapeToClose.js';

// Goblin mode's pile view: every copy of every card scattered face-up-or-down
// across one big heap, like a shoebox dumped on the table. No sorting, no
// filtering — you find cards by shoving them around with your finger.
//
// Gestures (all per card):
//  - drag        move the card (mouse: immediately; touch: hold ~180ms first,
//                or start sideways — a plain vertical swipe scrolls the page)
//  - double-tap  flip the card over (DFCs show their real back face,
//                everything else the classic Magic card back)
//  - long-press  card details; on a face-down single-faced card you get the
//                card back's "details" instead — no peeking
//
// The scatter is deterministic (seeded by each copy's key) so the pile keeps
// its shape across re-renders and app restarts; drags live only in component
// state, so leaving the page shakes the box.

export interface PileEntry {
  key: string;
  name: string;
  image: string | null;
  /** Real back face (double-faced cards); null → the generic Magic card back. */
  imageBack: string | null;
  /** Physical copies owned; the pile renders up to MAX_COPIES of them. */
  count: number;
  /** Long-press / keyboard open. faceDown tells the caller what's showing. */
  onLongPress?: (faceDown: boolean) => void;
}

/** Scryfall's scan of the standard Magic card back (the "Deckmaster" design). */
export const CARD_BACK_URL = 'https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg';

const CARD_W = 96;
const CARD_H = 134;
/** Copies rendered per entry — enough mess without turning 40 Islands into 40 nodes. */
const MAX_COPIES = 4;
/** Average card-area overlap; higher = denser, thicker pile. */
const COVERAGE = 1.9;

const LONG_PRESS_MS = 500;
/** Touch: hold this long before a move becomes a drag instead of a scroll. */
const ARM_MS = 180;
const DRAG_SLOP = 4;
const SCROLL_SLOP = 12;
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
      })),
    );
    // Deterministic shuffle so the heap isn't secretly in collection order.
    copies.sort((a, b) => hash(a.copyKey) - hash(b.copyKey));
    if (!width) return { copies, spots: new Map<string, Spot>(), height: 420 };

    const height = Math.max(420, Math.ceil((copies.length * CARD_W * CARD_H) / (width * COVERAGE)) + CARD_H);
    const bleedX = CARD_W * 0.25;
    const bleedY = CARD_H * 0.2;
    const spots = new Map<string, Spot>();
    copies.forEach((c, i) => {
      const rand = mulberry32(hash(c.copyKey));
      const x = -bleedX + rand() * (width - CARD_W + 2 * bleedX);
      const y = -bleedY + rand() * (height - CARD_H + 2 * bleedY);
      let rot = (rand() * 2 - 1) * 32;
      const p = rand();
      if (p < 0.1) rot += 90;
      else if (p < 0.2) rot -= 90;
      else if (p < 0.3) rot += 180;
      spots.set(c.copyKey, { x, y, rot, z: i + 1, faceDown: rand() < 0.12 });
    });
    return { copies, spots, height };
  }, [items, width]);

  // Shared "top of the pile" counter: dragging or flipping a card raises it.
  const zRef = useRef(0);
  useEffect(() => {
    zRef.current = Math.max(zRef.current, copies.length + 1);
  }, [copies.length]);
  const nextZ = useCallback(() => ++zRef.current, []);

  return (
    <>
      <p className="pile-hint">
        Shove cards around to dig through the pile. Double-tap to flip a card over, press and hold for details.
      </p>
      <div className="pile" ref={containerRef} style={{ height }}>
        {width > 0 &&
          copies.map((c) => (
            <PileCard
              key={c.copyKey}
              entry={c.entry}
              spot={spots.get(c.copyKey)!}
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
  boundsW,
  boundsH,
  nextZ,
}: {
  entry: PileEntry;
  spot: Spot;
  boundsW: number;
  boundsH: number;
  nextZ: () => number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: spot.x, y: spot.y });
  const [z, setZ] = useState(spot.z);
  const [faceDown, setFaceDown] = useState(spot.faceDown);
  const [dragging, setDragging] = useState(false);
  const g = useRef<Gesture | null>(null);
  const lastTap = useRef(0);
  const blockScroll = useRef<(() => void) | null>(null);

  // Re-scatter only when the layout genuinely moved this copy (width change);
  // by-value deps keep user drags alive across unrelated re-renders.
  useEffect(() => {
    setPos({ x: spot.x, y: spot.y });
  }, [spot.x, spot.y]);

  // The transform is applied imperatively (not via the style prop) so React
  // re-renders mid-drag (z bump etc.) can't snap the card back a frame.
  useLayoutEffect(() => {
    if (el.current) el.current.style.transform = transformFor(pos.x, pos.y);
  });

  function transformFor(x: number, y: number): string {
    return `translate(${x}px, ${y}px) rotate(${spot.rot}deg)`;
  }

  const clampX = (x: number) => Math.min(Math.max(x, -CARD_W / 2), boundsW - CARD_W / 2);
  const clampY = (y: number) => Math.min(Math.max(y, -CARD_H / 2), boundsH - CARD_H / 2);

  function flip(): void {
    setFaceDown((f) => !f);
    setZ(nextZ());
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
        setZ(nextZ());
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
      setPos({ x: cur.curX, y: cur.curY });
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
      setPos({ x: cur.curX, y: cur.curY });
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
      style={{ width: CARD_W, height: CARD_H, zIndex: z }}
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
        </div>
        <div className="pile-face pile-back">
          <img src={entry.imageBack ?? CARD_BACK_URL} alt="" loading="lazy" draggable={false} />
        </div>
      </div>
    </div>
  );
}

/** "Card info" for the Magic card back — what you get for long-pressing a face-down card. No peeking. */
export function CardBackSheet({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose);
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
          This card is face down, so this is all you get. Double-tap it to see what it actually is — or savor the
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
