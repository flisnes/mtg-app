import { decodeCardmarketIndex, type CardmarketIdIndex, type Printing } from '@mtg/shared';
import { db } from '../db/schema.js';
import { fetchArtifactText } from './artifact.js';
import { CARD_DB_BASE } from './config.js';
import { getManifest } from './manifest.js';

// Cardmarket product id → printing, for reading a Cardmarket order export
// (which names each card by product id and nothing else). The index is half a
// megabyte and only a purchase import needs it, so it's fetched on the first
// lookup and kept in memory for the rest of the session, not stored.

let loaded: Promise<Map<number, string>> | null = null;

function loadIndex(): Promise<Map<number, string>> {
  loaded ??= (async () => {
    if (!CARD_DB_BASE) throw new Error('no card DB endpoint');
    const meta = (await getManifest()).v2?.cardmarket;
    if (!meta) throw new Error('This card database has no Cardmarket ids yet. Try again after the next card update.');
    return decodeCardmarketIndex(JSON.parse(await fetchArtifactText(meta, 'Cardmarket id')) as CardmarketIdIndex);
  })();
  // A failure is not remembered: the next import tries again.
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
}

/**
 * The printings these Cardmarket product ids name. Ids Scryfall has no
 * printing for (some The List and promo products) are simply left out.
 * Throws when the index can't be fetched (offline, or an older card DB).
 */
export async function printingsByCardmarketId(ids: readonly number[]): Promise<Map<number, Printing>> {
  const index = await loadIndex();
  const out = new Map<number, Printing>();
  for (const id of new Set(ids)) {
    const prefix = index.get(id);
    if (!prefix) continue;
    const dashed = `${prefix.slice(0, 8)}-${prefix.slice(8)}`;
    const p = await db.printings.where('scryfallId').startsWith(dashed).first();
    if (p) out.set(id, p);
  }
  return out;
}
