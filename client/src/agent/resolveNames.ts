// Card-name resolution for agent write tools. Deliberately simpler than the
// import resolver worker: exact name lookup (front face tolerated), optional
// set / collector-number narrowing, and "unmatched" over guessing.

import type { OracleCard, Printing } from '@mtg/shared';
import { resolveOracleByName } from '../cardDb/search.js';
import { preferredScryfallId } from '../cardDb/preferredPrinting.js';
import { db } from '../db/schema.js';

export interface NameLine {
  name: string;
  set?: string;
  collectorNumber?: string;
  quantity: number;
}

export interface ResolvedName<L extends NameLine> {
  line: L;
  oracle: OracleCard;
  scryfallId: string;
}

export interface ResolveNamesResult<L extends NameLine> {
  resolved: ResolvedName<L>[];
  /** Lines that matched no card (or no printing in the asked-for set). */
  unmatched: { name: string; reason: string }[];
}

async function pickPrinting(oracle: OracleCard, set?: string, collectorNumber?: string): Promise<string | null> {
  if (!set && !collectorNumber) return preferredScryfallId(oracle);
  let printings: Printing[] = await db.printings.where('oracleId').equals(oracle.oracleId).toArray();
  if (set) {
    const code = set.trim().toLowerCase();
    printings = printings.filter((p) => p.set.toLowerCase() === code);
  }
  if (collectorNumber) {
    const num = collectorNumber.trim().toLowerCase();
    printings = printings.filter((p) => p.collectorNumber.toLowerCase() === num);
  }
  if (printings.length === 0) return null;
  printings.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  return printings[0]!.scryfallId;
}

export async function resolveNames<L extends NameLine>(lines: L[]): Promise<ResolveNamesResult<L>> {
  const resolved: ResolvedName<L>[] = [];
  const unmatched: { name: string; reason: string }[] = [];
  for (const line of lines) {
    const oracle = await resolveOracleByName(line.name);
    if (!oracle) {
      unmatched.push({ name: line.name, reason: 'no card by that name in the local card DB' });
      continue;
    }
    const scryfallId = await pickPrinting(oracle, line.set, line.collectorNumber);
    if (!scryfallId) {
      unmatched.push({
        name: line.name,
        reason: `no printing matches${line.set ? ` set ${line.set}` : ''}${line.collectorNumber ? ` #${line.collectorNumber}` : ''}`,
      });
      continue;
    }
    resolved.push({ line, oracle, scryfallId });
  }
  return { resolved, unmatched };
}
