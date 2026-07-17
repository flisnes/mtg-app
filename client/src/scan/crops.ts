// Crop boxes as data, not code (handover §S3) — fractions of the canonical
// warped card rect. Old frames may need their own boxes later.

export const CANONICAL_CARD = { width: 488, height: 680 } as const;

export interface CropBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const CROP_BOXES: Record<'art' | 'infoStrip', CropBox> = {
  /** Art window of the modern frame. */
  art: { x0: 0.08, y0: 0.11, x1: 0.92, y1: 0.56 },
  /**
   * Bottom-left info block: both printed lines — collector number + rarity,
   * then set code · language · artist (S4 OCR input). Measured on warped MID
   * samples: text spans ≈ y 0.90–0.965; margin absorbs imperfect warps.
   */
  infoStrip: { x0: 0.03, y0: 0.885, x1: 0.62, y1: 0.975 },
};
