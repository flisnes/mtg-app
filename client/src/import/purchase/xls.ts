// A reader for legacy Excel (.xls, BIFF8) workbooks: just enough to get the
// cells of the first sheet out of the export CardTrader hands you. Strings,
// numbers and booleans; no formulas, styles or dates. SheetJS would do it,
// but its npm release carries unpatched advisories and is ~400 KB for a job
// this size.
//
// Two layers: the Compound File container (a little FAT filesystem) holds a
// "Workbook" stream, and that stream is a run of BIFF records.

export interface XlsSheet {
  name: string;
  rows: (string | number | boolean | null)[][];
}

const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

const NOT_XLS = 'Not an .xls file';

/** Pull one named stream out of a Compound File (OLE2) container. */
function readCfbStream(buf: Uint8Array, wanted: string[]): Uint8Array {
  // The header alone is 512 bytes; anything shorter has no signature to check.
  if (buf.byteLength < 512) throw new Error(NOT_XLS);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0, true) !== 0xe011cfd0 || v.getUint32(4, true) !== 0xe11ab1a1) {
    throw new Error(NOT_XLS);
  }
  const secSize = 1 << v.getUint16(0x1e, true);
  const miniSecSize = 1 << v.getUint16(0x20, true);
  const firstDir = v.getUint32(0x30, true);
  const miniCutoff = v.getUint32(0x38, true);
  const firstMiniFat = v.getUint32(0x3c, true);
  let difatNext = v.getUint32(0x44, true);
  const off = (sec: number) => (sec + 1) * secSize;

  // The FAT's own sectors: 109 listed in the header, the rest in a DIFAT chain.
  const fatSecs: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = v.getUint32(0x4c + i * 4, true);
    if (s !== FREE) fatSecs.push(s);
  }
  for (let guard = 0; difatNext !== END_OF_CHAIN && difatNext !== FREE && guard < 10_000; guard++) {
    const base = off(difatNext);
    for (let i = 0; i < secSize / 4 - 1; i++) {
      const s = v.getUint32(base + i * 4, true);
      if (s !== FREE) fatSecs.push(s);
    }
    difatNext = v.getUint32(base + secSize - 4, true);
  }
  // A sector the file is too short to hold: a truncated download, or a FAT
  // entry that was never one. Either way there is nothing there to read.
  const inFile = (sec: number) => off(sec) + secSize <= buf.byteLength;
  const fat: number[] = [];
  for (const s of fatSecs) {
    if (!inFile(s)) throw new Error(NOT_XLS);
    for (let i = 0; i < secSize / 4; i++) fat.push(v.getUint32(off(s) + i * 4, true));
  }

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    for (let s = start; s !== END_OF_CHAIN && s !== FREE && out.length <= table.length; s = table[s] ?? END_OF_CHAIN) out.push(s);
    return out;
  };
  const readChain = (start: number): Uint8Array => {
    const secs = chain(start, fat);
    const out = new Uint8Array(secs.length * secSize);
    secs.forEach((s, i) => {
      if (!inFile(s)) throw new Error(NOT_XLS);
      out.set(buf.subarray(off(s), off(s) + secSize), i * secSize);
    });
    return out;
  };

  const dir = readChain(firstDir);
  const dv = new DataView(dir.buffer);
  let root: { start: number; size: number } | null = null;
  let found: { start: number; size: number } | null = null;
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dv.getUint16(p + 0x40, true);
    const type = dir[p + 0x42];
    let name = '';
    for (let i = 0; i + 2 < nameLen; i += 2) name += String.fromCharCode(dv.getUint16(p + i, true));
    const entry = { start: dv.getUint32(p + 0x74, true), size: dv.getUint32(p + 0x78, true) };
    if (type === 5) root = entry;
    else if (type === 2 && wanted.includes(name) && !found) found = entry;
  }
  if (!found) throw new Error('No workbook in this .xls file');

  if (found.size >= miniCutoff) return readChain(found.start).subarray(0, found.size);
  // Small streams live in the mini stream (inside the root entry's chain).
  if (!root) throw new Error('Damaged .xls file');
  const miniStream = readChain(root.start);
  const miniFatBytes = readChain(firstMiniFat);
  const mfv = new DataView(miniFatBytes.buffer);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mfv.getUint32(i, true));
  const secs = chain(found.start, miniFat);
  const out = new Uint8Array(secs.length * miniSecSize);
  secs.forEach((s, i) => {
    if ((s + 1) * miniSecSize > miniStream.length) throw new Error(NOT_XLS);
    out.set(miniStream.subarray(s * miniSecSize, (s + 1) * miniSecSize), i * miniSecSize);
  });
  return out.subarray(0, found.size);
}

