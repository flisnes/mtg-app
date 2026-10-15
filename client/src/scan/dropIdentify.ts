import type { OracleCard, Printing, Priced } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrinting, getPrintingsByIds } from '../db/queries.js';
import { filterScanIndex, parseHashBlob, type ScanIndex } from './blob.js';
import { getScanExcludedIds } from './exclusions.js';
import type { Quad } from './geometry.js';
import { CANDIDATE_MAX_DISTANCE, CONFIDENT_MAX_DISTANCE } from './match.js';
import { resolveWithOcr } from './ocr.js';
import { runScanPipeline, type ScanPipelineResult } from './pipeline.js';
import { getUsableScanData } from './store.js';
import type { DropItem } from './dropRead.js';

// Identifying a dropped card image. Cheapest and surest first:
//
// 1. The links. A Scryfall image URL carries the printing's id, a Scryfall card
//    page its set and number, a Gatherer link its multiverse id or set and
//    number. No pixels needed, and it is the exact printing every time.
// 2. The pixels, through the camera scanner's own matcher. A card image off a
//    website is the scanner's best case: already flat, already cropped, so the
//    whole image is the card and no edge detection is needed. A screenshot with
//    the card somewhere in it falls back to detection, like a photo would.
// 3. OCR of the bottom strip when the art alone names several printings (a
//    reprint with the same art), exactly as a camera lock does.

export interface DropMatch {
  printing: Priced<Printing>;
  oracle: Priced<OracleCard>;
  /** The printed language, when the link or the OCR said so. */
  lang?: string;
}

type DropOutcome =
  | { kind: 'match'; match: DropMatch }
  | { kind: 'fail'; reason: string }
  /** Needs the card-art index, which isn't installed yet. */
  | { kind: 'needs-index' };

// ---------------------------------------------------------------- link hints

type LinkHint =
  | { kind: 'id'; id: string }
  | { kind: 'setnum'; set: string; num: string; lang?: string }
  | { kind: 'multiverse'; id: string };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Gatherer's locale path segment to Scryfall's language code. */
const GATHERER_LANGS: Record<string, string> = {
  'en-us': 'en',
  'de-de': 'de',
  'fr-fr': 'fr',
  'it-it': 'it',
  'es-es': 'es',
  'pt-br': 'pt',
  'ja-jp': 'ja',
  'ko-kr': 'ko',
  'ru-ru': 'ru',
  'zh-cn': 'zhs',
  'zh-tw': 'zht',
};

/** Scryfall language codes, for the optional segment in a card page URL. */
const SCRYFALL_LANGS = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht', 'he', 'la', 'grc', 'ar', 'sa', 'ph']);

/** What a URL says about the card it shows, if anything. Exported for tests. */
export function parseCardUrl(raw: string): LinkHint | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // cards.scryfall.io/normal/front/a/b/<id>.jpg, and the older c1/img hosts.
  if (host.endsWith('scryfall.io') || host === 'c1.scryfall.com' || host === 'img.scryfall.com') {
    const id = url.pathname.match(UUID)?.[0];
    return id ? { kind: 'id', id: id.toLowerCase() } : null;
  }
  if (host === 'api.scryfall.com' && seg[0] === 'cards') {
    if (seg[1] === 'multiverse' && /^\d+$/.test(seg[2] ?? '')) return { kind: 'multiverse', id: seg[2]! };
    if (seg[1] && UUID.test(seg[1]) && seg.length === 2) return { kind: 'id', id: seg[1].toLowerCase() };
    if (seg[1] && seg[2]) return { kind: 'setnum', set: seg[1].toLowerCase(), num: seg[2], lang: seg[3] };
    return null;
  }
  // scryfall.com/card/<set>/<number>[/<lang>]/<slug>
  if ((host === 'scryfall.com' || host === 'www.scryfall.com') && seg[0] === 'card' && seg[1] && seg[2]) {
    const lang = seg[3] && SCRYFALL_LANGS.has(seg[3]) && seg.length > 4 ? seg[3] : undefined;
    return { kind: 'setnum', set: seg[1].toLowerCase(), num: seg[2], lang };
  }
  if (host.endsWith('gatherer.wizards.com')) {
    const mv = url.searchParams.get('multiverseid') ?? url.searchParams.get('multiverseId');
    if (mv && /^\d+$/.test(mv)) return { kind: 'multiverse', id: mv };
    // The current site: gatherer.wizards.com/<SET>/<locale>/<number>/<slug>
    const lang = seg[1] ? GATHERER_LANGS[seg[1].toLowerCase()] : undefined;
    if (seg[0] && lang && seg[2]) return { kind: 'setnum', set: seg[0].toLowerCase(), num: seg[2], lang };
    return null;
  }
  return null;
}

