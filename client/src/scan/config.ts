import { TRADE_ENABLED, TRADE_WS_URL } from '../trade/config.js';

// Scan-data endpoint (scanjob output served by Caddy). Explicit
// VITE_SCAN_DATA_URL wins (dev: a static server serving scanjob/out);
// otherwise derived from the trade relay URL, same server:
// wss://host/ws → https://host/scan/.
// Optional chain: import.meta.env only exists under Vite — the scan modules
// also run in Node for the offline regression scripts.
const raw = import.meta.env?.VITE_SCAN_DATA_URL as string | undefined;

function derivedFromWs(): string | null {
  if (!TRADE_ENABLED) return null;
  return TRADE_WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '/scan/');
}

export const SCAN_DATA_BASE: string | null = raw ? raw.replace(/\/?$/, '/') : derivedFromWs();
