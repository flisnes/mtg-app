import type { Worker } from 'tesseract.js';
import { SCAN_DATA_BASE } from './config.js';
import type { ScanPipelineResult } from './pipeline.js';
import { stripAttempts } from './pipeline.js';

// OCR disambiguation (handover §S4). Art narrows a scan to one or a few
// candidate printings; the bottom-left info strip (collector number, set code,
// language) resolves WHICH printing and language. Tesseract.js, English
// traineddata only — the strip is digits + uppercase ASCII in every language.
//
// Asset hosting: with a scan-data endpoint configured, worker/core/traineddata
// load from the VM (<scan>/ocr/ — see scanjob/README.md); otherwise (dev)
// tesseract.js's pinned-version CDN defaults apply. Init failure is normal
// operation for callers: they fall back to art-only + manual picker.

export interface ParsedStrip {
  /** Normalized: leading zeros stripped, lowercase (matches Printing.collectorNumber). */
  collectorNumber: string | null;
  /** Lowercase set code (matches Printing.set). */
  setCode: string | null;
  /** Scryfall-style language code (en, de, ja, …). */
  lang: string | null;
  raw: string;
}

/** What a candidate printing needs to offer for cross-checking. */
export interface OcrCandidate {
  scryfallId: string;
  set: string;
  collectorNumber: string;
}

export interface OcrResolution {
  /** Candidate confirmed by the strip (set code + collector number agree). */
  confirmed: OcrCandidate | null;
  /** Set-code-only agreement — decent signal, not auto-accept grade. */
  weak: OcrCandidate | null;
  parsed: ParsedStrip | null;
  attempts: number;
}

// Printed language code (physical card) → Scryfall language code.
const PRINTED_LANGS: Record<string, string> = {
  EN: 'en',
  SP: 'es',
  FR: 'fr',
  DE: 'de',
  IT: 'it',
  PT: 'pt',
  JP: 'ja',
  KR: 'ko',
  RU: 'ru',
  CS: 'zhs',
  CT: 'zht',
  PH: 'ph',
};

let workerPromise: Promise<Worker> | null = null;

/** Lazy singleton worker, kept warm for the scan session (init is ~seconds). */
export function initOcr(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const assets = SCAN_DATA_BASE
      ? {
          workerPath: `${SCAN_DATA_BASE}ocr/worker.min.js`,
          corePath: `${SCAN_DATA_BASE}ocr/`,
          langPath: `${SCAN_DATA_BASE}ocr/`,
        }
      : {};
    const worker = await createWorker('eng', 1, assets);
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•*-— ',
      preserve_interword_spaces: '1',
      // Without a pinned DPI Tesseract sometimes estimates absurd resolutions
      // for the strip (2000+) and returns nothing.
      user_defined_dpi: '200',
    });
    return worker;
  })();
  workerPromise.catch(() => (workerPromise = null)); // allow retry after failure
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (p) await (await p).terminate();
}

/**
 * Upscale ×3 (the printed text is ~12 px in the strip) and adaptively binarize.
 * The info band is light text on the card's black bottom band, right under the
 * bright rules-text box — a global contrast stretch leaves the band mid-gray
 * and Tesseract's own binarization loses it. Local mean + offset flips
 * bright-on-dark text into clean black-on-white; the bright box region simply
 * comes out blank.
 */
export function prepareStrip(strip: ImageData): ImageData {
  const scale = 1.5; // strips arrive at 2× card scale already (stripAttempts)
  const w = Math.round(strip.width * scale);
  const h = Math.round(strip.height * scale);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y / scale - 0.5;
    const y0 = Math.max(0, Math.min(strip.height - 1, Math.floor(sy)));
    const y1 = Math.min(strip.height - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = x / scale - 0.5;
      const x0 = Math.max(0, Math.min(strip.width - 1, Math.floor(sx)));
      const x1 = Math.min(strip.width - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const at = (px: number, py: number) => {
        const o = (py * strip.width + px) * 4;
        return 0.299 * strip.data[o]! + 0.587 * strip.data[o + 1]! + 0.114 * strip.data[o + 2]!;
      };
      gray[y * w + x] =
        at(x0, y0) * (1 - fx) * (1 - fy) +
        at(x1, y0) * fx * (1 - fy) +
        at(x0, y1) * (1 - fx) * fy +
        at(x1, y1) * fx * fy;
    }
  }

  // Integral image → local mean over a text-height-sized window.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x]!;
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)]! + rowSum;
    }
  }
  // One-sided local binarization: the target text is BRIGHTER than its local
  // surroundings (light print on the card's black band). Only such pixels
  // become black ink on the white output — large uniform regions (rules box,
  // table background) come out white instead of slabs that break Tesseract's
  // page segmentation. The window is text-height-sized so faint strokes still
  // clear their local mean.
  const win = 24;
  const C = 8;
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const wy0 = Math.max(0, y - win);
    const wy1 = Math.min(h, y + win + 1);
    for (let x = 0; x < w; x++) {
      const wx0 = Math.max(0, x - win);
      const wx1 = Math.min(w, x + win + 1);
      const sum =
        integral[wy1 * (w + 1) + wx1]! -
        integral[wy0 * (w + 1) + wx1]! -
        integral[wy1 * (w + 1) + wx0]! +
        integral[wy0 * (w + 1) + wx0]!;
      const mean = sum / ((wy1 - wy0) * (wx1 - wx0));
      const v = gray[y * w + x]! > mean + C ? 0 : 255;
      const o = (y * w + x) * 4;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Encode as uncompressed 24-bit BMP — tesseract.js accepts Buffers in Node. */
function toBmp(img: ImageData): Uint8Array {
  const rowSize = Math.ceil((img.width * 3) / 4) * 4;
  const dataSize = rowSize * img.height;
  const buf = new Uint8Array(54 + dataSize);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  view.setUint32(2, 54 + dataSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, img.width, true);
  view.setInt32(22, -img.height, true); // top-down
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, dataSize, true);
  for (let y = 0; y < img.height; y++) {
    let o = 54 + y * rowSize;
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      buf[o++] = img.data[s + 2]!;
      buf[o++] = img.data[s + 1]!;
      buf[o++] = img.data[s]!;
    }
  }
  return buf;
}

