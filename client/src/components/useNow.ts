import { useEffect, useState } from 'react';

/**
 * Date.now(), re-read every `ms` until `until` has passed, then left alone, so
 * an idle countdown stops re-rendering. `null` = nothing to count down to.
 * Between a new deadline and the first tick the value is stale (earlier), which
 * reads as "nothing has drained yet" for every countdown built on it.
 */
export function useNow(until: number | null, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(t);
    }, ms);
    return () => clearInterval(t);
  }, [until, ms]);
  return now;
}
