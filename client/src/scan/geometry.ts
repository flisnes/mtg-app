// Card quad detection + perspective warp (handover §S3, built in S2 because
// the upload test harness needs it). Lightweight custom implementation —
// escalate to OpenCV.js only if this proves unreliable on real photos.
//
// Detection: grayscale → box blur → Otsu threshold (both polarities) →
// connected components → convex hull → Douglas-Peucker down to 4 corners →
// keep the largest quad with a card-ish side ratio.
//
// Warp: homography from the 4 corners, inverse-mapped with bilinear sampling
// in plain JS. ~330k pixels for the canonical card — fine for stills; S3 can
// move this to WebGL if live-camera profiling demands it.

import { grayscale, type GrayImage } from './hash.js';

export interface Point {
  x: number;
  y: number;
}

/** Corners ordered TL, TR, BR, BL in source-image coordinates. */
export type Quad = [Point, Point, Point, Point];

// --- detection ---------------------------------------------------------------

function boxBlur3(src: GrayImage): GrayImage {
  const { width: w, height: h, data } = src;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          sum += data[yy * w + xx]!;
          n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return { data: out, width: w, height: h };
}

function histogram(gray: GrayImage): Float64Array {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.data.length; i++) {
    const bucket = gray.data[i]! & 255;
    hist[bucket] = hist[bucket]! + 1;
  }
  return hist;
}

/** Gray level below which `fraction` of the pixels fall. */
function percentileLevel(hist: Float64Array, total: number, fraction: number): number {
  let acc = 0;
  for (let t = 0; t < 256; t++) {
    acc += hist[t]!;
    if (acc >= total * fraction) return t;
  }
  return 255;
}

function otsuThreshold(hist: Float64Array, total: number): number {
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let best = 127;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/**
 * Boundaries of the largest connected components of `mask`, ranked by
 * bounding-box extent (NOT pixel count — a card's border reads as a thin ring
 * with few pixels but card-sized extent). Components below `minPixels` are
 * noise and skipped.
 */
function componentBoundaries(mask: Uint8Array, w: number, h: number, minPixels: number, maxComponents: number): Point[][] {
  const label = new Int32Array(w * h); // 0 = unvisited
  const stack = new Int32Array(w * h);
  const comps: { label: number; extent: number }[] = [];
  let next = 1;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const cur = next++;
    let area = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let top = 0;
    stack[top++] = start;
    label[start] = cur;
    while (top > 0) {
      const p = stack[--top]!;
      area++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) {
        label[p - 1] = cur;
        stack[top++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) {
        label[p + 1] = cur;
        stack[top++] = p + 1;
      }
      if (p >= w && mask[p - w] && !label[p - w]) {
        label[p - w] = cur;
        stack[top++] = p - w;
      }
      if (p < w * (h - 1) && mask[p + w] && !label[p + w]) {
        label[p + w] = cur;
        stack[top++] = p + w;
      }
    }
    // Frame-hugging components are the background, not the card: their hull
    // spans the whole photo and pushes card-shaped quads out of the ranking.
    const spansFrame = maxX - minX + 1 >= w * 0.95 && maxY - minY + 1 >= h * 0.95;
    const touchesAllEdges = minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1;
    if (area >= minPixels && !spansFrame && !touchesAllEdges) {
      comps.push({ label: cur, extent: (maxX - minX + 1) * (maxY - minY + 1) });
    }
  }

  comps.sort((a, b) => b.extent - a.extent);
  const wanted = comps.slice(0, maxComponents);
  const boundaries = new Map<number, Point[]>(wanted.map((c) => [c.label, []]));
  for (let p = 0; p < label.length; p++) {
    const pts = boundaries.get(label[p]!);
    if (!pts) continue;
    const x = p % w;
    const y = (p - x) / w;
    if (
      x === 0 ||
      x === w - 1 ||
      y === 0 ||
      y === h - 1 ||
      label[p - 1] !== label[p] ||
      label[p + 1] !== label[p] ||
      label[p - w] !== label[p] ||
      label[p + w] !== label[p]
    ) {
      pts.push({ x, y });
    }
  }
  return wanted.map((c) => boundaries.get(c.label)!);
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew monotone chain, counter-clockwise in image coords (y down → visually clockwise). */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
}

/** Douglas-Peucker on an open polyline. */
function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  let maxD = 0;
  let maxI = 0;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i]!, a, b);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD <= epsilon) return [a, b];
  const left = simplify(points.slice(0, maxI + 1), epsilon);
  const right = simplify(points.slice(maxI), epsilon);
  return left.slice(0, -1).concat(right);
}