/** An RK number: a packed integer or a truncated double, optionally /100. */
function rk(n: number): number {
  let val: number;
  if (n & 2) {
    val = n >> 2;
  } else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, n & 0xfffffffc, true);
    val = b.getFloat64(0, true);
  }
  return n & 1 ? val / 100 : val;
}

/**
 * Read a run of characters that may straddle CONTINUE records. At each record
 * boundary BIFF8 restarts the run with a fresh one-byte flag saying whether
 * the rest is 8-bit or 16-bit. Reading past the end is a damaged file, not a
 * NaN: every read checks.
 */
class Cursor {
  constructor(
    private data: Uint8Array,
    /** Offsets where a CONTINUE record's payload begins. */
    private breaks: number[],
    public pos = 0,
  ) {}
  private need(n: number) {
    if (this.pos + n > this.data.length) throw new Error(NOT_XLS);
  }
  u8() {
    this.need(1);
    return this.data[this.pos++]!;
  }
  u16() {
    this.need(2);
    const n = this.data[this.pos]! | (this.data[this.pos + 1]! << 8);
    this.pos += 2;
    return n;
  }
  u32() {
    const n = (this.u16() | (this.u16() << 16)) >>> 0;
    return n;
  }
  chars(count: number, wide: boolean): string {
    let s = '';
    for (let i = 0; i < count; i++) {
      if (i > 0 && this.breaks.includes(this.pos)) wide = (this.u8() & 1) === 1;
      s += String.fromCharCode(wide ? this.u16() : this.u8());
    }
    return s;
  }
  /** XLUnicodeRichExtendedString (the SST's entries). */
  richString(): string {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 8 ? this.u16() : 0;
    const ext = flags & 4 ? this.u32() : 0;
    const s = this.chars(cch, (flags & 1) === 1);
    this.pos += runs * 4 + ext;
    return s;
  }
}

/**
 * The first worksheet of a BIFF8 .xls workbook, as rows of cell values. A
 * file that isn't one, or is cut short, fails with one plain message rather
 * than whatever the byte it tripped over had to say.
 */
export function readXls(input: ArrayBuffer | Uint8Array): XlsSheet {
  try {
    return readWorkbook(input instanceof Uint8Array ? input : new Uint8Array(input));
  } catch (err) {
    // A RangeError is a DataView read past the end: the same damaged file.
    if (err instanceof RangeError || (err instanceof Error && err.message === NOT_XLS)) {
      throw new Error("Couldn't read this .xls file", { cause: err });
    }
    throw err;
  }
}

