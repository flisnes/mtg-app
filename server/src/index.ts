import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { AccountStore } from './accountStore.js';
import { registerAccountRoutes } from './accounts.js';
import { startPriceArchiver } from './priceArchive.js';
import { PriceStore } from './priceStore.js';
import { registerPriceRoutes } from './prices.js';
import { registerTradeRelay } from './relay.js';
import { SyncHub } from './syncHub.js';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    // Behind Caddy on the same VM, so every connection arrives from loopback.
    // Trust only loopback when reading X-Forwarded-For: this makes req.ip the
    // real client IP (so per-IP limits work) without letting a client spoof it
    // — Caddy appends the true peer address after any header the client sent.
    trustProxy: 'loopback',
  });

  await app.register(websocket, {
    options: {
      // Bound message size so a malformed/huge offer can't exhaust memory.
      maxPayload: 1 * 1024 * 1024,
    },
  });

  // Liveness probe. Caddy / systemd / uptime checks hit this. No card data,
  // no personal data — just aggregate counters (beta plan §7).
  app.get('/healthz', async () => {
    return { ok: true, uptimeSec: Math.round(process.uptime()) };
  });

  // One store + hub shared by the HTTP accounts API and the WS relay: the
  // relay authenticates sync_sub subscriptions against the store, and the
  // sync route notifies subscribed sockets through the hub.
  const store = new AccountStore(config.dataDir);
  const hub = new SyncHub();
  // Daily price archive (Phase E): its own SQLite file, appended in-process.
  const priceStore = new PriceStore(config.dataDir);
  const stopArchiver = startPriceArchiver(priceStore, app.log);
  app.addHook('onClose', () => {
    stopArchiver();
    store.close();
    priceStore.close();
  });

  registerTradeRelay(app, store, hub);
  registerAccountRoutes(app, store, hub);
  registerPriceRoutes(app, store, priceStore);

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`trade relay listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
