import type { Condition, DeckBoard, Finish } from '@mtg/shared';
import type { ImportFormat, ParsedLine } from './types.js';

// Format auto-detecting parsers (beta plan §5). Priority: plain-text/MTGA is the
// universal escape hatch; Moxfield and Archidekt CSV exports are mapped by
// header. Tolerant: unknown columns are ignored, unparseable lines are skipped.

// Every grade word and code a list or marketplace writes, on our five-step
// scale. Cardmarket's (MT NM EX GD LP PL PO) and CardTrader's (M NM SP MP PL
// HP PO) seven steps are squeezed in: EX and SP are our LP, GD our MP. Two
// tokens mean different things on different scales and are not here: "LP" is
// Light Played on Cardmarket (its fifth grade of seven) but Lightly Played
// everywhere else, and CardTrader's "Played" sits between MP and HP. The
// purchase parsers override those two (import/purchase/parse.ts).
const CONDITION_MAP: Record<string, Condition> = {
  'near mint': 'NM', nm: 'NM', mint: 'NM', m: 'NM', mt: 'NM',
  'lightly played': 'LP', lp: 'LP', 'light played': 'LP', 'slightly played': 'LP', sp: 'LP', excellent: 'LP', ex: 'LP',
  'moderately played': 'MP', mp: 'MP', played: 'MP', good: 'MP', gd: 'MP',
  'heavily played': 'HP', hp: 'HP', pl: 'HP',
  damaged: 'DMG', dmg: 'DMG', poor: 'DMG', po: 'DMG',
};

const LANG_MAP: Record<string, string> = {
  english: 'en', german: 'de', french: 'fr', italian: 'it', spanish: 'es',
  portuguese: 'pt', japanese: 'ja', korean: 'ko', russian: 'ru',
  'chinese simplified': 'zhs', 'chinese traditional': 'zht',
  // Marketplace codes that aren't Scryfall's: CardTrader's jp and zh-CN/zh-TW,
  // the codes Cardmarket's purchase page prints (JP, KR, CN, S-CN, T-CN, TW).
  jp: 'ja', kr: 'ko', cn: 'zhs', zh: 'zhs', 'zh-cn': 'zhs', 's-cn': 'zhs', tw: 'zht', 'zh-tw': 'zht', 't-cn': 'zht',
};

export function normCondition(v: string | undefined): Condition | undefined {
  if (!v) return undefined;
  return CONDITION_MAP[v.trim().toLowerCase()];
}

function normFinish(v: string | undefined): Finish | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'foil') return 'foil';
  if (s === 'etched') return 'etched';
  // 'normal', 'nonfoil', 'false', blank, anything else: a plain copy.
  return 'nonfoil';
}

/** A language name or marketplace code as a Scryfall code; a Scryfall code passes through. */
export function normLang(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (!s) return undefined;
  if (LANG_MAP[s]) return LANG_MAP[s];
  return s.length <= 3 ? s : 'en';
}

// ---- Plain text / MTGA ----

const SECTION_RE = /^(deck|sideboard|commander|companion|maybeboard|maybe|considering|tokens?|about)\b/i;

/** Which board a lone section header switches to (deck imports; ignored by collection import). */
function sectionBoard(line: string): DeckBoard | undefined {
  if (!SECTION_RE.test(line) || /^\d/.test(line)) return undefined;
  if (/^sideboard\b/i.test(line)) return 'side';
  if (/^commander\b/i.test(line)) return 'commander';
  if (/^companion\b/i.test(line)) return 'companion';
  if (/^(maybeboard|maybe|considering)\b/i.test(line)) return 'maybe';
  if (/^tokens?\b/i.test(line)) return 'token';
  return 'main';
}

