import type { ScanIndex } from './blob.js';
import { CANONICAL_CARD, CROP_BOXES } from './crops.js';
import {
  cropImageData,
  detectCardQuads,
  expandQuad,
  extendQuadSide,
  rotateImageData180,
  warpPerspective,
  type Quad,
} from './geometry.js';
import { dhash, grayscale, type DHash } from './hash.js';
import { classifyMatch, searchHashes, type MatchResult } from './match.js';

// The still-image scan pipeline, shared by the test harness, the offline
// regression scripts, and (in S3) the camera path. Detection on a photo is
// ambiguous — thresholding may find the card's outer edge OR its inner frame,
// and the card may be upside-down — so every plausible quad (plus a
// border-expansion variant of each) is warped and hashed, and the hypothesis
// with the closest index match wins.

/**
 * Per-quad size variants: as-is; grown (thresholding often finds the card's
 * inner frame — the black border sits outside it); shrunk (a sleeved card
 * detects the sleeve edge — the card sits inside it).
 */
const QUAD_VARIANTS = [0, +0.075, -0.045];
const MAX_QUAD_CANDIDATES = 4;

/**
 * Art crops with less structure than this never reach the index — their hash
 * bits are noise, and a flat surface would otherwise "match" the blank-art
 * records at distance ~0 (playtest Whiteout et al.). Calibration: blank arts
 * measure ≤ ~1.1, a strong lighting gradient on a plain surface ~4.3, the
 * flattest real card art in a 400-sample ~3.8, median ~18.
 */
export const MIN_ART_DETAIL = 2.5;

export interface ScanPipelineInput {
  /** Full working image (cap ~1600px — hashes fine, warps fast). */
  full: ImageData;
  /** Downscaled copy for detection (~480px wide), same aspect. */
  detect: ImageData;
  /** User-corrected corners in `full` coordinates — skips detection. */
  manualQuad?: Quad | null;
}

export interface ScanPipelineResult {
  /** Winning quad in `full` coordinates; null = nothing detected (full frame used). */
  quad: Quad | null;
  /** The exact quad that was warped (variant applied) — OCR re-warps from it. */
  warpQuad: Quad;
  /** The full input frame, passed through for OCR re-warping. */
  full: ImageData;
  /** Size variant of the winning hypothesis (+grown / −shrunk / 0 as-is). */
  variant: number;
  /** Best match came from the 180°-rotated warp. */
  flipped: boolean;
  hash: DHash;
  match: MatchResult;
  /** Winning warped card, upright. */
  warped: ImageData;
  art: ImageData;
  infoStrip: ImageData;
  timings: { detect: number; match: number };
}

function fullFrameQuad(w: number, h: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

interface Hypothesis {
  quad: Quad | null;
  warpQuad: Quad;
  /** The size variant applied (0 = detected quad as-is). */
  variant: number;
}

export function runScanPipeline(input: ScanPipelineInput, index: ScanIndex): ScanPipelineResult {
  const { full, detect, manualQuad } = input;

  const t0 = performance.now();
  let quads: (Quad | null)[];
  if (manualQuad) {
    quads = [manualQuad];
  } else {
    const scale = full.width / detect.width;
    const detected = detectCardQuads(detect, MAX_QUAD_CANDIDATES).map(
      (q) => q.map((p) => ({ x: p.x * scale, y: p.y * scale })) as unknown as Quad,
    );
    quads = detected.length ? detected : [null];
  }
  const detectMs = performance.now() - t0;

  const hypotheses: Hypothesis[] = quads.flatMap((quad): Hypothesis[] => {
    const warpQuad = quad ?? fullFrameQuad(full.width, full.height);
    // Size variants only make sense for real detections; manual corners and
    // the full-frame fallback are used as-is.
    if (!quad || manualQuad) return [{ quad, warpQuad, variant: 0 }];
    return QUAD_VARIANTS.map((variant) => ({ quad, warpQuad: expandQuad(warpQuad, variant), variant }));
  });

  // Early exit: once a hypothesis matches this closely, later ones can't
  // meaningfully improve the identification — saves ~half the work for the
  // live camera loop.
  const GOOD_ENOUGH = 8;

  const t1 = performance.now();
  let best: ScanPipelineResult | null = null;
  outer: for (const hyp of hypotheses) {
    const warped = warpPerspective(full, hyp.warpQuad, CANONICAL_CARD.width, CANONICAL_CARD.height);
    for (const flipped of [false, true]) {
      const upright = flipped ? rotateImageData180(warped) : warped;
      const art = cropImageData(upright, CROP_BOXES.art);
      const hash = dhash(grayscale(art));
      // Featureless crop (bare table, wall) — hash bits are noise; don't
      // search, or every blank-ish record looks like a near-perfect match.
      const candidates = hash.detail >= MIN_ART_DETAIL ? searchHashes(index, hash, 8) : [];
      const distance = candidates[0]?.distance ?? Infinity;
      if (best && distance >= (best.match.candidates[0]?.distance ?? Infinity)) continue;
      best = {
        quad: hyp.quad,
        warpQuad: hyp.warpQuad,
        full,
        variant: hyp.variant,
        flipped,
        hash,
        match: classifyMatch(candidates, index.algo),
        warped: upright,
        art,
        infoStrip: cropImageData(upright, CROP_BOXES.infoStrip),
        timings: { detect: detectMs, match: 0 },
      };
      if (distance <= GOOD_ENOUGH) break outer;
    }
  }
  best!.timings.match = performance.now() - t1;
  return best!;
}

/**
 * Info-strip crops for OCR, at increasing bottom extensions of the winning
 * quad. The art-optimized warp often reconstructs the card bottom a few
 * percent short (the bottom band is taller than the side borders), cutting the
 * collector line — so OCR tries the strip as-is, then from re-warps whose
 * bottom side is pushed out. Extended strips run to the canvas bottom, so the
 * text lands inside one of them wherever the true edge is.
 *
 * Warped at 2× the canonical card size: the printed text is ~1.5 px stroke at
 * hash resolution — too degraded for OCR — while the source photo has the
 * detail to spare.
 */
export function stripAttempts(result: ScanPipelineResult, extensions = [0, 0.05, 0.1, 0.15]): ImageData[] {
  const OCR_SCALE = 2;
  const w = CANONICAL_CARD.width * OCR_SCALE;
  const out: ImageData[] = [];
  for (const f of extensions) {
    // A flipped card's bottom band sits at the quad's top side.
    const quad = f
      ? extendQuadSide(result.warpQuad, result.flipped ? 'top' : 'bottom', f)
      : result.warpQuad;
    const h = Math.round(CANONICAL_CARD.height * OCR_SCALE * (1 + f));
    const warped = warpPerspective(result.full, quad, w, h);
    const upright = result.flipped ? rotateImageData180(warped) : warped;
    const y0 = CROP_BOXES.infoStrip.y0 * CANONICAL_CARD.height * OCR_SCALE;
    out.push(
      cropImageData(upright, {
        x0: CROP_BOXES.infoStrip.x0,
        x1: CROP_BOXES.infoStrip.x1,
        y0: y0 / h,
        y1: f === 0 ? CROP_BOXES.infoStrip.y1 : 1,
      }),
    );
  }
  return out;
}
