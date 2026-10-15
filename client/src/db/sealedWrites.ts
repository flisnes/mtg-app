import type { SealedItem } from '@mtg/shared';
import { db } from './schema.js';
import { clamp, newId } from './keys.js';
import { deleteSynced, putSynced } from './write.js';

// ---------------------------------------------------------------------------
// Unopened sealed products
// ---------------------------------------------------------------------------
// A booster box still in shrink. One row per product, quantity on the row —
// unlike a collection entry there's no condition/finish/language to split on,
// so productId alone is the identity. No UserEvent is emitted: the history log
// is card-shaped (every row needs an oracleId) and a box has no cards yet.

/** What the caller knows about a product when adding it; the rest is denormalized from it. */
export interface SealedItemInput {
  productId: string;
  name: string;
  set: string;
  setName?: string;
  tcgplayerId?: string;
}

/** Add copies of an unopened product, merging into the existing row if there is one. */
export async function addSealedItem(input: SealedItemInput, copies = 1): Promise<SealedItem> {
  const add = clamp(Math.floor(copies), 1, 9999);
  return db.transaction('rw', [db.sealedItems, db.outbox], async () => {
    const now = Date.now();
    const existing = await db.sealedItems.where('productId').equals(input.productId).first();
    const row: SealedItem = existing
      ? // Refresh the denormalized display fields too: a later card-DB build may
        // have filled in a set name or a tcgplayer id the first add didn't have.
        {
          ...existing,
          name: input.name || existing.name,
          set: input.set || existing.set,
          ...(input.setName ? { setName: input.setName } : {}),
          ...(input.tcgplayerId ? { tcgplayerId: input.tcgplayerId } : {}),
          quantity: clamp(existing.quantity + add, 1, 9999),
          updatedAt: now,
        }
      : {
          id: newId(),
          productId: input.productId,
          name: input.name,
          set: input.set,
          ...(input.setName ? { setName: input.setName } : {}),
          ...(input.tcgplayerId ? { tcgplayerId: input.tcgplayerId } : {}),
          quantity: add,
          createdAt: now,
          updatedAt: now,
        };
    await putSynced('sealedItems', row);
    return row;
  });
}

/** Set the owned count; a quantity of 0 or less removes the row entirely. */
export async function setSealedItemQuantity(id: string, quantity: number): Promise<void> {
  await db.transaction('rw', [db.sealedItems, db.outbox], async () => {
    const existing = await db.sealedItems.get(id);
    if (!existing) return;
    const next = Math.floor(quantity);
    if (next <= 0) {
      await deleteSynced('sealedItems', id);
      return;
    }
    const row: SealedItem = { ...existing, quantity: clamp(next, 1, 9999), updatedAt: Date.now() };
    await putSynced('sealedItems', row);
  });
}

export async function removeSealedItem(id: string): Promise<void> {
  await setSealedItemQuantity(id, 0);
}