/** Closed-polygon simplification to exactly 4 corners, if possible. */
function approxQuad(hull: Point[]): Quad | null {
  if (hull.length < 4) return null;
  const perimeter = hull.reduce((s, p, i) => s + Math.hypot(p.x - hull[(i + 1) % hull.length]!.x, p.y - hull[(i + 1) % hull.length]!.y), 0);
  // Split the ring at its two most distant points so DP sees two open lines.
  let ai = 0;
  let bi = 0;
  let maxD = -1;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = (hull[i]!.x - hull[j]!.x) ** 2 + (hull[i]!.y - hull[j]!.y) ** 2;
      if (d > maxD) {
        maxD = d;
        ai = i;
        bi = j;
      }
    }
  }
  const ring = hull.slice(ai).concat(hull.slice(0, ai));
  const cut = (bi - ai + hull.length) % hull.length;
  const half1 = ring.slice(0, cut + 1);
  const half2 = ring.slice(cut).concat([ring[0]!]);

  for (let eps = perimeter * 0.01; eps < perimeter * 0.12; eps *= 1.4) {
    const poly = simplify(half1, eps).slice(0, -1).concat(simplify(half2, eps).slice(0, -1));
    if (poly.length === 4) return poly as Quad;
    if (poly.length < 4) break;
  }
  return null;
}

function orderQuad(q: Quad): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const sorted = [...q].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  // sorted is clockwise in screen coords starting anywhere; rotate so index 0 = TL
  let tl = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i]!.x + sorted[i]!.y;
    if (s < best) {
      best = s;
      tl = i;
    }
  }
  return [sorted[tl]!, sorted[(tl + 1) % 4]!, sorted[(tl + 2) % 4]!, sorted[(tl + 3) % 4]!] as Quad;
}

/**
 * Rotate the corner order so sides TL-TR / BR-BL are the short (width) pair —
 * a card lying sideways in the photo then warps to upright portrait.
 */
export function orientQuadPortrait(q: Quad): Quad {
  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const horiz = (side(q[0], q[1]) + side(q[2], q[3])) / 2;
  const vert = (side(q[1], q[2]) + side(q[3], q[0])) / 2;
  return horiz <= vert ? q : ([q[1], q[2], q[3], q[0]] as Quad);
}

function quadArea(q: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** Side-ratio sanity: card is 63:88 ≈ 0.716; perspective bends this, be generous. */
function cardLikeRatio(q: Quad): boolean {
  const side = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const s01 = side(q[0], q[1]);
  const s12 = side(q[1], q[2]);
  const s23 = side(q[2], q[3]);
  const s30 = side(q[3], q[0]);
  const w = (s01 + s23) / 2;
  const h = (s12 + s30) / 2;
  if (w === 0 || h === 0) return false;
  const ratio = Math.min(w, h) / Math.max(w, h);
  return ratio > 0.5 && ratio < 0.92;
}

/** Grow (or shrink) a quad about its centroid — e.g. +0.055 recovers the black
 * border when thresholding found the card's inner frame instead of its edge. */
export function expandQuad(q: Quad, fraction: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: cx + (p.x - cx) * (1 + fraction), y: cy + (p.y - cy) * (1 + fraction) })) as unknown as Quad;
}

/**
 * Push one side of the quad outward by `fraction` of the adjacent side length
 * (e.g. extend 'bottom' to recover a card bottom band the detection cut short).
 */
export function extendQuadSide(q: Quad, side: 'top' | 'bottom', fraction: number): Quad {
  const push = (corner: Point, from: Point): Point => ({
    x: corner.x + (corner.x - from.x) * fraction,
    y: corner.y + (corner.y - from.y) * fraction,
  });
  if (side === 'bottom') {
    // BL/BR move away from TL/TR.
    return [q[0], q[1], push(q[2], q[1]), push(q[3], q[0])] as Quad;
  }
  return [push(q[0], q[3]), push(q[1], q[2]), q[2], q[3]] as Quad;
}

function sameQuad(a: Quad, b: Quad, tolerance: number): boolean {
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y) > tolerance) return false;
  }
  return true;
}

/**
 * Candidate card quads in an image (pass a downscaled frame, ~480px wide),
 * largest first, corners TL,TR,BR,BL. Thresholding a photo is ambiguous
 * (dark card border on a dark mat, bright inner frame on a dark card…), so
 * several thresholds × both polarities each nominate components; the caller
 * disambiguates by trying the hypotheses against the hash index.
 */
