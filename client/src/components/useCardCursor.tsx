import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShortcuts } from './useShortcuts.js';

// "The card you're pointing at", so the keyboard has something to act on.
//
// On a phone there is no such thing, which is why the app never needed one. On
// a monitor there are two, and they have to be the same one or you get two
// highlights arguing: the card under the mouse, and the card you arrowed to.
// Both feed this, so `+` always means the card you're looking at however you
// came to be looking at it.
//
// Navigation reads the DOM rather than a list of keys threaded down through
// every board and group. Cards mark themselves with data-card-key when a cursor
// is present, so document order is the reading order for free: sorted,
// grouped, split across mainboard and sideboard, list or grid. Up and down are
// geometric, which is what makes a grid behave like a grid.

interface CursorCtx {
  activeKey: string | null;
  setActive: (key: string | null) => void;
}

const Ctx = createContext<CursorCtx | null>(null);

/** The cursor, or null outside a provider (every other screen in the app). */
export function useCardCursorCtx(): CursorCtx | null {
  return useContext(Ctx);
}

const canHover = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches;

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-card-key]')].filter((el) => el.offsetParent !== null);
}

/** Nearest card in a direction: vertical for up/down, document order otherwise. */
function step(from: HTMLElement, dir: 'up' | 'down' | 'prev' | 'next', all: HTMLElement[]): HTMLElement | undefined {
  const i = all.indexOf(from);
  if (dir === 'next') return all[i + 1];
  if (dir === 'prev') return all[i - 1];

  const a = from.getBoundingClientRect();
  const wanted = dir === 'down' ? 1 : -1;
  let best: { el: HTMLElement; drop: number; slip: number } | undefined;
  for (const el of all) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const drop = (b.top - a.top) * wanted;
    if (drop <= 1) continue; // same row, or the wrong way
    const slip = Math.abs(b.left + b.width / 2 - (a.left + a.width / 2));
    // The first row found in that direction wins; within it, the nearest column.
    if (!best || drop < best.drop - 1 || (Math.abs(drop - best.drop) <= 1 && slip < best.slip)) {
      best = { el, drop, slip };
    }
  }
  // A list is one card per row, so up/down off the end is simply the neighbour.
  return best?.el ?? (dir === 'down' ? all[i + 1] : all[i - 1]);
}

/**
 * Wrap the part of a page whose cards the keyboard should drive. Owns the
 * arrow keys; everything else a page wants to bind (quantity, open, remove) it
 * binds itself against `activeKey`.
 */
export function CardCursorProvider({ children }: { children: ReactNode }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Arrowing through a list scrolls it, and a mouse sitting still over that
  // list is suddenly over a different card, which the browser reports as a
  // hover. Left alone, that drags the cursor back to wherever the pointer
  // happens to be and the arrow keys can't get past it. So the mouse goes quiet
  // the moment a key is used, and speaks again the moment it genuinely moves.
  const keyboardDriving = useRef(false);
  useEffect(() => {
    const wake = () => {
      keyboardDriving.current = false;
    };
    document.addEventListener('mousemove', wake, { passive: true });
    return () => document.removeEventListener('mousemove', wake);
  }, []);

  const setActive = useCallback((key: string | null) => {
    if (keyboardDriving.current) return;
    // Hover only speaks on a device that has one. On a touchscreen the events
    // still fire (once, on tap) and would light up a card nobody pointed at.
    if (key !== null && !canHover()) return;
    setActiveKey(key);
  }, []);

  const move = useCallback(
    (dir: 'up' | 'down' | 'prev' | 'next') => {
      const all = cards();
      if (all.length === 0) return;
      const current = activeKey ? all.find((el) => el.dataset.cardKey === activeKey) : undefined;
      const next = current ? step(current, dir, all) : all[0];
      if (!next) return;
      keyboardDriving.current = true;
      setActiveKey(next.dataset.cardKey ?? null);
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    [activeKey],
  );

  useShortcuts(
    {
      ArrowUp: () => move('up'),
      ArrowDown: () => move('down'),
      ArrowLeft: () => move('prev'),
      ArrowRight: () => move('next'),
      // Nothing is pointed at any more, so nothing is about to be edited.
      Escape: activeKey ? () => setActiveKey(null) : null,
    },
    { allowRepeat: true },
  );

  const value = useMemo(() => ({ activeKey, setActive }), [activeKey, setActive]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
