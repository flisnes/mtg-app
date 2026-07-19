// Parser for cardhashes.bin (format defined in scanjob/hashgen.py — keep in
// sync). Little-endian: 16-byte header (magic "BNDH", u32 format version,
// u16 algo, u16 reserved, u32 count), then per record: u64 hashH,
// [u64 hashV when algo=2], 16-byte scryfall UUID, u8 faceIndex, 7 pad bytes.
//
// Hashes are split into u32 pairs (hi = top 32 bits) so the Hamming search
// never touches BigInt on the hot path.

import { popcount32 } from './hash.js';

/**
 * Records whose combined H+V popcount is below this are dropped at parse
 * time. A near-zero hash means the source art is blank (Mystery Booster
 * playtest cards like Whiteout, empty card frames), and every flat surface
 * the camera sees — a table, a wall — hashes to the same degenerate value,
 * so these records match everything featureless at distance ~0. Measured on
 * the 110k blob: 8 records sit at popcount ≤ 9 (all blank art), then a clean
 * gap until 16.
 */
export const MIN_RECORD_POPCOUNT = 10;

export interface ScanIndex {
  algo: 1 | 2;
  count: number;
  hHi: Uint32Array;
  hLo: Uint32Array;
  /** Empty arrays when algo = 1. */
  vHi: Uint32Array;
  vLo: Uint32Array;
  /** 16 bytes per record. */
  ids: Uint8Array;
  faces: Uint8Array;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Canonical dashed-hex scryfallId of record i (matches Printing.scryfallId). */
export function scryfallIdAt(index: ScanIndex, i: number): string {
  const b = index.ids;
  const o = i * 16;
  let s = '';
  for (let j = 0; j < 16; j++) {
    if (j === 4 || j === 6 || j === 8 || j === 10) s += '-';
    s += HEX[b[o + j]!]!;
  }
  return s;
}

/**
 * Drop records for excluded printings (e.g. playtest cards, see
 * scan/exclusions.ts) so they can neither drive a consensus lock nor appear
 * as candidates. One-time cost at index load, not on the search hot path.
 */
export function filterScanIndex(index: ScanIndex, excluded: ReadonlySet<string>): ScanIndex {
  if (!excluded.size) return index;
  const algo2 = index.algo === 2;
  const hHi = new Uint32Array(index.count);
  const hLo = new Uint32Array(index.count);
  const vHi = new Uint32Array(algo2 ? index.count : 0);
  const vLo = new Uint32Array(algo2 ? index.count : 0);
  const ids = new Uint8Array(index.count * 16);
  const faces = new Uint8Array(index.count);

  let n = 0;
  for (let i = 0; i < index.count; i++) {
    if (excluded.has(scryfallIdAt(index, i))) continue;
    hHi[n] = index.hHi[i]!;
    hLo[n] = index.hLo[i]!;
    if (algo2) {
      vHi[n] = index.vHi[i]!;
      vLo[n] = index.vLo[i]!;
    }
    ids.set(index.ids.subarray(i * 16, i * 16 + 16), n * 16);
    faces[n] = index.faces[i]!;
    n++;
  }

  return {
    algo: index.algo,
    count: n,
    hHi: hHi.subarray(0, n),
    hLo: hLo.subarray(0, n),
    vHi: vHi.subarray(0, algo2 ? n : 0),
    vLo: vLo.subarray(0, algo2 ? n : 0),
    ids: ids.subarray(0, n * 16),
    faces: faces.subarray(0, n),
  };
}

export function parseHashBlob(buf: ArrayBuffer): ScanIndex {
  const view = new DataView(buf);
  if (buf.byteLength < 16) throw new Error('scan blob truncated');
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'BNDH') throw new Error('scan blob: bad magic');
  const formatVersion = view.getUint32(4, true);
  if (formatVersion !== 1) throw new Error(`scan blob: unknown format version ${formatVersion}`);
  const algo = view.getUint16(8, true);
  if (algo !== 1 && algo !== 2) throw new Error(`scan blob: unknown algo ${algo}`);
  const count = view.getUint32(12, true);
  const stride = algo === 2 ? 40 : 32;
  if (buf.byteLength !== 16 + count * stride) throw new Error('scan blob: size mismatch');

  const hHi = new Uint32Array(count);
  const hLo = new Uint32Array(count);
  const vHi = new Uint32Array(algo === 2 ? count : 0);
  const vLo = new Uint32Array(algo === 2 ? count : 0);
  const ids = new Uint8Array(count * 16);
  const faces = new Uint8Array(count);
  const bytes = new Uint8Array(buf);

  let n = 0;
  for (let i = 0; i < count; i++) {
    let off = 16 + i * stride;
    const rhLo = view.getUint32(off, true);
    const rhHi = view.getUint32(off + 4, true);
    off += 8;
    let rvLo = 0;
    let rvHi = 0;
    if (algo === 2) {
      rvLo = view.getUint32(off, true);
      rvHi = view.getUint32(off + 4, true);
      off += 8;
    }
    const pop = popcount32(rhLo) + popcount32(rhHi) + popcount32(rvLo) + popcount32(rvHi);
    if (pop < MIN_RECORD_POPCOUNT) continue;
    hLo[n] = rhLo;
    hHi[n] = rhHi;
    if (algo === 2) {
      vLo[n] = rvLo;
      vHi[n] = rvHi;
    }
    ids.set(bytes.subarray(off, off + 16), n * 16);
    faces[n] = bytes[off + 16]!;
    n++;
  }

  return {
    algo,
    count: n,
    hHi: hHi.subarray(0, n),
    hLo: hLo.subarray(0, n),
    vHi: vHi.subarray(0, algo === 2 ? n : 0),
    vLo: vLo.subarray(0, algo === 2 ? n : 0),
    ids: ids.subarray(0, n * 16),
    faces: faces.subarray(0, n),
  };
}
