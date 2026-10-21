import { serverBase, serverUrls } from '../endpoints.js';

// Scan-data endpoint (scanjob output served by Caddy). An explicit
// VITE_SCAN_DATA_URL wins (dev: a static server serving scanjob/out);
// otherwise it is the same server the trade relay runs on (https://host/scan/),
// resolved at run time by endpoints.ts. Read it per request, not at module load.
// Optional chain: import.meta.env only exists under Vite, and the scan modules
// also run in Node for the offline regression scripts.
const explicit = (import.meta.env?.VITE_SCAN_DATA_URL as string | undefined)?.replace(/\/?$/, '/');

/** Base URL of the scan data, with a trailing slash, or null when no server is configured. */
export function scanDataBase(): string | null {
  if (explicit) return explicit;
  const base = serverBase();
  return base ? serverUrls(base).scan : null;
}