/** Parse "4 Lightning Bolt (MH2) 123" style lines. */
function parseText(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let board: DeckBoard = 'main';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    // Lone section headers (no quantity) switch the active board and are skipped.
    const section = sectionBoard(line);
    if (section) {
      board = section;
      continue;
    }

    let rest = line;
    let quantity = 1;
    const qtyMatch = rest.match(/^(\d+)\s*[xX]?\s+/);
    if (qtyMatch) {
      quantity = Math.max(1, parseInt(qtyMatch[1]!, 10));
      rest = rest.slice(qtyMatch[0].length).trim();
    }

    // Manabox/Moxfield foil marker at the end: "*F*" (foil) / "*E*" (etched).
    let finish: Finish | undefined;
    const foilM = rest.match(/\s*\*([FE])\*\s*$/i);
    if (foilM) {
      finish = foilM[1]!.toUpperCase() === 'E' ? 'etched' : 'foil';
      rest = rest.slice(0, foilM.index).trim();
    }

    let setCode: string | undefined;
    let collectorNumber: string | undefined;
    // Trailing "(SET) 123" or "(SET)" (Manabox puts the collector number after the set).
    const tail = rest.match(/\s*\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9★-]+)?\s*$/);
    if (tail) {
      setCode = tail[1]!.toLowerCase();
      collectorNumber = tail[2];
      rest = rest.slice(0, tail.index).trim();
    }
    if (!rest) continue;
    lines.push({ raw, quantity, name: rest, setCode, collectorNumber, finish, board });
  }
  return lines;
}

// ---- CSV ----

/** RFC-ish CSV tokenizer that handles quoted fields, embedded delimiters, and newlines. Blank rows are dropped. */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  return rows;
}

const HEADER_ALIASES: Record<string, string[]> = {
  quantity: ['count', 'quantity', 'qty'],
  tradelist: ['tradelist count'],
  name: ['name', 'card name'],
  setCode: ['edition code', 'set code', 'edition', 'set'],
  collectorNumber: ['collector number', 'card number', 'number'],
  condition: ['condition'],
  language: ['language', 'lang'],
  finish: ['finish', 'foil'],
  scryfallId: ['scryfall id', 'scryfallid'],
};

function mapHeader(header: string[]): Record<string, number> {
  const lower = header.map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const i = lower.indexOf(alias);
      if (i !== -1) {
        idx[field] = i;
        break;
      }
    }
  }
  return idx;
}

function parseCsv(text: string): { format: ImportFormat; lines: ParsedLine[] } {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { format: 'csv', lines: [] };
  const header = rows[0]!;
  const idx = mapHeader(header);
  const lowerHeader = header.map((h) => h.trim().toLowerCase());
  const format: ImportFormat = lowerHeader.includes('tradelist count')
    ? 'moxfield'
    : lowerHeader.includes('scryfall id') || lowerHeader.includes('edition code')
      ? 'archidekt'
      : 'csv';

  const get = (row: string[], field: string): string | undefined =>
    idx[field] !== undefined ? row[idx[field]!]?.trim() : undefined;

  const lines: ParsedLine[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const name = get(row, 'name');
    if (!name) continue;
    const quantity = Math.max(1, parseInt(get(row, 'quantity') ?? '1', 10) || 1);
    const tradeRaw = get(row, 'tradelist');
    const quantityForTrade = tradeRaw ? Math.max(0, parseInt(tradeRaw, 10) || 0) : undefined;
    lines.push({
      raw: row.join(','),
      quantity,
      quantityForTrade,
      name,
      setCode: get(row, 'setCode')?.toLowerCase() || undefined,
      collectorNumber: get(row, 'collectorNumber') || undefined,
      condition: normCondition(get(row, 'condition')),
      finish: normFinish(get(row, 'finish')),
      lang: normLang(get(row, 'language')),
      scryfallId: get(row, 'scryfallId') || undefined,
    });
  }
  return { format, lines };
}

/** Detect format and parse. CSV if the first non-empty line looks like a header. */
export function parseImport(text: string): { format: ImportFormat; lines: ParsedLine[] } {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const looksCsv = firstLine.includes(',') && /\bname\b/i.test(firstLine) && /count|quantity|qty|edition|set|finish|scryfall/i.test(firstLine);
  if (looksCsv) return parseCsv(text);
  return { format: 'text', lines: parseText(text) };
}
