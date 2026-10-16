import type { Condition, Finish } from '@mtg/shared';

// Marketplace order files → one PurchaseOrder. Four shapes so far:
//
//   Cardmarket CSV  "ArticlesFromShipment<order>.csv": product ids, no names,
//                   no date. The ids are exact, so it's the best of the four.
//   Cardmarket PDF  the purchase page saved as PDF: names, set codes and the
//                   paid date. Set codes are Cardmarket's own (ZNL is The List).
//   CardTrader XLS  one row per copy, Scryfall set codes, price in cents. No
//                   date column, but the order code starts with the date.
//   CardTrader PDF  the packing slip: names, set names, line totals.
//
// Every price ends up per copy, in EUR cents. Each parser is pure: the PDF
// ones take text already laid out in rows (pdfText.ts), the XLS one cells
// (xls.ts), so all of them can be tested on plain data.

export type PurchaseSource = 'cardmarket' | 'cardtrader';
export type PurchaseFileKind = 'csv' | 'xls' | 'pdf';

export interface PurchaseLine {
  /** As the file prints it. Absent on a Cardmarket CSV, which only has ids. */
  name?: string;
  /** The marketplace's own set code (CardTrader's mostly match Scryfall's). */
  setCode?: string;
  setName?: string;
  collectorNumber?: string;
  cardmarketId?: number;
  quantity: number;
  /** Paid per copy, EUR cents. */
  unitCents: number;
  condition: Condition;
  /** The grade as the marketplace wrote it ("EX", "Slightly Played"). */
  conditionLabel: string;
  finish: Finish;
  lang: string;
}

export interface PurchaseOrder {
  source: PurchaseSource;
  fileKind: PurchaseFileKind;
  /** The marketplace's order number/code, when the file names one. */
  orderId: string | null;
  /** When it was bought (UTC noon of that day), when the file says. */
  date: number | null;
  seller?: string;
  lines: PurchaseLine[];
}

/** A text line of a PDF: its words left to right, with where they start. */
export interface PdfRow {
  page: number;
  y: number;
  words: { x: number; s: string }[];
}

const noon = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
const cents = (s: string) => Math.round(parseFloat(s.replace(/[^\d.,-]/g, '').replace(',', '.')) * 100);

// ---------------------------------------------------------------------------
// Grades. Neither marketplace's scale is ours; these are the usual crossings.
// ---------------------------------------------------------------------------

/** Cardmarket: Mint, Near Mint, Excellent, Good, Light Played, Played, Poor. */
const CARDMARKET_GRADES: Record<string, Condition> = {
  MT: 'NM', NM: 'NM', EX: 'LP', GD: 'MP', LP: 'MP', PL: 'HP', PO: 'DMG',
};
/** The CSV numbers the same scale 1-7. */
const CARDMARKET_GRADE_CODES = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

const CARDTRADER_GRADES: Record<string, Condition> = {
  'mint': 'NM', 'near mint': 'NM', 'slightly played': 'LP', 'moderately played': 'MP',
  'played': 'HP', 'heavily played': 'HP', 'poor': 'DMG',
  M: 'NM', NM: 'NM', SP: 'LP', MP: 'MP', PL: 'HP', HP: 'HP', PO: 'DMG',
};

/** Cardmarket's language ids (CSV) and the codes its PDF prints. */
const CARDMARKET_LANG_IDS: Record<number, string> = {
  1: 'en', 2: 'fr', 3: 'de', 4: 'es', 5: 'it', 6: 'zhs', 7: 'ja', 8: 'pt', 9: 'ru', 10: 'ko', 11: 'zht',
};
const LANG_CODES: Record<string, string> = {
  EN: 'en', FR: 'fr', DE: 'de', ES: 'es', IT: 'it', PT: 'pt', JP: 'ja', JA: 'ja', KO: 'ko', KR: 'ko', RU: 'ru',
  CN: 'zhs', ZH: 'zhs', 'S-CN': 'zhs', TW: 'zht', 'T-CN': 'zht',
};

const etched = (name: string) => /\(etched( foil)?\)/i.test(name);

