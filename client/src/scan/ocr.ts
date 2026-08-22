import type { Worker } from 'tesseract.js';
import { SCAN_DATA_BASE } from './config.js';
import type { ScanPipelineResult } from './pipeline.js';
import { stripAttempts } from './pipeline.js';

// OCR disambiguation (handover §S4). Art narrows a scan to one or a few
// candidate printings; the bottom info strip (collector number, set code,
// copyright year, language) resolves WHICH printing and language. Tesseract.js,
// English traineddata only — the strip is digits + uppercase ASCII in every
// language.
//
// What is actually printed down there changed twice, and the cross-check has to
// follow (see PRINTED_SINCE): before Exodus there is no collector number at
// all, and before Magic 2015 there is no set code. For those eras the copyright
// year carries the signal instead — it is the only set-level discriminator on a
// 4th/5th/6th Edition card, and it is the largest text in the strip.
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
  /** Copyright year, the print year of the set (1994 onward). */
  year: number | null;
  raw: string;
}

/** What a candidate printing needs to offer for cross-checking. */
export interface OcrCandidate {
  scryfallId: string;
  set: string;
  collectorNumber: string;
  /** ISO date — decides which of the three signals this card can even carry. */
  releasedAt: string;
}

export interface OcrResolution {
  /** Candidate confirmed by the strip (two independent signals agree). */
  confirmed: OcrCandidate | null;
  /** One signal only — decent ordering hint, not auto-accept grade. */
  weak: OcrCandidate | null;
  parsed: ParsedStrip | null;
  attempts: number;
}

/**
 * When each printed signal appears on the card, verified against Scryfall
 * `normal` scans one set at a time across the whole run of frames.
 *
 * - `year`: Fallen Empires is the first with a copyright line. Revised and
 *   earlier print "Illus. © Artist" and no date at all.
 * - `collectorNumber`: Exodus is the first, at "…Wizards of the Coast, Inc.
 *   142/143". Stronghold, three months earlier, still has none. Scryfall
 *   assigns numbers to older sets alphabetically, so for those the number in
 *   the card DB was never printed on the card — searching for it can only
 *   produce a false positive.
 * - `setCode`: the "DOM • EN" line arrives with the 2015 frame, which debuted
 *   in Magic 2015 (July 2014) — not, despite the frame's name, in 2015.
 *   Modern retro-frame reprints carry it too, so this is a release-date rule
 *   rather than a frame rule, which suits us: the client card DB has the date.
 */
const PRINTED_SINCE = {
  year: '1994-11-01', // Fallen Empires
  collectorNumber: '1998-06-15', // Exodus
  setCode: '2014-07-18', // Magic 2015
} as const;

export interface PrintedSignals {
  setCode: boolean;
  collectorNumber: boolean;
  year: boolean;
}

/** Which of the three cross-check signals this printing physically carries. */
export function printedSignals(releasedAt: string): PrintedSignals {
  return {
    setCode: releasedAt >= PRINTED_SINCE.setCode,
    collectorNumber: releasedAt >= PRINTED_SINCE.collectorNumber,
    year: releasedAt >= PRINTED_SINCE.year,
  };
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
  const p = (workerPromise ??= (async () => {
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
      // The en dash earns its place: the copyright line reads "1993–2001", and
      // without it Tesseract has to spell the separator as something else.
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•*-–— ',
      preserve_interword_spaces: '1',
      // Without a pinned DPI Tesseract sometimes estimates absurd resolutions
      // for the strip (2000+) and returns nothing.
      user_defined_dpi: '200',
    });
    return worker;
  })());
  // Allow a retry after a failed init, but only clear THIS promise — never a
  // fresh one a later initOcr() may already have installed.
  p.catch(() => {
    if (workerPromise === p) workerPromise = null;
  });
  return p;
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

/**
 * Print years named by the copyright line, newest interpretation first.
 *
 * The line is "©1995", "©1993–1999" or "™ & © 1993–2001": in a range only the
 * SECOND year is the print year, and blindly grabbing every 4-digit number
 * would hand 1993 to every card printed after 1998. The separator is optional
 * because Tesseract drops thin dashes often enough to matter ("19932001").
 */
