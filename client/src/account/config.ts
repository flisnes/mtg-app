import { serverBase, serverUrls } from '../endpoints.js';
import { tradeEnabled } from '../trade/config.js';

// Accounts API base. An explicit VITE_API_URL wins; otherwise it is the same
// server the trade relay runs on (https://host/api), resolved at run time by
// endpoints.ts. Read it per request, not at module load.
const explicit = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '');

export function apiUrl(): string {
  if (explicit) return explicit;
  const base = serverBase();
  return base ? serverUrls(base).api : 'http://localhost:8080/api';
}

/** Accounts need the same server the trade relay runs on. */
export function accountsEnabled(): boolean {
  return !!explicit || tradeEnabled();
}
