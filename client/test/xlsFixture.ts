// A writer for the .xls files the reader under test (src/import/purchase/xls.ts)
// has to cope with: a real BIFF8 workbook inside a real Compound File, built
// from plain rows, so the fixture is readable here instead of a binary blob
// checked in from someone's Downloads folder. Only what CardTrader's export
// uses, plus the record kinds the reader guards against: strings through
// the SST (optionally split across a CONTINUE record), NUMBER, RK, BOOLERR,
// and FORMULA cells with a cached number, string or boolean.

export type XlsCell = string | number | boolean | null | { formula: number | string | boolean } | { rk: number };

const SECTOR = 512;
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;

class Bytes {
  private parts: Uint8Array[] = [];
  length = 0;
  u8(n: number) {
    this.push(new Uint8Array([n & 0xff]));
  }
  u16(n: number) {
    this.push(new Uint8Array([n & 0xff, (n >> 8) & 0xff]));
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.push(b);
  }
  f64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    this.push(b);
  }
  push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

const record = (type: number, payload: Uint8Array): Uint8Array => {
  const b = new Bytes();
  b.u16(type);
  b.u16(payload.length);
  b.push(payload);
  return b.bytes();
};

const wideNeeded = (s: string) => [...s].some((c) => c.charCodeAt(0) > 0xff);
const chars = (b: Bytes, s: string, wide: boolean) => {
  for (const c of s) (wide ? b.u16 : b.u8).call(b, c.charCodeAt(0));
};

/** An XLUnicodeString (cch u16, flags u8, chars) as the SST, STRING and BOUNDSHEET records carry it. */
function unicodeString(s: string, shortLength = false): Uint8Array {
  const b = new Bytes();
  const wide = wideNeeded(s);
  if (shortLength) b.u8(s.length);
  else b.u16(s.length);
  b.u8(wide ? 1 : 0);
  chars(b, s, wide);
  return b.bytes();
}

function bof(type: number): Uint8Array {
  const b = new Bytes();
  b.u16(0x0600); // BIFF8
  b.u16(type);
  b.u16(0x0dbb);
  b.u16(0x07cc);
  b.u32(0);
  b.u32(0);
  return record(0x0809, b.bytes());
}

/**
 * The Workbook stream. `splitSst` names an SST string index: that string's
 * characters are cut after the first one and the rest moved into a CONTINUE
 * record, the way Excel spills a long shared-string table.
 */
function workbook(sheetName: string, rows: readonly (readonly XlsCell[])[], splitSst?: number): Uint8Array {
  const sst: string[] = [];
  const sstIndex = (s: string) => {
    let i = sst.indexOf(s);
    if (i < 0) i = sst.push(s) - 1;
    return i;
  };

  // The sheet first, so the SST is complete; the globals go in front of it.
  const sheet = new Bytes();
  sheet.push(bof(0x0010));
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell == null) return;
      const head = new Bytes();
      head.u16(r);
      head.u16(c);
      head.u16(15); // ixfe
      if (typeof cell === 'string') {
        head.u32(sstIndex(cell));
        sheet.push(record(0x00fd, head.bytes()));
      } else if (typeof cell === 'number') {
        head.f64(cell);
        sheet.push(record(0x0203, head.bytes()));
      } else if (typeof cell === 'boolean') {
        head.u8(cell ? 1 : 0);
        head.u8(0);
        sheet.push(record(0x0205, head.bytes()));
      } else if ('rk' in cell) {
        head.u32((cell.rk << 2) | 2);
        sheet.push(record(0x027e, head.bytes()));
      } else {
        const v = cell.formula;
        if (typeof v === 'number') head.f64(v);
        else {
          head.u8(typeof v === 'boolean' ? 1 : 0);
          head.u8(0);
          head.u8(typeof v === 'boolean' ? (v ? 1 : 0) : 0);
          head.u8(0);
          head.u16(0);
          head.u16(0xffff);
        }
        head.u16(0); // grbit
        head.u32(0); // chn
        head.u16(0); // cce: no parsed expression
        sheet.push(record(0x0006, head.bytes()));
        if (typeof v === 'string') sheet.push(record(0x0207, unicodeString(v)));
      }
    });
  });
  sheet.push(record(0x000a, new Uint8Array(0)));

  const sstBody = new Bytes();
  sstBody.u32(sst.length);
  sstBody.u32(sst.length);
  let splitAt = -1;
  let splitWide = false;
  sst.forEach((s, i) => {
    if (i === splitSst && s.length > 1) {
      // Cut after the first character: the CONTINUE starts with a fresh flag byte.
      splitWide = wideNeeded(s);
      splitAt = sstBody.length + 3 + (splitWide ? 2 : 1);
    }
    sstBody.push(unicodeString(s));
  });
  const sstBytes = sstBody.bytes();
  const sstRecords = new Bytes();
  if (splitAt > 0) {
    sstRecords.push(record(0x00fc, sstBytes.subarray(0, splitAt)));
    const cont = new Bytes();
    cont.u8(splitWide ? 1 : 0);
    cont.push(sstBytes.subarray(splitAt));
    sstRecords.push(record(0x003c, cont.bytes()));
  } else sstRecords.push(record(0x00fc, sstBytes));

  const boundsheet = (offset: number) => {
    const b = new Bytes();
    b.u32(offset);
    b.u8(0); // visible
    b.u8(0); // worksheet
    b.push(unicodeString(sheetName, true));
    return record(0x0085, b.bytes());
  };
  const globalsLength = bof(0).length + boundsheet(0).length + sstRecords.length + 4;
  const wb = new Bytes();
  wb.push(bof(0x0005));
  wb.push(boundsheet(globalsLength));
  wb.push(sstRecords.bytes());
  wb.push(record(0x000a, new Uint8Array(0)));
  wb.push(sheet.bytes());
  return wb.bytes();
}

