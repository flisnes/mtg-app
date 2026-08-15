import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { moverFlag } from './movers.js';
import { useMoverTuning } from './moverTuning.js';

/**
 * scryfallId → mover badge direction, for the corner markers in card lists
 * (see moverFlag). Undefined while loading; cards without a notable move are
 * simply absent. Follows the user's own thresholds, so the badges agree with
 * what the Price movers page reports.
 */
export function useMoverFlags(): Map<string, 'up' | 'down'> | undefined {
  const tuning = useMoverTuning();
  return useLiveQuery(async () => {
    const m = new Map<string, 'up' | 'down'>();
    for (const h of await db.priceHistories.toArray()) {
      const f = moverFlag(h, tuning);
      if (f) m.set(h.scryfallId, f);
    }
    return m;
  }, [tuning]);
}