function toImageLike(img: ImageData): OffscreenCanvas | Uint8Array {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    return canvas;
  }
  return toBmp(img); // Node (offline regression scripts)
}

/** Page-segmentation modes swept per strip: neither wins alone on real photos. */
export type StripPsm = 'block' | 'sparse';

export async function recognizeStrip(strip: ImageData, psm: StripPsm = 'block'): Promise<string> {
  const worker = await initOcr();
  const { PSM } = await import('tesseract.js');
  await worker.setParameters({
    tessedit_pageseg_mode: psm === 'block' ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT,
  });
  const image = toImageLike(prepareStrip(strip));
  const { data } = await worker.recognize(image as Parameters<Worker['recognize']>[0]);
  return data.text;
}

const normalizeCollector = (s: string): string => s.replace(/^0+(?=\d)/, '').toLowerCase();

export function parseInfoStrip(raw: string): ParsedStrip {
  const text = raw.toUpperCase();

  // "027/277" (or bare "0217" on frames without a total).
  let collectorNumber: string | null = null;
  const withTotal = text.match(/(\d{1,4}[A-Z]?)\s*\/\s*\d{2,4}/);
  if (withTotal) collectorNumber = normalizeCollector(withTotal[1]!);
  else {
    const bare = text.match(/^\s*(\d{3,4}[A-Z]?)\s*[A-Z]?\s*$/m);
    if (bare) collectorNumber = normalizeCollector(bare[1]!);
  }

  // "MID★EN" → set code + printed language, star often misread — allow junk between.
  let setCode: string | null = null;
  let lang: string | null = null;
  for (const m of text.matchAll(/\b([A-Z0-9]{3,5})\b[^A-Z0-9\n]{0,3}([A-Z]{2})\b/g)) {
    const mapped = PRINTED_LANGS[m[2]!];
    if (!mapped) continue;
    setCode = m[1]!.toLowerCase();
    lang = mapped;
    break;
  }

  return { collectorNumber, setCode, lang, raw };
}

/** Fold OCR-confusable glyphs before comparing (1↔I, 0↔O, 8↔B, 5↔S, 2↔Z). */
function foldConfusables(s: string): string {
  return s.replace(/1/g, 'I').replace(/0/g, 'O').replace(/8/g, 'B').replace(/5/g, 'S').replace(/2/g, 'Z');
}

/** True when edit distance (sub/ins/del) is ≤ 1 — OCR drops or bends a char. */
function withinEditOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (short.length === long.length) i++;
    j++; // same length → substitution; else skip one in the longer
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/** Look for the candidate's set code among uppercase tokens (edit ≤ 1). */
function findSet(text: string, set: string): 'exact' | 'fuzzy' | null {
  const target = set.toUpperCase();
  const folded = foldConfusables(target);
  let fuzzy = false;
  for (const token of text.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (token.length < 2 || token.length > target.length + 1) continue;
    if (token === target) return 'exact';
    if (withinEditOne(foldConfusables(token), folded)) fuzzy = true;
  }
  return fuzzy ? 'fuzzy' : null;
}

/** Look for the candidate's collector number ("027/277", "27 C", bare "0027"). */
function findCollector(text: string, collectorNumber: string): boolean {
  const cn = normalizeCollector(collectorNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9])0*${cn}\\s*(?:/|[A-Z]?\\s*$)`, 'im').test(text);
}

/**
 * OCR the strip (retrying with bottom-extended re-warps — the art-optimized
 * quad often cuts the collector line) and cross-check against the art
 * candidates: search the text for each candidate's KNOWN set code + collector
 * number instead of blind-parsing, tolerating one misread character in the
 * set code. Throws only on worker init failure.
 */
export async function resolveWithOcr(
  result: ScanPipelineResult,
  candidates: OcrCandidate[],
): Promise<OcrResolution> {
  let weak: OcrCandidate | null = null;
  let parsed: ParsedStrip | null = null;
  let attempts = 0;

  // With a large index the art stage occasionally picks the 180°-rotated warp
  // of an upright card (some other art matches the rotated crop marginally
  // better) — so if the assumed orientation yields nothing, retry the strips
  // under the opposite one.
  const orientations = [result, { ...result, flipped: !result.flipped }];

  for (const oriented of orientations) {
    for (const strip of stripAttempts(oriented)) {
    for (const psm of ['block', 'sparse'] as const) {
      attempts++;
      const text = await recognizeStrip(strip, psm);
      const p = parseInfoStrip(text);
      if (p.collectorNumber || p.setCode) {
        if (!parsed || (p.setCode && p.collectorNumber)) parsed = p;
      }

      let bestScore = 0;
      let best: OcrCandidate | null = null;
      for (const c of candidates) {
        const setHit = findSet(text, c.set);
        const collHit = findCollector(text, c.collectorNumber);
        const score = (collHit ? 2 : 0) + (setHit === 'exact' ? 2 : setHit === 'fuzzy' ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      // Collector + at least a fuzzy set hit = confirmed; one signal alone = weak.
      if (bestScore >= 3) return { confirmed: best, weak: null, parsed: parsed ?? p, attempts };
      if (bestScore === 2 && !weak) weak = best;
    }
    }
  }
  return { confirmed: null, weak, parsed, attempts };
}
