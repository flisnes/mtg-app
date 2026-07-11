import type { DeckBoard } from '@mtg/shared';
import { resolveOracleByName } from '../cardDb/search.js';

// Deck text import/export (beta plan §5). Same plain-text/MTGA style as the
// collection importer, but board-aware (Deck / Sideboard sections) and
// resolving only to oracle cards (deck slots are "4x Lightning Bolt").

interface DeckTextLine {
  quantity: number;
  name: string;
  board: DeckBoard;
}

export interface DeckImportResult {
  resolved: Array<{ oracleId: string; quantity: number; board: DeckBoard }>;
  unmatched: string[];
}

function parseDeckLines(text: string): DeckTextLine[] {
  const out: DeckTextLine[] = [];
  let board: DeckBoard = 'main';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (/^sideboard\b/i.test(line)) {
      board = 'side';
      continue;
    }
    if (/^commander\b/i.test(line) && !/^\d/.test(line)) {
      board = 'commander';
      continue;
    }
    if (/^(deck|companion|maybeboard|about)\b/i.test(line) && !/^\d/.test(line)) {
      board = 'main';
      continue;
    }
    const m = line.match(/^(\d+)\s*[xX]?\s+(.+)$/);
    let quantity = 1;
    let name = line;
    if (m) {
      quantity = Math.max(1, parseInt(m[1]!, 10));
      name = m[2]!.trim();
    }
    // Strip a trailing "(SET) 123" hint — decks key on the oracle card.
    name = name.replace(/\s*\([A-Za-z0-9]{2,6}\)\s*[A-Za-z0-9★-]*\s*$/, '').trim();
    if (name) out.push({ quantity, name, board });
  }
  return out;
}

export async function resolveDeckText(text: string): Promise<DeckImportResult> {
  const lines = parseDeckLines(text);
  const resolved: DeckImportResult['resolved'] = [];
  const unmatched: string[] = [];
  for (const l of lines) {
    const oracle = await resolveOracleByName(l.name);
    if (oracle) resolved.push({ oracleId: oracle.oracleId, quantity: l.quantity, board: l.board });
    else unmatched.push(l.name);
  }
  return { resolved, unmatched };
}

export function buildDeckText(
  main: Array<{ name: string; quantity: number }>,
  side: Array<{ name: string; quantity: number }>,
  commander: Array<{ name: string; quantity: number }> = [],
): string {
  const lines: string[] = [];
  if (commander.length) {
    lines.push('Commander', ...commander.map((c) => `${c.quantity} ${c.name}`), '');
  }
  lines.push('Deck', ...main.map((c) => `${c.quantity} ${c.name}`));
  if (side.length) {
    lines.push('', 'Sideboard', ...side.map((c) => `${c.quantity} ${c.name}`));
  }
  return lines.join('\n') + '\n';
}
