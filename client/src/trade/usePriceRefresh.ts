import { useEffect, useState } from 'react';
import { refreshPricesNow } from '../cardDb/priceRefresh.js';

export interface TradePriceRefresh {
  /** A refresh is in flight — the totals on screen may still be yesterday's. */
  refreshing: boolean;
  /** Bumps when new prices landed. Feed it to price lookups so they re-read. */
  epoch: number;
}

/**
 * Pull today's prices when a trade session opens, so both devices value the
 * offer from the same numbers (see cardDb/priceRefresh.ts). Runs once per
 * session; a finished or cancelled trade doesn't bother.
 */
export function useTradePriceRefresh(active: boolean): TradePriceRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setRefreshing(true);
    void refreshPricesNow().then((updated) => {
      if (!live) return;
      setRefreshing(false);
      if (updated) setEpoch((e) => e + 1);
    });
    return () => {
      live = false;
    };
  }, [active]);

  return { refreshing, epoch };
}
