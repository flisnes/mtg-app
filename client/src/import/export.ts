import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';

// Lossless CSV export (beta plan §5, §10): carries set / collector number /
// condition / finish / language / quantities / Scryfall id, so it round-trips
// through our own importer and doubles as the migration format to the future
// account-backed storage. Column names are import-compatible (Moxfield-ish).

const COLUMNS = [
  'Count',
  'Tradelist Count',
  'Name',
  'Edition',
  'Collector Number',
  'Condition',
  'Language',
  'Finish',
  'Scryfall ID',
] as const;

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function buildCollectionCsv(opts: { tradeOnly?: boolean } = {}): Promise<string> {
  const all = await db.collection.toArray();
  const entries = opts.tradeOnly ? all.filter((e) => e.quantityForTrade > 0) : all;
  const [oracleMap, printMap] = await Promise.all([
    getOracleCardsByIds(entries.map((e) => e.oracleId)),
    getPrintingsByIds(entries.map((e) => e.scryfallId)),
  ]);

  entries.sort((a, b) => (oracleMap.get(a.oracleId)?.name ?? '').localeCompare(oracleMap.get(b.oracleId)?.name ?? ''));

  const rows = [COLUMNS.join(',')];
  for (const e of entries) {
    const oracle = oracleMap.get(e.oracleId);
    const printing = printMap.get(e.scryfallId);
    rows.push(
      [
        String(e.quantity),
        String(e.quantityForTrade),
        oracle?.name ?? '',
        printing?.set ?? '',
        printing?.collectorNumber ?? '',
        e.condition,
        e.lang,
        e.finish,
        e.scryfallId,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return rows.join('\n') + '\n';
}

/**
 * Tradelist export: the trade-marked subset of the collection, in the same
 * lossless CSV as the full collection (carries both Count and Tradelist Count),
 * so it round-trips through our importer with "use tradelist counts from file".
 */
export function buildTradelistCsv(): Promise<string> {
  return buildCollectionCsv({ tradeOnly: true });
}

/**
 * Wishlist export as a plain-text list. "Any printing" wishes are a bare
 * `qty name`; printing-specific wishes carry `(SET) collectorNumber`, so the
 * list round-trips through our own importer (and pastes into Moxfield etc.).
 */
export async function buildWishlistText(): Promise<string> {
  const entries = await db.wishlist.toArray();
  const [oracleMap, printMap] = await Promise.all([
    getOracleCardsByIds(entries.map((e) => e.oracleId)),
    getPrintingsByIds(entries.map((e) => e.scryfallId).filter((id): id is string => id !== null)),
  ]);

  entries.sort((a, b) => (oracleMap.get(a.oracleId)?.name ?? '').localeCompare(oracleMap.get(b.oracleId)?.name ?? ''));

  const lines: string[] = [];
  for (const e of entries) {
    const name = oracleMap.get(e.oracleId)?.name;
    if (!name) continue;
    const printing = e.scryfallId ? printMap.get(e.scryfallId) : undefined;
    const suffix = printing ? ` (${printing.set.toUpperCase()}) ${printing.collectorNumber}` : '';
    lines.push(`${e.quantity} ${name}${suffix}`);
  }
  return lines.join('\n') + '\n';
}

/** Trigger a browser download of the export. */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