/** The directory entry of a Compound File: a UTF-16 name and where the stream is. */
function dirEntry(name: string, type: number, child: number, start: number, size: number): Uint8Array {
  const e = new Uint8Array(128);
  const v = new DataView(e.buffer);
  [...name].forEach((c, i) => v.setUint16(i * 2, c.charCodeAt(0), true));
  v.setUint16(0x40, (name.length + 1) * 2, true);
  e[0x42] = type;
  e[0x43] = 1; // black
  v.setUint32(0x44, FREE, true);
  v.setUint32(0x48, FREE, true);
  v.setUint32(0x4c, child, true);
  v.setUint32(0x74, start, true);
  v.setUint32(0x78, size, true);
  return e;
}

/**
 * A .xls file holding one worksheet. The Workbook stream is padded to the
 * mini-stream cutoff so it lives in ordinary sectors, as any real export does.
 */
export function buildXls(sheetName: string, rows: readonly (readonly XlsCell[])[], opts: { splitSst?: number } = {}): Uint8Array {
  const records = workbook(sheetName, rows, opts.splitSst);
  // Under 4096 bytes a stream would have to live in the mini stream; pad it
  // past the cutoff (the reader stops at the sheet's EOF, so the zeros are
  // never parsed) so the file is laid out like a real export.
  const stream = new Uint8Array(Math.max(4096, records.length));
  stream.set(records);
  const streamSectors = Math.ceil(stream.length / SECTOR);
  if (streamSectors > 125) throw new Error('fixture too large for one FAT sector');
  // The header, then sector 0 (FAT), 1 (directory) and the stream's sectors.
  const file = new Uint8Array(SECTOR * (3 + streamSectors));
  const v = new DataView(file.buffer);

  // Header: signature, version, sector sizes, one FAT sector at 0, directory at 1.
  file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  v.setUint16(0x18, 0x003e, true);
  v.setUint16(0x1a, 0x0003, true);
  v.setUint16(0x1c, 0xfffe, true);
  v.setUint16(0x1e, 9, true);
  v.setUint16(0x20, 6, true);
  v.setUint32(0x2c, 1, true);
  v.setUint32(0x30, 1, true);
  v.setUint32(0x38, 4096, true);
  v.setUint32(0x3c, END_OF_CHAIN, true);
  v.setUint32(0x40, 0, true);
  v.setUint32(0x44, END_OF_CHAIN, true);
  v.setUint32(0x48, 0, true);
  v.setUint32(0x4c, 0, true);
  for (let i = 1; i < 109; i++) v.setUint32(0x4c + i * 4, FREE, true);

  // FAT (sector 0): itself, the directory, then the stream's chain.
  const fat = SECTOR;
  for (let i = 0; i < SECTOR / 4; i++) v.setUint32(fat + i * 4, FREE, true);
  v.setUint32(fat, FAT_SECTOR, true);
  v.setUint32(fat + 4, END_OF_CHAIN, true);
  for (let s = 2; s < 2 + streamSectors; s++) v.setUint32(fat + s * 4, s + 1 < 2 + streamSectors ? s + 1 : END_OF_CHAIN, true);

  // Directory (sector 1): the root and the Workbook stream.
  file.set(dirEntry('Root Entry', 5, 1, END_OF_CHAIN, 0), 2 * SECTOR);
  file.set(dirEntry('Workbook', 2, FREE, 2, stream.length), 2 * SECTOR + 128);

  file.set(stream, 3 * SECTOR);
  return file;
}
