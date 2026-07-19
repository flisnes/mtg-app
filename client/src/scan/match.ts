import type { ScanIndex } from './blob.js';
import { scryfallIdAt } from './blob.js';
import { popcount32, type DHash } from './hash.js';

// Hamming search over the hash index (handover §S2): linear scan with u32
// popcounts — no BigInt on the hot path. 100k records × 4 popcounts is well
// under the 20 ms budget on any phone.

export interface ScanCandidate {
  /** Record index in the ScanIndex. */
  index: number;
  /** Combined Hamming distance (H + V when the blob has both variants). */
  distance: number;
  scryfallId: string;
  faceIndex: number;
}

export type MatchVerdict = 'confident' | 'ambiguous' | 'none';

export interface MatchResult {
  verdict: MatchVerdict;
  /** Best-first; same-card duplicates (multiple faces) not collapsed. */
  candidates: ScanCandidate[];
}

// Thresholds are per the handover (~10 bits on one 64-bit hash, second-best
// ≥ 4 bits worse), doubled for the combined 128-bit distance. Tune against
// the S1 self-match stats + the S2 photo set.
export const CONFIDENT_MAX_DISTANCE = { 1: 10, 2: 20 } as const;
export const CONFIDENT_MARGIN = { 1: 4, 2: 8 } as const;
/** Anything worse than this is noise, not a candidate. */
export const CANDIDATE_MAX_DISTANCE = { 1: 18, 2: 36 } as const;

/** Top-N nearest records by combined Hamming distance, best first. */
export function searchHashes(index: ScanIndex, query: DHash, topN = 8): ScanCandidate[] {
  const { count, hHi, hLo, vHi, vLo, algo } = index;
  const qhHi = query.h.hi;
  const qhLo = query.h.lo;
  const qvHi = query.v.hi;
  const qvLo = query.v.lo;
  const both = algo === 2;

  // Fixed-size insertion into (dist, idx) arrays — cheap for small topN.
  const dists = new Int32Array(topN).fill(0x7fffffff);
  const idxs = new Int32Array(topN).fill(-1);

  for (let i = 0; i < count; i++) {
    let d = popcount32(hHi[i]! ^ qhHi) + popcount32(hLo[i]! ^ qhLo);
    if (both) d += popcount32(vHi[i]! ^ qvHi) + popcount32(vLo[i]! ^ qvLo);
    if (d >= dists[topN - 1]!) continue;
    let j = topN - 1;
    while (j > 0 && dists[j - 1]! > d) {
      dists[j] = dists[j - 1]!;
      idxs[j] = idxs[j - 1]!;
      j--;
    }
    dists[j] = d;
    idxs[j] = i;
  }

  const out: ScanCandidate[] = [];
  for (let j = 0; j < topN; j++) {
    const i = idxs[j]!;
    if (i < 0) break;
    out.push({ index: i, distance: dists[j]!, scryfallId: scryfallIdAt(index, i), faceIndex: index.faces[i]! });
  }
  return out;
}

/**
 * Match policy (handover §S2): confident when the best hit is close and the
 * runner-up (of a *different* card) is clearly worse; otherwise hand the
 * near candidates to OCR / the user.
 */
export function classifyMatch(candidates: ScanCandidate[], algo: 1 | 2): MatchResult {
  const t1 = CONFIDENT_MAX_DISTANCE[algo];
  const margin = CONFIDENT_MARGIN[algo];
  const cutoff = CANDIDATE_MAX_DISTANCE[algo];

  const near = candidates.filter((c) => c.distance <= cutoff);
  const best = near[0];
  if (!best) return { verdict: 'none', candidates: [] };

  const rival = near.find((c) => c.scryfallId !== best.scryfallId);
  if (best.distance <= t1 && (!rival || rival.distance - best.distance >= margin)) {
    return { verdict: 'confident', candidates: near };
  }
  return { verdict: 'ambiguous', candidates: near };
}