function readWorkbook(buf: Uint8Array): XlsSheet {
  const wb = readCfbStream(buf, ['Workbook', 'Book']);
  const v = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);

  const sst: string[] = [];
  const sheetNames: string[] = [];
  const cells = new Map<number, Map<number, string | number | boolean>>();
  const set = (row: number, col: number, val: string | number | boolean) => {
    if (!cells.has(row)) cells.set(row, new Map());
    cells.get(row)!.set(col, val);
  };
  // A FORMULA whose result is a string puts it in the STRING record after it.
  let formulaString: { row: number; col: number } | null = null;

  let p = 0;
  let substream = 0; // 1 = workbook globals, 2 = the first worksheet
  while (p + 4 <= wb.length) {
    const type = v.getUint16(p, true);
    const len = v.getUint16(p + 2, true);
    const at = p + 4;
    p = at + len;
    if (p > wb.length) throw new Error(NOT_XLS);
    if (type === 0x0809) {
      // BOF: the globals first, then one substream per sheet.
      substream++;
      if (substream > 2) break;
      continue;
    }
    if (substream === 1 && type === 0x0085 && len >= 8) {
      // BOUNDSHEET: offset(4) visibility(1) type(1) ShortXLUnicodeString
      const cch = wb[at + 6]!;
      const wide = (wb[at + 7]! & 1) === 1;
      const c = new Cursor(wb, [], at + 8);
      sheetNames.push(c.chars(cch, wide));
    } else if (substream === 1 && type === 0x00fc) {
      // SST, plus however many CONTINUE records it spills into.
      const parts = [wb.subarray(at, at + len)];
      const breaks: number[] = [];
      let total = len;
      while (p + 4 <= wb.length && v.getUint16(p, true) === 0x003c) {
        const clen = v.getUint16(p + 2, true);
        breaks.push(total);
        parts.push(wb.subarray(p + 4, p + 4 + clen));
        total += clen;
        p += 4 + clen;
      }
      const data = new Uint8Array(total);
      let o = 0;
      for (const part of parts) {
        data.set(part, o);
        o += part.length;
      }
      const c = new Cursor(data, breaks);
      c.u32(); // total references
      const unique = c.u32();
      for (let i = 0; i < unique && c.pos < data.length; i++) sst.push(c.richString());
    } else if (substream === 2) {
      if (type === 0x000a) break; // EOF of the first sheet
      if (type === 0x0207 && formulaString) {
        // STRING: the text result of the FORMULA just before it.
        const cch = v.getUint16(at, true);
        set(formulaString.row, formulaString.col, new Cursor(wb, [], at + 3).chars(cch, (wb[at + 2]! & 1) === 1));
        formulaString = null;
        continue;
      }
      formulaString = null;
      if (len < 4) continue;
      const row = v.getUint16(at, true);
      const col = v.getUint16(at + 2, true);
      if (type === 0x00fd && len >= 10) set(row, col, sst[v.getUint32(at + 6, true)] ?? '');
      else if (type === 0x0203 && len >= 14) set(row, col, v.getFloat64(at + 6, true));
      else if (type === 0x027e && len >= 10) set(row, col, rk(v.getUint32(at + 6, true)));
      else if (type === 0x0205 && len >= 8) {
        if (wb[at + 7] === 0) set(row, col, wb[at + 6] === 1);
      } else if (type === 0x0204 && len >= 9) {
        const cch = v.getUint16(at + 6, true);
        set(row, col, new Cursor(wb, [], at + 9).chars(cch, (wb[at + 8]! & 1) === 1));
      } else if (type === 0x0006 && len >= 14) {
        // FORMULA: its cached result is a number unless the last two bytes
        // are 0xFFFF, when the first says string (0, in the STRING record
        // that follows), boolean (1) or error (2, left blank).
        if (v.getUint16(at + 12, true) === 0xffff) {
          const kind = wb[at + 6];
          if (kind === 0) formulaString = { row, col };
          else if (kind === 1) set(row, col, wb[at + 8] === 1);
        } else set(row, col, v.getFloat64(at + 6, true));
      } else if (type === 0x00bd && len >= 6) {
        // MULRK: a row of RK numbers, each (xf, rk), last column at the end.
        const last = v.getUint16(at + len - 2, true);
        for (let c = col; c <= last && at + 4 + (c - col) * 6 + 6 <= at + len - 2; c++) {
          set(row, c, rk(v.getUint32(at + 4 + (c - col) * 6 + 2, true)));
        }
      }
    }
  }

  const maxRow = Math.max(-1, ...cells.keys());
  const rows: XlsSheet['rows'] = [];
  for (let r = 0; r <= maxRow; r++) {
    const line = cells.get(r);
    const width = line ? Math.max(...line.keys()) + 1 : 0;
    rows.push(Array.from({ length: width }, (_, c) => line?.get(c) ?? null));
  }
  return { name: sheetNames[0] ?? '', rows };
}
