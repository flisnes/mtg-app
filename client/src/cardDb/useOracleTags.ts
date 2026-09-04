import { useEffect, useState } from 'react';
import { loadOracleTags } from './oracleTags.js';

// The owned-list filters (collection, wishlist, a viewed profile's lists) parse
// their query synchronously inside a useMemo, so unlike the full-DB search they
// can't await the tag vocabulary. This loads it on mount and returns a counter
// that ticks once it's there, for those memos to depend on — otherwise the
// first `otag:` typed on a list would resolve to nothing and stay that way
// until some other dependency happened to change.

let ready = false;
const listeners = new Set<(n: number) => void>();

export function useOracleTags(): number {
  const [version, setVersion] = useState(ready ? 1 : 0);
  useEffect(() => {
    if (ready) return;
    listeners.add(setVersion);
    void loadOracleTags().then(() => {
      ready = true;
      for (const l of listeners) l(1);
    });
    return () => {
      listeners.delete(setVersion);
    };
  }, []);
  return version;
}