export function detectCardQuads(img: ImageData, maxCandidates = 4): Quad[] {
  const gray = boxBlur3(grayscale(img));
  const { width: w, height: h } = gray;
  const hist = histogram(gray);
  const total = w * h;
  const minArea = total * 0.1;
  const maxArea = total * 0.95;

  const thresholds = [...new Set([
    otsuThreshold(hist, total),
    percentileLevel(hist, total, 0.15),
    percentileLevel(hist, total, 0.85),
  ])];

  const found: { quad: Quad; area: number }[] = [];
  for (const threshold of thresholds) {
    for (const bright of [true, false]) {
      const mask = new Uint8Array(total);
      for (let i = 0; i < total; i++) {
        mask[i] = (bright ? gray.data[i]! > threshold : gray.data[i]! <= threshold) ? 1 : 0;
      }
      for (const boundary of componentBoundaries(mask, w, h, total * 0.002, 3)) {
        const hull = convexHull(boundary);
        const quad = approxQuad(hull);
        if (!quad) continue;
        const ordered = orientQuadPortrait(orderQuad(quad));
        const area = quadArea(ordered);
        if (area < minArea || area > maxArea || !cardLikeRatio(ordered)) continue;
        if (found.some((f) => sameQuad(f.quad, ordered, Math.sqrt(total) * 0.02))) continue;
        found.push({ quad: ordered, area });
      }
    }
  }
  found.sort((a, b) => b.area - a.area);
  return found.slice(0, maxCandidates).map((f) => f.quad);
}

// --- warp ---------------------------------------------------------------------

/**
 * Homography mapping (0,0),(w,0),(w,h),(0,h) → quad TL,TR,BR,BL.
 * Returns the 3×3 matrix rows-first [a,b,c,d,e,f,g,h,1].
 */
export function homographyTo(quad: Quad, w: number, h: number): Float64Array {
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  // Standard 8×8 linear system A·x = b for the 8 homography unknowns.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i]!;
    const d = quad[i]!;
    A.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y]);
    b.push(d.y);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    }
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    const p = A[col]![col]!;
    if (Math.abs(p) < 1e-12) throw new Error('degenerate quad');
    for (let r = col + 1; r < 8; r++) {
      const f = A[r]![col]! / p;
      for (let c = col; c < 8; c++) A[r]![c]! -= f * A[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Float64Array(8);
  for (let r = 7; r >= 0; r--) {
    let sum = b[r]!;
    for (let c = r + 1; c < 8; c++) sum -= A[r]![c]! * x[c]!;
    x[r] = sum / A[r]![r]!;
  }
  return new Float64Array([x[0]!, x[1]!, x[2]!, x[3]!, x[4]!, x[5]!, x[6]!, x[7]!, 1]);
}

/** Perspective-warp `quad` in src to an upright w×h ImageData (bilinear sampling). */
export function warpPerspective(src: ImageData, quad: Quad, w: number, h: number): ImageData {
  const H = homographyTo(quad, w, h);
  const out = new ImageData(w, h);
  const sd = src.data;
  const od = out.data;
  const sw = src.width;
  const sh = src.height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const den = H[6]! * cx + H[7]! * cy + 1;
      const sx = (H[0]! * cx + H[1]! * cy + H[2]!) / den - 0.5;
      const sy = (H[3]! * cx + H[4]! * cy + H[5]!) / den - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (y * w + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        od[o + 3] = 255;
        continue;
      }
      const p00 = (y0 * sw + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + sw * 4;
      const p11 = p01 + 4;
      for (let c = 0; c < 3; c++) {
        od[o + c] =
          sd[p00 + c]! * (1 - fx) * (1 - fy) +
          sd[p10 + c]! * fx * (1 - fy) +
          sd[p01 + c]! * (1 - fx) * fy +
          sd[p11 + c]! * fx * fy;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

/**
 * 180° rotation of a whole ImageData. An upside-down card warps to an
 * upside-down canonical rect — rotate BEFORE cropping (the art box would
 * otherwise cut the wrong end of the card), then hash both orientations.
 */
export function rotateImageData180(src: ImageData): ImageData {
  const out = new ImageData(src.width, src.height);
  const n = src.width * src.height;
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    const d = (n - 1 - i) * 4;
    out.data[d] = src.data[s]!;
    out.data[d + 1] = src.data[s + 1]!;
    out.data[d + 2] = src.data[s + 2]!;
    out.data[d + 3] = 255;
  }
  return out;
}

/** Extract a crop box (fractions) from an ImageData. */
export function cropImageData(src: ImageData, box: { x0: number; y0: number; x1: number; y1: number }): ImageData {
  const x = Math.round(box.x0 * src.width);
  const y = Math.round(box.y0 * src.height);
  const w = Math.round((box.x1 - box.x0) * src.width);
  const h = Math.round((box.y1 - box.y0) * src.height);
  const out = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y + row) * src.width + x) * 4;
    out.data.set(src.data.subarray(srcOff, srcOff + w * 4), row * w * 4);
  }
  return out;
}
