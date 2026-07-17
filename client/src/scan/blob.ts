// Parser for cardhashes.bin (format defined in scanjob/hashgen.py — keep in
// sync). Little-endian: 16-byte header (magic "BNDH", u32 format version,
// u16 algo, u16 reserved, u32 count), then per record: u64 hashH,
// [u64 hashV when algo=2], 16-byte scryfall UUID, u8 faceIndex, 7 pad bytes.
//
// Hashes are split into u32 pairs (hi = top 32 bits) so the Hamming search
// never touches BigInt on the hot path.

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

  for (let i = 0; i < count; i++) {
    let off = 16 + i * stride;
    hLo[i] = view.getUint32(off, true);
    hHi[i] = view.getUint32(off + 4, true);
    off += 8;
    if (algo === 2) {
      vLo[i] = view.getUint32(off, true);
      vHi[i] = view.getUint32(off + 4, true);
      off += 8;
    }
    ids.set(bytes.subarray(off, off + 16), i * 16);
    faces[i] = bytes[off + 16]!;
  }

  return { algo, count, hHi, hLo, vHi, vLo, ids, faces };
}
