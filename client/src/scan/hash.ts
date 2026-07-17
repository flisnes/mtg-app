// dHash-64 of card art, bit-identical with scanjob/hashgen.py (which hashes
// Scryfall art crops with Pillow). Both sides:
//   horizontal: grayscale → bilinear resize to 9×8 → bit = px[y][x] > px[y][x+1]
//   vertical:   grayscale → bilinear resize to 8×9 → bit = px[y][x] > px[y+1][x]
//   packing:    MSB-first row-major — bit (63 − (y·8 + x)) = comparison (y, x)
// Grayscale uses Pillow's exact L formula and the resize mirrors Pillow's
// triangle-filter resampling (support scaled by the reduction factor), so a
// clean image hashes within a couple of bits of the server-side value.

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

/** 64-bit hash as two u32 halves (hi = bits 63..32). */
export interface Hash64 {
  hi: number;
  lo: number;
}

export interface DHash {
  h: Hash64;
  /** Vertical variant (blob algo 2). */
  v: Hash64;
}

/** Pillow convert("L"): L = (19595 R + 38470 G + 7471 B + 0x8000) >> 16. */
export function grayscale(img: ImageData): GrayImage {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (19595 * data[p]! + 38470 * data[p + 1]! + 7471 * data[p + 2]! + 0x8000) >> 16;
  }
  return { data: out, width, height };
}

/** Per-axis triangle-filter weights, matching Pillow's resampling geometry. */
function axisWeights(srcSize: number, dstSize: number): { starts: Int32Array; weights: Float32Array; taps: number } {
  const scale = srcSize / dstSize;
  const filterScale = Math.max(scale, 1);
  const support = 1 * filterScale; // triangle filter support = 1
  const taps = Math.ceil(support) * 2 + 1;
  const starts = new Int32Array(dstSize);
  const weights = new Float32Array(dstSize * taps);
  for (let i = 0; i < dstSize; i++) {
    const center = (i + 0.5) * scale;
    let min = Math.floor(center - support);
    if (min < 0) min = 0;
    let max = Math.ceil(center + support);
    if (max > srcSize) max = srcSize;
    starts[i] = min;
    let sum = 0;
    for (let j = min; j < max; j++) {
      const x = (j + 0.5 - center) / filterScale;
      const w = Math.abs(x) < 1 ? 1 - Math.abs(x) : 0;
      weights[i * taps + (j - min)] = w;
      sum += w;
    }
    if (sum > 0) {
      for (let j = 0; j < max - min; j++) weights[i * taps + j] = weights[i * taps + j]! / sum;
    }
  }
  return { starts, weights, taps };
}

/** Two-pass separable bilinear (triangle) resize, Pillow-compatible. */
export function resizeBilinear(src: GrayImage, dw: number, dh: number): GrayImage {
  const xw = axisWeights(src.width, dw);
  const horiz = new Float32Array(dw * src.height);
  for (let y = 0; y < src.height; y++) {
    const row = y * src.width;
    for (let x = 0; x < dw; x++) {
      const start = xw.starts[x]!;
      let acc = 0;
      for (let t = 0; t < xw.taps; t++) {
        const w = xw.weights[x * xw.taps + t]!;
        if (w !== 0) acc += src.data[row + start + t]! * w;
      }
      horiz[y * dw + x] = acc;
    }
  }

  const yw = axisWeights(src.height, dh);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const start = yw.starts[y]!;
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let t = 0; t < yw.taps; t++) {
        const w = yw.weights[y * yw.taps + t]!;
        if (w !== 0) acc += horiz[(start + t) * dw + x]! * w;
      }
      // Pillow rounds resize output back to uint8; match it so near-equal
      // neighbour comparisons land the same way.
      out[y * dw + x] = Math.min(255, Math.max(0, Math.round(acc)));
    }
  }
  return { data: out, width: dw, height: dh };
}

function pack64(bits: (pos: number) => number): Hash64 {
  let hi = 0;
  let lo = 0;
  for (let pos = 0; pos < 32; pos++) hi = ((hi << 1) | bits(pos)) >>> 0;
  for (let pos = 32; pos < 64; pos++) lo = ((lo << 1) | bits(pos)) >>> 0;
  return { hi, lo };
}

export function dhash(gray: GrayImage): DHash {
  const h9 = resizeBilinear(gray, 9, 8);
  const v9 = resizeBilinear(gray, 8, 9);
  const h = pack64((pos) => {
    const y = pos >> 3;
    const x = pos & 7;
    return h9.data[y * 9 + x]! > h9.data[y * 9 + x + 1]! ? 1 : 0;
  });
  const v = pack64((pos) => {
    const y = pos >> 3;
    const x = pos & 7;
    return v9.data[y * 8 + x]! > v9.data[(y + 1) * 8 + x]! ? 1 : 0;
  });
  return { h, v };
}

export function dhashFromImageData(img: ImageData): DHash {
  return dhash(grayscale(img));
}

export function formatHash64(h: Hash64): string {
  return h.hi.toString(16).padStart(8, '0') + h.lo.toString(16).padStart(8, '0');
}