interface ScryfallCardLite {
  id: string;
  set: string;
  collector_number: string;
  lang: string;
}

async function fetchScryfall(path: string): Promise<ScryfallCardLite | null> {
  try {
    const res = await fetch(`https://api.scryfall.com${path}`, { headers: { Accept: 'application/json' } });
    return res.ok ? ((await res.json()) as ScryfallCardLite) : null;
  } catch {
    return null;
  }
}

async function printingBySetNum(set: string, num: string): Promise<Priced<Printing> | undefined> {
  const hits = await db.printings
    .where('set')
    .equals(set)
    .filter((p) => p.collectorNumber.toLowerCase() === num.toLowerCase())
    .toArray();
  // The English row where a set prints a number in several languages.
  const p = hits.find((h) => h.lang === 'en') ?? hits[0];
  return p ? getPrinting(p.scryfallId) : undefined;
}

async function withOracle(printing: Priced<Printing> | undefined, lang?: string): Promise<DropMatch | null> {
  if (!printing) return null;
  const oracle = (await getOracleCardsByIds([printing.oracleId])).get(printing.oracleId);
  if (!oracle) return null;
  return { printing, oracle, lang: lang ?? printing.lang };
}

/** A Scryfall printing the slim card DB doesn't carry (most often a non-English
 *  copy): ask Scryfall where it sits, and use the local row for that set and number. */
async function viaScryfall(path: string): Promise<DropMatch | null> {
  const card = await fetchScryfall(path);
  if (!card) return null;
  const local = (await getPrinting(card.id)) ?? (await printingBySetNum(card.set, card.collector_number));
  return withOracle(local, card.lang);
}

async function resolveHint(hint: LinkHint): Promise<DropMatch | null> {
  switch (hint.kind) {
    case 'id': {
      const local = await getPrinting(hint.id);
      return local ? withOracle(local) : viaScryfall(`/cards/${hint.id}`);
    }
    case 'setnum': {
      const local = await printingBySetNum(hint.set, hint.num);
      if (local) return withOracle(local, hint.lang);
      // Gatherer set codes mostly match Scryfall's, but not always.
      return viaScryfall(`/cards/${encodeURIComponent(hint.set)}/${encodeURIComponent(hint.num)}`);
    }
    case 'multiverse':
      return viaScryfall(`/cards/multiverse/${hint.id}`);
  }
}

// ---------------------------------------------------------------- pixels

let indexCache: { version: number; index: Promise<ScanIndex> } | null = null;

/** The installed card-art index, parsed once per version; null when none is installed. */
export async function loadDropIndex(): Promise<ScanIndex | null> {
  const row = await getUsableScanData();
  if (!row) return null;
  if (indexCache?.version !== row.version) {
    indexCache = {
      version: row.version,
      index: getScanExcludedIds().then((ex) => filterScanIndex(parseHashBlob(row.blob), ex)),
    };
  }
  return indexCache.index;
}

const MAX_DIM = 1600; // same cap as the scan harness: a 12 MP ImageData is ~48 MB
const DETECT_WIDTH = 480;

async function loadBitmap(item: DropItem): Promise<ImageBitmap | null> {
  if (item.file) {
    try {
      return await createImageBitmap(item.file, { imageOrientation: 'from-image' });
    } catch {
      /* not a decodable image: try the links */
    }
  }
  // Scryfall serves its images to any site; most others don't, and then the
  // pixels are out of reach (the browser won't let a page read them).
  for (const url of item.urls) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) continue;
      return await createImageBitmap(blob);
    } catch {
      /* CORS or network: next one */
    }
  }
  return null;
}

