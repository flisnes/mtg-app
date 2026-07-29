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
   * Bottom-left info block: both printed lines — collector number + rarity,
   * then set code · language · artist (S4 OCR input). Measured on warped MID
   * samples: text spans ≈ y 0.90–0.965; margin absorbs imperfect warps.
   */
  infoStrip: { x0: 0.03, y0: 0.885, x1: 0.62, y1: 0.975 },
};
