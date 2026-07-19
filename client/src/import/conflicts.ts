import type { CollectionEntry } from '@mtg/shared';
import { db } from '../db/schema.js';
import type { ResolvedLine } from './types.js';

// Import conflict detection: a card in the import that's already in the
// collection — in ANY printing/condition/language — is surfaced so the user
// can decide per card whether to skip the import line, add on top, or replace
// what they own. Resolution itself happens in applyImport (dataAccess).

export type ConflictChoice = 'skip' | 'add' | 'replace';

export interface ImportConflict {
  oracleId: string;
  name: string;
  /** What the collection already holds for this card (all printings). */
  existing: CollectionEntry[];
  /** The import's lines for this card. */
  incoming: ResolvedLine[];
}

/** Group the import's lines by card and match them against owned entries. */
export async function findImportConflicts(lines: ResolvedLine[]): Promise<ImportConflict[]> {
  const byOracle = new Map<string, ResolvedLine[]>();
  for (const l of lines) {
    const arr = byOracle.get(l.oracleId);
    if (arr) arr.push(l);
    else byOracle.set(l.oracleId, [l]);
  }
  const owned = await db.collection.where('oracleId').anyOf([...byOracle.keys()]).toArray();
  const ownedByOracle = new Map<string, CollectionEntry[]>();
  for (const e of owned) {
    const arr = ownedByOracle.get(e.oracleId);
    if (arr) arr.push(e);
    else ownedByOracle.set(e.oracleId, [e]);
  }
  const conflicts: ImportConflict[] = [];
  for (const [oracleId, incoming] of byOracle) {
    const existing = ownedByOracle.get(oracleId);
    if (existing) conflicts.push({ oracleId, name: incoming[0]!.name, existing, incoming });
  }
  return conflicts.sort((a, b) => a.name.localeCompare(b.name));
}
