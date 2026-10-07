import { useEffect, useState } from 'react';
import type { SetTypeMap } from '@mtg/shared';
import { loadSetTypes } from './setTypes.js';

// The set-type map as React state, for views that judge promos on the main
// thread (the stacked collection picking its shown edition). Null until it has
// loaded, or forever when it never does; callers fall back to the per-card
// promo flag either way. `enabled` keeps the fetch off screens that don't need
// it — the map is a few KB and cached in memory after the first load.

export function useSetTypes(enabled = true): SetTypeMap | null {
  const [types, setTypes] = useState<SetTypeMap | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadSetTypes().then((t) => {
      if (live) setTypes(t);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? types : null;
}