export function printedYears(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b((?:19|20)\d{2})\s*[-–—]?\s*((?:19|20)\d{2})?\b/g)) {
    const year = Number(m[2] ?? m[1]);
    if (!out.includes(year)) out.push(year);
  }
  return out;
}

/**
 * Copyright year agreement. A year either side still counts, because a set that
 * goes on sale in January was very often printed — and dated — the autumn
 * before, but it counts for less: neighbouring years are exactly what makes two
 * different sets look alike, so an exact match has to outrank a near one or a
 * 1999 printing scores just as well as the 2000 one actually in frame.
 */
function findYear(text: string, releasedAt: string): 'exact' | 'near' | null {
  const year = Number(releasedAt.slice(0, 4));
  if (!year) return null;
  const printed = printedYears(text);
  if (printed.includes(year)) return 'exact';
  return printed.some((y) => Math.abs(y - year) === 1) ? 'near' : null;
}

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

  return { collectorNumber, setCode, lang, year: printedYears(text)[0] ?? null, raw };
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
 * Score one candidate against one OCR read: search the text for the signals
 * this printing actually carries, rather than blind-parsing the strip.
 *
 * Two independent signals (4 points) confirm; one alone (2 points) is a
 * ranking hint. The era gate is what makes the weights safe to share across
 * frames — a signal the card cannot carry scores nothing instead of matching
 * some unrelated digits, which on a pre-Exodus card is the difference between
 * "no answer" and a confidently wrong one.
 */
export function scoreCandidate(text: string, c: OcrCandidate): number {
  const has = printedSignals(c.releasedAt);
  const setHit = has.setCode ? findSet(text, c.set) : null;
  const collHit = has.collectorNumber && findCollector(text, c.collectorNumber);
  const yearHit = has.year ? findYear(text, c.releasedAt) : null;
  return (
    (collHit ? 2 : 0) +
    (setHit === 'exact' ? 2 : setHit === 'fuzzy' ? 1 : 0) +
    // The year is a set-level signal, so it corroborates a collector number but
    // never outranks one: on its own it can only say "some printing from 1997".
    (yearHit === 'exact' ? 2 : yearHit === 'near' ? 1 : 0)
  );
}

/**
 * OCR the strip (retrying with bottom-extended re-warps — the art-optimized
 * quad often cuts the collector line) and cross-check against the art
 * candidates. Throws only on worker init failure.
 */
export async function resolveWithOcr(
  result: ScanPipelineResult,
  candidates: OcrCandidate[],
): Promise<OcrResolution> {
  let weak: OcrCandidate | null = null;
  let parsed: ParsedStrip | null = null;
  let attempts = 0;

  // Nothing to read: every candidate predates the copyright line, so the strip
  // holds an artist credit and nothing else that could pick between them. Bail
  // before spinning up the worker rather than spend up to 32 OCR passes and
  // ~10 s confirming that Alpha and Beta look alike.
  if (!candidates.some((c) => printedSignals(c.releasedAt).year)) {
    return { confirmed: null, weak: null, parsed: null, attempts: 0 };
  }

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

      const scored = candidates.map((c) => ({ c, score: scoreCandidate(text, c) }));
      const bestScore = Math.max(0, ...scored.map((s) => s.score));
      const leaders = scored.filter((s) => s.score === bestScore).map((s) => s.c);
      const best = leaders[0] ?? null;

      // A tie between genuinely different printings is not an answer, it is a
      // set of cards the strip cannot tell apart — the year in particular is
      // shared by every set of its vintage, so a lone year read against a
      // Llanowar Elves reprinted three times that decade names all three. On a
      // tie we would be picking the first candidate and calling it a reading.
      // Foil and nonfoil siblings tie by nature (same set, same number,
      // different id) and don't count: finish is the user's pick, not ours.
      const decisive = leaders.every((c) => c.set === best?.set && c.collectorNumber === best?.collectorNumber);

      // Two agreeing signals = confirmed; one alone = a ranking hint only.
      if (!decisive) continue;
      if (bestScore >= 3) return { confirmed: best, weak: null, parsed: parsed ?? p, attempts };
      if (bestScore === 2 && !weak) weak = best;
    }
    }
  }
  return { confirmed: null, weak, parsed, attempts };
}
