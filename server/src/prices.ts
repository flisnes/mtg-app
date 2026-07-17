import type { FastifyInstance } from 'fastify';
import type { PricesResponse } from '@mtg/shared';
import { authUser, fail } from './accounts.js';
import type { AccountStore } from './accountStore.js';
import type { PriceStore } from './priceStore.js';

// Server price history (sync plan Phase E). Signed-in users only: the archive
// exists for account holders' charts, and this route is where a future premium
// tier (history depth by plan) would be enforced — today everyone who is
// signed in gets the full window. The accounts CORS hook covers /api/*.

export function registerPriceRoutes(app: FastifyInstance, store: AccountStore, prices: PriceStore): void {
  app.get('/api/prices/:scryfallId', async (req, reply) => {
    const user = authUser(store, req, reply);
    if (!user) return;
    const { scryfallId } = req.params as { scryfallId: string };
    if (typeof scryfallId !== 'string' || scryfallId.length > 64) {
      return fail(reply, 400, { error: 'bad_request', message: 'Malformed printing id.' });
    }
    const history = prices.getHistory(scryfallId);
    if (!history) {
      return fail(reply, 404, { error: 'not_found', message: 'No price history recorded for that printing yet.' });
    }
    return history satisfies PricesResponse;
  });
}
