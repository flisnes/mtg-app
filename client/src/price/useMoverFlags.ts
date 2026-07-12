import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { moverFlag } from './movers.js';

/**
 * scryfallId → mover badge direction, for the corner markers in card lists
 * (see moverFlag). Undefined while loading; cards without a notable move are
 * simply absent.
 */
export function useMoverFlags(): Map<string, 'up' | 'down'> | undefined {
  return useLiveQuery(async () => {
    const m = new Map<string, 'up' | 'down'>();
    for (const h of await db.priceHistories.toArray()) {
      const f = moverFlag(h);
      if (f) m.set(h.scryfallId, f);
    }
    return m;
  }, []);
}
