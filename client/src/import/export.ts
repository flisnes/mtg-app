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

export async function buildCollectionCsv(): Promise<string> {
  const entries = await db.collection.toArray();
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
