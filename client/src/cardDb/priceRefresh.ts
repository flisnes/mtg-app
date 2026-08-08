import { checkForBackgroundUpdate } from './sync.js';

// Prices-only refresh, for the one place where being a week out of date is
// actively harmful: a trade.
//
// Both clients value the same cards from their own local price shards, and
// nothing about the offer crosses the wire except ids and quantities. A device
// that has been running since last Tuesday therefore prices the deal differently
// from its partner, and neither side can see that it happened. Opening a session
// pulls today's prices so both sides start from the same numbers.
//
// Two deliberate limits:
//   - Prices only. Card data is large and stays behind its own prompt and its
//     own policy; nobody wants a 14 MB download over mobile data because they
//     walked up to a trade table.
//   - Ignores pricesPolicy, exactly like the Settings "Check now" buttons do
//     (see manualCheck.ts): starting a trade is consent to price it correctly.
//     The file is small and the alternative is silently mispricing the trade.
//
// Offline is a non-event — checkForBackgroundUpdate swallows the error and the
// trade runs on whatever is installed. That case is what the unpriced-line
// warning in the trade dock is for.

let inFlight: Promise<boolean> | null = null;

/**
 * Fetch and import today's prices, if they moved. Resolves true when new prices
 * landed (callers re-read their price lookups), false when already current or
 * unreachable. Concurrent callers share one run.
 */
export function refreshPricesNow(): Promise<boolean> {
  inFlight ??= runRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runRefresh(): Promise<boolean> {
  try {
    const upd = await checkForBackgroundUpdate();
    if (upd.kind === 'none') return false;
    // A card-data update carries a prices-only run alongside it; take that one.
    const prices = upd.kind === 'prices' ? upd : upd.prices;
    if (!prices) return false;
    await prices.run(() => {});
    return true;
  } catch {
    return false; // stale prices beat a broken trade screen
  }
}
