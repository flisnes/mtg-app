import { checkScanDataUpdate, downloadScanData } from '../scan/store.js';
import { checkForBackgroundUpdate } from './sync.js';

// The "Check now" buttons in Settings. Download policies exist so nothing is
// fetched behind the user's back — which means someone who set a feed to
// "Never" still needs a way to say "actually, do it, now". These run the same
// downloads the background path would, ignoring policy: pressing the button
// *is* the consent.
//
// Deliberately not the useCardDbUpdate hook: that owns the background loop and
// its prompt state, and mounting a second copy on the Settings screen would set
// two checkers running against each other.

export type CheckOutcome = { ok: boolean; message: string };

const mb = (n: number) => (n / 1e6).toFixed(1);

/** Card data (prices ride along). Also covers the case where only prices moved. */
export async function checkCardDataNow(): Promise<CheckOutcome> {
  try {
    const upd = await checkForBackgroundUpdate();
    if (upd.kind === 'none') return { ok: true, message: 'Card database is up to date.' };
    await upd.run(() => {});
    return upd.kind === 'prices'
      ? { ok: true, message: `Prices updated (${mb(upd.sizeBytes)} MB).` }
      : { ok: true, message: `Card data updated (${mb(upd.sizeBytes)} MB).` };
  } catch (e) {
    return { ok: false, message: `Update failed: ${(e as Error).message}` };
  }
}

/**
 * Prices only, leaving card data alone. When card chunks have also moved, sync
 * hands back a prices-only run that deliberately doesn't stamp the card-data
 * version (see messages.ts stampVersion).
 */
export async function checkPricesNow(): Promise<CheckOutcome> {
  try {
    const upd = await checkForBackgroundUpdate();
    if (upd.kind === 'none') return { ok: true, message: 'Prices are up to date.' };
    const prices = upd.kind === 'prices' ? upd : upd.prices;
    if (!prices) return { ok: true, message: 'Prices are up to date.' };
    await prices.run(() => {});
    return { ok: true, message: `Prices updated (${mb(prices.sizeBytes)} MB).` };
  } catch (e) {
    return { ok: false, message: `Price update failed: ${(e as Error).message}` };
  }
}

/** The card-art index used by the camera scanner. */
export async function checkScanDataNow(): Promise<CheckOutcome> {
  try {
    const upd = await checkScanDataUpdate();
    if (upd.kind !== 'update') return { ok: true, message: 'Scan data is up to date.' };
    await downloadScanData(upd.manifest);
    return { ok: true, message: `Scan data updated (${mb(upd.manifest.bytes)} MB).` };
  } catch (e) {
    return { ok: false, message: `Scan-data update failed: ${(e as Error).message}` };
  }
}
