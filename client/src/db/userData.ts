import { db, USER_DATA_TABLES } from './schema.js';
import type { TransferPayload } from '../transfer/payload.js';
import { getSetting } from './settings.js';

async function clearUserDataTables(): Promise<void> {
  await Promise.all([...USER_DATA_TABLES, db.outbox].map((t) => t.clear()));
}

/**
 * Replace every user-data table with a device transfer's (already sanitized)
 * contents, atomically. Card DB and settings are kept — transferred rows
 * reference cards by id only, resolved against this device's card DB. The
 * sync outbox is cleared: the replaced rows no longer exist to push.
 */
export async function replaceAllUserData(data: Omit<TransferPayload, 'version'>): Promise<void> {
  // Wipe-and-replace stages no tombstones, so doing it while signed in would
  // silently diverge from the synced account. The UI hides the receive option
  // when signed in; guard here too, in case a user signs in while a received
  // payload is waiting at the review step. (Key read directly, like the sync
  // engine, to avoid an import cycle with account/session.ts.)
  if (await getSetting('accountSession')) {
    throw new Error('Sign out before replacing this device’s data from another device.');
  }
  await db.transaction('rw', [...USER_DATA_TABLES, db.outbox], async () => {
    await clearUserDataTables();
    await Promise.all([
      db.collection.bulkAdd(data.collection),
      db.sealedItems.bulkAdd(data.sealedItems),
      db.wishlist.bulkAdd(data.wishlist),
      db.decks.bulkAdd(data.decks),
      db.deckCards.bulkAdd(data.deckCards),
      // deckFolders was serialized and sanitized but never restored, so a
      // transfer silently unfiled every deck on the receiving device.
      db.deckFolders.bulkAdd(data.deckFolders),
      db.deckBehaviors.bulkAdd(data.deckBehaviors),
      db.trades.bulkAdd(data.trades),
      db.priceHistories.bulkAdd(data.priceHistories),
      db.sealedPriceHistories.bulkAdd(data.sealedPriceHistories),
      db.events.bulkAdd(data.events),
    ]);
  });
}

/** Wipe every user-data table (About screen: "delete all my data"). Card DB is kept. */
export async function deleteAllUserData(): Promise<void> {
  await db.transaction('rw', [...USER_DATA_TABLES, db.outbox], () => clearUserDataTables());
}