function toImageData(bmp: ImageBitmap): { full: ImageData; detect: ImageData } {
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // A PNG card has transparent rounded corners; white keeps them out of the
  // way of edge detection on the fallback pass.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const full = ctx.getImageData(0, 0, w, h);
  const small = document.createElement('canvas');
  small.width = DETECT_WIDTH;
  small.height = Math.max(1, Math.round((h * DETECT_WIDTH) / w));
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(canvas, 0, 0, small.width, small.height);
  return { full, detect: sctx.getImageData(0, 0, small.width, small.height) };
}

const topDistance = (r: ScanPipelineResult) => r.match.candidates[0]?.distance ?? Infinity;

/** Hash the image as a whole card first; if that doesn't land, look for a card in it. */
function matchPixels(full: ImageData, detect: ImageData, index: ScanIndex): ScanPipelineResult {
  const whole: Quad = [
    { x: 0, y: 0 },
    { x: full.width, y: 0 },
    { x: full.width, y: full.height },
    { x: 0, y: full.height },
  ];
  const asCard = runScanPipeline({ full, detect, manualQuad: whole }, index);
  if (topDistance(asCard) <= CONFIDENT_MAX_DISTANCE[index.algo]) return asCard;
  const detected = runScanPipeline({ full, detect }, index);
  return topDistance(detected) < topDistance(asCard) ? detected : asCard;
}

async function identifyPixels(item: DropItem, index: ScanIndex): Promise<DropOutcome> {
  const bmp = await loadBitmap(item);
  if (!bmp) {
    return {
      kind: 'fail',
      reason: item.file ? "couldn't open that image" : "that site won't share its image. Save it and drop the file instead",
    };
  }
  const { full, detect } = toImageData(bmp);
  bmp.close();
  const result = matchPixels(full, detect, index);
  const cutoff = CANDIDATE_MAX_DISTANCE[index.algo];
  const close = result.match.candidates.filter((c) => c.distance <= cutoff);
  if (!close.length) return { kind: 'fail', reason: 'no card recognised in it' };

  const printings = await getPrintingsByIds(close.map((c) => c.scryfallId));
  const known = close.filter((c) => printings.has(c.scryfallId));
  if (!known.length) return { kind: 'fail', reason: 'that card isn’t in the card database yet' };

  // Several printings share this art (a reprint): let the bottom strip pick,
  // like the camera does. Within a few bits of the best only: a far-off match
  // isn't a contender, and every extra one is another way to tie.
  const best = known[0]!.distance;
  const contenders = known.filter((c) => c.distance <= best + 6).map((c) => printings.get(c.scryfallId)!);
  const distinct = new Set(contenders.map((p) => `${p.set}|${p.collectorNumber}`));
  let chosen = contenders[0]!;
  let lang: string | undefined;
  if (distinct.size > 1) {
    try {
      const ocr = await resolveWithOcr(
        result,
        contenders.map((p) => ({ scryfallId: p.scryfallId, set: p.set, collectorNumber: p.collectorNumber, releasedAt: p.releasedAt })),
      );
      const hit = ocr.confirmed ?? ocr.weak;
      if (hit) chosen = printings.get(hit.scryfallId) ?? chosen;
      lang = ocr.parsed?.lang ?? undefined;
    } catch {
      /* OCR unavailable: the closest art match stands, and the edition is a tap away */
    }
  }
  const match = await withOracle(chosen, lang);
  return match ? { kind: 'match', match } : { kind: 'fail', reason: 'that card isn’t in the card database yet' };
}

/** Identify one dropped item. Never throws. */
export async function identifyDrop(item: DropItem): Promise<DropOutcome> {
  try {
    for (const url of item.urls) {
      const hint = parseCardUrl(url);
      if (!hint) continue;
      const match = await resolveHint(hint);
      if (match) return { kind: 'match', match };
    }
    const index = await loadDropIndex();
    if (!index) return { kind: 'needs-index' };
    return await identifyPixels(item, index);
  } catch (e) {
    return { kind: 'fail', reason: (e as Error).message || 'something went wrong' };
  }
}