/** "Name (Extended Art)" → "Name": the marketplaces put the treatment in the title. */
export function cleanCardName(name: string): string {
  return name
    .replace(/\s*\((?:extended art|retro frame|borderless|showcase|etched(?: foil)?|foil etched|full art|v\.\s*\d+|version \d+|alternate art|textured foil|galaxy foil|surge foil|serialized)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Cardmarket CSV
// ---------------------------------------------------------------------------

/** Does this text look like a Cardmarket article export? */
export function isCardmarketCsv(text: string): boolean {
  const head = text.slice(0, 300).toLowerCase();
  return head.includes('idproduct') && head.includes('groupcount');
}

export function parseCardmarketCsv(text: string, fileName = ''): PurchaseOrder {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const delim = (lines[0] ?? '').includes(';') ? ';' : ',';
  const head = (lines[0] ?? '').split(delim).map((h) => h.trim().replace(/^"|"$/g, ''));
  const col = (name: string) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const at = { id: col('idProduct'), qty: col('groupCount'), price: col('price'), lang: col('idLanguage'), cond: col('condition'), foil: col('isFoil') };
  if (at.id < 0 || at.price < 0) throw new Error("This CSV isn't a Cardmarket order export");
  const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';
  const out: PurchaseLine[] = [];
  for (const raw of lines.slice(1)) {
    const f = raw.split(delim).map((v) => v.trim().replace(/^"|"$/g, ''));
    const id = Number(f[at.id]);
    if (!Number.isFinite(id) || id <= 0) continue;
    const grade = CARDMARKET_GRADE_CODES[Number(f[at.cond]) - 1] ?? 'NM';
    out.push({
      cardmarketId: id,
      quantity: Math.max(1, Number(f[at.qty]) || 1),
      unitCents: cents(f[at.price] ?? '0'),
      condition: CARDMARKET_GRADES[grade] ?? 'NM',
      conditionLabel: grade,
      finish: truthy(f[at.foil]) ? 'foil' : 'nonfoil',
      lang: CARDMARKET_LANG_IDS[Number(f[at.lang])] ?? 'en',
    });
  }
  // "ArticlesFromShipment1128566936.csv"; a renamed or prefixed file falls
  // back to its last long number, which is still the order more often than not.
  const orderId = fileName.match(/Shipment(\d+)/i)?.[1] ?? fileName.match(/\d{6,}/g)?.at(-1) ?? null;
  return { source: 'cardmarket', fileKind: 'csv', orderId, date: null, lines: out };
}

// ---------------------------------------------------------------------------
// CardTrader XLS
// ---------------------------------------------------------------------------

export function isCardtraderSheet(rows: unknown[][]): boolean {
  return rows.some((r) => r.includes('Item Name') && r.some((c) => typeof c === 'string' && /^Price in [A-Z]{3} Cents$/.test(c)));
}

export function parseCardtraderSheet(sheetName: string, rows: (string | number | boolean | null)[][]): PurchaseOrder {
  const headAt = rows.findIndex((r) => r.includes('Item Name'));
  if (headAt < 0) throw new Error("This spreadsheet isn't a CardTrader order export");
  const head = rows[headAt]!.map((h) => String(h ?? ''));
  const col = (name: string) => head.indexOf(name);
  const priceCol = head.findIndex((h) => /^Price in [A-Z]{3} Cents$/.test(h));
  const currency = head[priceCol]?.match(/^Price in ([A-Z]{3})/)?.[1];
  if (currency !== 'EUR') throw new Error(`This order is priced in ${currency ?? 'an unknown currency'}; only EUR orders can be imported so far`);
  const at = {
    name: col('Item Name'), set: col('Set Code'), setName: col('Set Name'), qty: col('Quantity'),
    cond: col('Condition'), lang: col('Language'), foil: col('Foil/Reverse'), cn: col('Collector Number'),
  };
  const str = (v: unknown) => (v == null ? '' : String(v)).trim();
  const out: PurchaseLine[] = [];
  for (const r of rows.slice(headAt + 1)) {
    const name = str(r[at.name]);
    if (!name) continue;
    const grade = str(r[at.cond]);
    const foil = r[at.foil] === true || str(r[at.foil]).toLowerCase() === 'true';
    out.push({
      name,
      setCode: str(r[at.set]) || undefined,
      setName: str(r[at.setName]) || undefined,
      collectorNumber: str(r[at.cn]) || undefined,
      quantity: Math.max(1, Number(r[at.qty]) || 1),
      unitCents: Math.round(Number(r[priceCol]) || 0),
      condition: CARDTRADER_GRADES[grade.toLowerCase()] ?? 'NM',
      conditionLabel: grade || 'Near Mint',
      finish: foil ? (etched(name) ? 'etched' : 'foil') : 'nonfoil',
      lang: str(r[at.lang]).toLowerCase() || 'en',
    });
  }
  const orderId = sheetName.match(/#\s*(\S+)/)?.[1] ?? null;
  return { source: 'cardtrader', fileKind: 'xls', orderId, date: dateOfCardtraderCode(orderId), lines: out };
}

/** CardTrader order codes start with the order date: 20260819mf4dnh. */
export function dateOfCardtraderCode(code: string | null): number | null {
  const m = code?.match(/^(20\d\d)(\d\d)(\d\d)/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? noon(y, mo, d) : null;
}

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

const rowText = (r: PdfRow) => r.words.map((w) => w.s).join(' ');

export function isCardmarketPdf(rows: PdfRow[]): boolean {
  return rows.some((r) => /^Purchase #\d+/.test(rowText(r)));
}

export function isCardtraderPdf(rows: PdfRow[]): boolean {
  const text = rows.map(rowText).join('\n');
  return /CardTrader/i.test(text) || (/Packing slip/.test(text) && /Item description/.test(text));
}

/**
 * A Cardmarket purchase page saved as PDF. Each article is one text line:
 *   1 Tangle Wire 139 EN EX NEM R 12,96 EUR
 *   1 Dwarven Miner EN NM ZNL U 0,88 EUR          (no collector number)
 *   1 Samwise the Stouthearted 28 EN NM LTR U Foil 0,39 EUR
 */
export function parseCardmarketPdf(rows: PdfRow[]): PurchaseOrder {
  let date: number | null = null;
  let orderId: string | null = null;
  let seller: string | undefined;
  const out: PurchaseLine[] = [];
  const article =
    /^(\d+) (.+?)(?: (\S*\d\S*))? ([A-Z]{2}(?:-[A-Z]{2})?) (MT|NM|EX|GD|LP|PL|PO) (\S+) (\S+)((?: [A-Za-z]+)*) ([\d.,]+) (?:EUR|€)$/;
  for (const r of rows) {
    const t = rowText(r);
    orderId ??= t.match(/^Purchase #(\d+)/)?.[1] ?? null;
    seller ??= t.match(/^Seller - (.+?)(?:\s{2,}|\s+Buyer - |$)/)?.[1]?.trim();
    // Paid is when the money went; that's the day you bought it.
    const paid = t.match(/Paid:\s*(\d\d)\.(\d\d)\.(\d{4})/);
    if (paid && date == null) date = noon(Number(paid[3]), Number(paid[2]), Number(paid[1]));
    const m = t.match(article);
    if (!m) continue;
    const extras = (m[8] ?? '').toLowerCase();
    out.push({
      name: m[2]!,
      ...(m[3] ? { collectorNumber: m[3] } : {}),
      setCode: m[6]!,
      quantity: Number(m[1]),
      unitCents: cents(m[9]!),
      condition: CARDMARKET_GRADES[m[5]!] ?? 'NM',
      conditionLabel: m[5]!,
      finish: extras.includes('foil') ? 'foil' : 'nonfoil',
      lang: LANG_CODES[m[4]!] ?? 'en',
    });
  }
  if (date == null) {
    for (const r of rows) {
      const m = rowText(r).match(/(?:Arrived|Sent|Unpaid)\s*:?\s*(\d\d)\.(\d\d)\.(\d{4})/);
      if (m) {
        date = noon(Number(m[3]), Number(m[2]), Number(m[1]));
        break;
      }
    }
  }
  return { source: 'cardmarket', fileKind: 'pdf', orderId, date, ...(seller ? { seller } : {}), lines: out };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A CardTrader packing slip. Columns: Qty | name | set | "NM, EN, Foil, 175" |
 * line total. Long names and set names wrap onto a second text line just
 * below, which is told apart from the next card by the line gap.
 */
export function parseCardtraderPdf(rows: PdfRow[]): PurchaseOrder {
  let orderId: string | null = null;
  let seller: string | undefined;
  let date: number | null = null;
  let setX = 230; // "Item description" header; refined below
  type Raw = { qty: number; name: string[]; set: string[]; info: string[]; price: string; page: number; y: number };
  const raws: Raw[] = [];
  let infoX = Infinity;
  let priceX = Infinity;
  let done = false;

  for (const r of rows) {
    const t = rowText(r);
    orderId ??= t.match(/^Code:\s*(\S+)/)?.[1] ?? null;
    seller ??= t.match(/Seller:\s*(.+)$/)?.[1]?.trim();
    const d = t.match(/Date:\s*(\d{1,2}) (\w{3})\w* (\d{4})/);
    if (d && date == null) {
      const mo = MONTHS.indexOf(d[2]!.toLowerCase()) + 1;
      if (mo > 0) date = noon(Number(d[3]), mo, Number(d[1]));
    }
    const header = r.words.find((w) => w.s === 'Item description');
    if (header) setX = header.x - 6;
    if (done) continue;
    if (/^Total\b/.test(t)) {
      done = true;
      continue;
    }
    const first = r.words[0];
    const price = r.words.find((w) => /^[€$£]\s?[\d.,]+$/.test(w.s));
    const info = r.words.find((w) => /^(?:M|NM|SP|MP|PL|HP|PO),/.test(w.s));
    if (first && /^\d+$/.test(first.s) && first.x < setX / 3 && price) {
      priceX = Math.min(priceX, price.x - 6);
      if (info) infoX = Math.min(infoX, info.x - 6);
      const pick = (lo: number, hi: number) => r.words.filter((w) => w !== first && w.x >= lo && w.x < hi).map((w) => w.s);
      raws.push({
        qty: Number(first.s),
        name: pick(0, setX),
        set: pick(setX, infoX),
        info: pick(infoX, priceX),
        price: price.s,
        page: r.page,
        y: r.y,
      });
      continue;
    }
    // A wrapped name, set name or collector number: same page, just under.
    const last = raws[raws.length - 1];
    if (last && r.page === last.page && last.y - r.y > 0 && last.y - r.y < 20 && first) {
      for (const w of r.words) {
        if (w.x < setX) last.name.push(w.s);
        else if (w.x < infoX) last.set.push(w.s);
        else if (w.x < priceX) last.info.push(w.s);
      }
      last.y = r.y;
    }
  }

  const lines: PurchaseLine[] = raws.map((raw) => {
    const name = raw.name.join(' ');
    // "SP, EN, Foil, 175": grade, language, finish when there is one, number.
    const parts = raw.info.join(' ').split(',').map((s) => s.trim()).filter(Boolean);
    const grade = parts[0] ?? 'NM';
    const foil = parts.some((p) => /^foil$/i.test(p));
    const number = parts.length > 2 ? parts[parts.length - 1] : undefined;
    return {
      name,
      setName: raw.set.join(' '),
      ...(number ? { collectorNumber: number } : {}),
      quantity: raw.qty,
      // The slip prints what the line cost, not a copy.
      unitCents: Math.round(cents(raw.price) / raw.qty),
      condition: CARDTRADER_GRADES[grade] ?? 'NM',
      conditionLabel: grade,
      finish: foil ? (etched(name) ? 'etched' : 'foil') : 'nonfoil',
      lang: (parts[1] ?? 'en').toLowerCase(),
    };
  });
  return { source: 'cardtrader', fileKind: 'pdf', orderId, date: date ?? dateOfCardtraderCode(orderId), ...(seller ? { seller } : {}), lines };
}

/** Total paid for the order's cards, EUR cents (no shipping). */
export function orderTotalCents(order: PurchaseOrder): number {
  return order.lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
}
