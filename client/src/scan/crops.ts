// Crop boxes as data, not code (handover §S3) — fractions of the canonical
// warped card rect.

/**
 * The size every detected card is warped to. Deliberately identical to
 * Scryfall's `normal` image size: scanjob/hashgen.py crops CROP_BOXES.art out
 * of that image to build the index, so both sides hash the same region of the
 * same geometry and no per-layout knowledge is needed on either side.
 */
export const CANONICAL_CARD = { width: 488, height: 680 } as const;

export interface CropBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const CROP_BOXES: Record<'art' | 'infoStrip', CropBox> = {
  /**
   * The region matched against the hash index. On a modern frame this is the
   * art window; on other layouts it is whatever happens to be printed there,
   * which is fine because the index hashes the identical box.
   *
   * MUST stay identical to ART_BOX in scanjob/hashgen.py. Changing it on one
   * side alone silently breaks every match; changing it on both sides
   * invalidates the whole published blob and needs a format-version bump.
   */
  art: { x0: 0.08, y0: 0.11, x1: 0.92, y1: 0.56 },
  /**
   * Bottom info block (S4 OCR input). Measured on warped MID samples: text
   * spans ≈ y 0.90–0.965; margin absorbs imperfect warps.
   *
   * `x1` covers the whole printed line, not just the bottom-left corner. Only
   * the 2015 frame (Magic 2015 onward) puts the collector number bottom-left;
   * on the 1997 and 2003 frames — 26k printings — it is tacked onto the END of
   * the centred copyright line, out at x ≈ 0.70. The original 0.62 was measured
   * on MID and clipped every one of them mid-number. Stopping at 0.78 clears
   * the copyright line while staying left of the power/toughness box (x ≈ 0.82),
   * whose "1/1" would otherwise read as a collector number.
   */
  infoStrip: { x0: 0.03, y0: 0.885, x1: 0.78, y1: 0.975 },
};
