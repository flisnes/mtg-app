import type { OracleCard, Printing, Priced } from '@mtg/shared';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import type { OwnershipIndex } from '../db/useOwnership.js';
import type { ScanIndex } from './blob.js';
import { CANDIDATE_MAX_DISTANCE, distancesForIds } from './match.js';
import type { ScanPipelineResult } from './pipeline.js';

// The scanner's candidate tray: one lock's matches along the bottom of the
// screen, and the rules for which of them are shown and in what order.

export interface Candidate {
  scryfallId: string;
  distance: number;
  printing?: Priced<Printing>;
  oracle?: Priced<OracleCard>;
}

export type OcrState = 'pending' | 'confirmed' | 'weak' | 'none' | 'unavailable';

/** The current lock's candidates, shown in the bottom tray until the next lock. */
export interface Tray {
  /** Bumped once per accepted lock, so a second copy of the same card (same
   *  topId) still counts as a new tray for anything that rewinds on one. */
  seq: number;
  /** Top candidate of the lock that produced this tray — dedups re-locks of the same card. */
  topId: string;
  candidates: Candidate[];
  ocr: OcrState;
  /** The candidate OCR confirmed (or weakly matched), if any. */
  ocrHit: string | null;
}

/**
 * A lock's matches joined with the card DB, per-face duplicates collapsed.
 *
 * Cards with a swarm of same-art printings (Command Tower!) can push the very
 * edition you own past the search's top-N. So the printings you own of the
 * matched card(s) are re-checked directly, and any whose art still matches this
 * scan (within the candidate cutoff) is spliced in; orderTrayCandidates then
 * floats them to the front by their owned badge.
 */
export async function joinCandidates(
  result: ScanPipelineResult,
  index: ScanIndex | null,
  ownership: OwnershipIndex | undefined,
): Promise<Candidate[]> {
  const ids = [...new Set(result.match.candidates.map((c) => c.scryfallId))];
  const printings = await getPrintingsByIds(ids);
  const oracles = await getOracleCardsByIds([...printings.values()].map((p) => p.oracleId));
  const candidates: Candidate[] = ids.map((id) => {
    const printing = printings.get(id);
    const best = result.match.candidates.find((c) => c.scryfallId === id)!;
    return { scryfallId: id, distance: best.distance, printing, oracle: printing && oracles.get(printing.oracleId) };
  });
  if (!index || !ownership) return candidates;

  const have = new Set(ids);
  const ownedIds = new Set<string>();
  for (const oracleId of new Set([...printings.values()].map((p) => p.oracleId))) {
    for (const sid of ownership.ownedPrintings(oracleId)) if (!have.has(sid)) ownedIds.add(sid);
  }
  const extra = [...distancesForIds(index, result.hash, ownedIds)].filter(([, d]) => d <= CANDIDATE_MAX_DISTANCE[index.algo]);
  if (extra.length) {
    const extraPrintings = await getPrintingsByIds(extra.map(([id]) => id));
    for (const [id, distance] of extra) {
      const printing = extraPrintings.get(id);
      // Same oracle as a top match, so its OracleCard is already loaded.
      candidates.push({ scryfallId: id, distance, printing, oracle: printing && oracles.get(printing.oracleId) });
    }
  }
  return candidates;
}

/**
 * Set lock: only that set's printings are suggested — the point of scanning a
 * sealed-set pile. If the scan matched none of them the filter steps aside
 * rather than leaving an empty tray (the picker row says so).
 */
export function filterBySet(candidates: Candidate[], set: string | null): Candidate[] {
  if (!set) return candidates;
  const hits = candidates.filter((c) => c.printing?.set === set);
  return hits.length ? hits : candidates;
}

/**
 * The single printing a candidate list names, or null when it names several —
 * what a set pin usually leaves standing. Foil and nonfoil siblings are one
 * printing here (same set, same collector number): which of them you're holding
 * is the finish picker's business, not the reader's, and the OCR scores them as
 * a tie for the same reason.
 */
export function onePrinting(candidates: Candidate[]): Candidate | null {
  const first = candidates[0];
  if (!first?.printing) return null;
  const same = candidates.every(
    (c) => c.printing?.set === first.printing!.set && c.printing?.collectorNumber === first.printing!.collectorNumber,
  );
  return same ? first : null;
}

/**
 * Tray order: the OCR-confirmed printing stays first, then editions the user
 * already owns bubble up (so their double-check badge is the first thing in
 * view), then the scanner's own distance order. Array.sort is stable, so equal
 * items keep that distance order.
 *
 * Called once, when the tray is built, and stored in that order: deriving it on
 * every render meant a +1 (which makes you an owner of that printing) re-sorted
 * the row under the very finger that tapped it.
 */
export function orderTrayCandidates(candidates: Candidate[], ocrHit: string | null, ownership?: OwnershipIndex): Candidate[] {
  const isHit = (c: Candidate) => (ocrHit === c.scryfallId ? 0 : 1);
  const ownsExact = (c: Candidate) => (ownership?.lookup(c.oracle?.oracleId ?? '', c.scryfallId).ownsExact ? 0 : 1);
  return [...candidates].sort((a, b) => isHit(a) - isHit(b) || ownsExact(a) - ownsExact(b));
}
