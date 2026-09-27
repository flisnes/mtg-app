// Persisted trade-scan session keys. This lives apart from ScanSheet.tsx so
// Trade.tsx can clean up stale sessions without pulling the whole scanner
// (camera, OCR, matcher) into its chunk — ScanSheet is lazy-loaded.
export const TRADE_SCAN_PREFIX = 'scan-session:trade:';

/**
 * Drop persisted trade scans that don't belong to trade `keep` (omit it to drop
 * all of them). An offer only exists inside its own trade, so a scan for one
 * that has finished — or that was walked away from — has nowhere left to land.
 */
export function clearTradeScanSessions(keep?: string): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(TRADE_SCAN_PREFIX)) continue;
      if (keep && k.startsWith(`${TRADE_SCAN_PREFIX}${keep}:`)) continue;
      doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
