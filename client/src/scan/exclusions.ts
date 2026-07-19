import { db } from '../db/schema.js';

// Printings the camera must never suggest: Mystery Booster–style playtest
// cards. Their faces are mostly white with a few lines of black text, so
// their art dHashes carry just enough structure to pass the blank-art gates
// (blob.ts MIN_RECORD_POPCOUNT, pipeline MIN_ART_DETAIL) while still sitting
// close to whatever low-texture surface the camera happens to see — a real
// scanning session kept surfacing "Unknown Event" cards off a bare table.
//
// Scryfall marks all of these with promo_types: ["playtest"], but the slimmed
// client card DB doesn't carry promo_types, so this mirrors that flag by
// set/collector-number (checked against the full 935-card Scryfall list,
// 2026-07-19). The durable fix is excluding them in the VM's hashgen job;
// this client filter also covers already-downloaded blobs.

/** Sets that consist entirely of playtest cards. */
const PLAYTEST_SETS = new Set(['cmb1', 'cmb2', 'unk', 'punk']);

/** Playtest collector numbers inside otherwise-normal sets. */
const PLAYTEST_NUMBERS: Record<string, ReadonlySet<string>> = {
  pf24: new Set(['2']),
  pf25: new Set(['4', '8', '16']),
  pf26: new Set(['6', '11']),
  sld: new Set(['SCTLR']),
};

/** Mystery Booster 2's playtest sheet is collector numbers 501–621. */
const MB2_PLAYTEST = { set: 'mb2', from: 501, to: 621 };

export function isPlaytestPrinting(p: { set: string; collectorNumber: string }): boolean {
  if (PLAYTEST_SETS.has(p.set)) return true;
  if (p.set === MB2_PLAYTEST.set) {
    const n = parseInt(p.collectorNumber, 10);
    return n >= MB2_PLAYTEST.from && n <= MB2_PLAYTEST.to;
  }
  return PLAYTEST_NUMBERS[p.set]?.has(p.collectorNumber) ?? false;
}

/** ScryfallIds the scan index must drop (whatever of them exists in the card DB). */
export async function getScanExcludedIds(): Promise<Set<string>> {
  const sets = [...PLAYTEST_SETS, MB2_PLAYTEST.set, ...Object.keys(PLAYTEST_NUMBERS)];
  const printings = await db.printings.where('set').anyOf(sets).toArray();
  return new Set(printings.filter(isPlaytestPrinting).map((p) => p.scryfallId));
}
