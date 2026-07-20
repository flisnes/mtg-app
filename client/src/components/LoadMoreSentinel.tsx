import { useEffect, useRef } from 'react';

// Infinite-scroll trigger: an invisible marker just past the last rendered card.
// When it scrolls into view (with a head-start via rootMargin so the next batch
// is ready before the user hits the very bottom) it calls onLoadMore.
//
// `rearmKey` re-creates the observer after each batch — if the freshly-loaded
// cards don't fill the viewport the sentinel is still intersecting, so the new
// observer fires again immediately and keeps loading until the page scrolls or
// there's nothing left.
export function LoadMoreSentinel({
  onLoadMore,
  hasMore,
  rearmKey,
}: {
  onLoadMore: () => void;
  hasMore: boolean;
  /** Value that changes each time a batch loads (e.g. the visible count). */
  rearmKey?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-subscribing the observer on every render.
  const cb = useRef(onLoadMore);
  cb.current = onLoadMore;

  useEffect(() => {
    if (!hasMore) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, rearmKey]);

  if (!hasMore) return null;
  return <div ref={ref} className="load-more-sentinel" aria-hidden />;
}
