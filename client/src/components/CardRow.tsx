import { useCallback, useEffect, useRef, useState } from 'react';
import { CardItems, type CardItem } from './CardViews.js';
import { Icon } from './icons.js';

// A single horizontal strip of card tiles, used on the Community page so a
// user's trade and wishlists each read as one swipeable row instead of a tall
// stack you scroll past. Mobile swipes it natively; desktop gets wheel-to-side
// scrolling and arrow buttons. Scrolling near the right edge auto-loads the
// next page, same idea as LoadMoreSentinel but along the x-axis.
export function CardRow({
  items,
  hasMore,
  onLoadMore,
}: {
  items: CardItem[];
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  // Keep the latest onLoadMore without re-attaching listeners each render.
  const load = useRef(onLoadMore);
  load.current = onLoadMore;

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    // Head-start the next batch before the user hits the far end. If the strip
    // doesn't fill its width this fires immediately, paging until it does or
    // there's nothing left (hasMore false) — mirrors the sentinel's rearm.
    if (hasMore && el.scrollLeft + el.clientWidth >= el.scrollWidth - 600) load.current();
  }, [hasMore]);

  // Recompute arrows / trigger fill whenever the strip's contents change.
  useEffect(update, [update, items.length]);

  // Desktop: a vertical wheel scrolls the strip sideways. Attached natively so
  // the listener is non-passive and can preventDefault; a mostly-horizontal
  // wheel (trackpads) is left alone so the browser scrolls it for us.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const nudge = (dir: -1 | 1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <div className="card-row-wrap">
      <button
        className="card-row-arrow left"
        onClick={() => nudge(-1)}
        disabled={!canLeft}
        aria-label="Scroll left"
      >
        <Icon name="chevronLeft" />
      </button>
      <div className="card-row-scroll" ref={ref} onScroll={update}>
        <CardItems view="grid" className="card-row" items={items} />
      </div>
      <button
        className="card-row-arrow right"
        onClick={() => nudge(1)}
        disabled={!canRight}
        aria-label="Scroll right"
      >
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}
