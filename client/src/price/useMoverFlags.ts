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
    const [histories, entries] = await Promise.all([db.priceHistories.toArray(), db.collection.toArray()]);
    // Copies held decide whether a cheap card's move is pocket change or a
    // real position (see the position term in movers.ts).
    const qtyById = new Map<string, number>();
    for (const e of entries) qtyById.set(e.scryfallId, (qtyById.get(e.scryfallId) ?? 0) + e.quantity);
    const m = new Map<string, 'up' | 'down'>();
    for (const h of histories) {
      const f = moverFlag(h, tuning, qtyById.get(h.scryfallId) ?? 0);
      if (f) m.set(h.scryfallId, f);
    }
    return m;
  }, [tuning]);
}
