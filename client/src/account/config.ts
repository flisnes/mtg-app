import { TRADE_ENABLED, TRADE_WS_URL } from '../trade/config.js';

// Accounts API base. Explicit VITE_API_URL wins; otherwise it's derived from
// the trade relay URL (same server: wss://host/ws → https://host/api), so the
// Pages build needs no extra env var.
const raw = import.meta.env.VITE_API_URL as string | undefined;

function derivedFromWs(): string {
  return TRADE_WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '/api');
}

export const API_URL: string = (raw ? raw.replace(/\/+$/, '') : derivedFromWs());

/** Accounts need the same server the trade relay runs on. */
export const ACCOUNTS_ENABLED: boolean = !!raw || TRADE_ENABLED;
