// Trade relay endpoint. Dev defaults to the local server; the Pages build sets
// VITE_TRADE_WS_URL to the VM's wss:// URL (needs a domain + TLS — Phase 5).
const raw = import.meta.env.VITE_TRADE_WS_URL as string | undefined;
export const TRADE_WS_URL: string = raw || 'ws://localhost:8080/ws';

/** Whether a trade endpoint is configured for this build (Pages needs wss). */
export const TRADE_ENABLED: boolean = !!raw || import.meta.env.DEV;
