import { serverBase, serverUrls } from '../endpoints.js';

// Trade relay endpoint. The server's address is resolved at run time (see
// endpoints.ts): endpoints.json from the Pages site, else the baked
// VITE_TRADE_WS_URL, else the dev relay. Read it when you connect, not at
// module load, so a refreshed address applies to the next socket.

/** The relay's WebSocket URL. The dev default stands in when none is configured. */
export function tradeWsUrl(): string {
  const base = serverBase();
  return base ? serverUrls(base).ws : 'ws://localhost:8080/ws';
}

/** Whether a trade relay is configured for this device right now. */
export function tradeEnabled(): boolean {
  return serverBase() !== null;
}
