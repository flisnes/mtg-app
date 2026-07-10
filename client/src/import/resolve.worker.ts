/// <reference lib="webworker" />
import type { Finish, OracleCard, Printing } from '@mtg/shared';
import { db } from '../db/schema.js';
import { parseImport } from './parse.js';
import type { ParsedLine, ResolveRequest, ResolveResponse, ResolvedLine, UnmatchedLine } from './types.js';

function post(msg: ResolveResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

const COMBINING = /\p{M}/gu;
const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(COMBINING, '').trim();
const alnum = (s: string) => normalize(s).replace(/[^a-z0-9]/g, '');

/** Levenshtein edit distance (two-row DP) for ranking typo suggestions. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

function pickFinish(line: ParsedLine, printing: Printing): Finish {
  const wanted = line.finish;
  if (wanted && printing.finishes.includes(wanted)) return wanted;
  if (printing.finishes.includes('nonfoil')) return 'nonfoil';
  return printing.finishes[0] ?? 'nonfoil';
}

/** Choose the concrete printing for a matched line. */
function resolvePrinting(line: ParsedLine, oracle: OracleCard, printings: Printing[]): Printing | undefined {
  if (line.scryfallId) {
    const byId = printings.find((p) => p.scryfallId === line.scryfallId);
    if (byId) return byId;
  }
  if (line.setCode) {
    const set = line.setCode.toLowerCase();
    const inSet = printings.filter((p) => p.set.toLowerCase() === set || normalize(p.setName) === set);
    if (inSet.length) {
      if (line.collectorNumber) {
        const exact = inSet.find((p) => p.collectorNumber.toLowerCase() === line.collectorNumber!.toLowerCase());
        if (exact) return exact;
      }
      return inSet[0];
    }
  }
  return printings.find((p) => p.scryfallId === oracle.defaultScryfallId) ?? printings[0];
}

self.onmessage = async (e: MessageEvent<ResolveRequest>) => {
  try {
    const { text, tradelistMode = 'none' } = e.data;

    post({ type: 'progress', label: 'Parsing…', fraction: 0.05 });
    const { format, lines } = parseImport(text);

    post({ type: 'progress', label: 'Indexing card names…', fraction: 0.15 });
    const cards = await db.oracleCards.toArray();
    const nameMap = new Map<string, OracleCard>();
    const looseMap = new Map<string, OracleCard>();
    // Pass 1: exact full names win.
    for (const c of cards) {
      const n = normalize(c.name);
      if (!nameMap.has(n)) nameMap.set(n, c);
      looseMap.set(alnum(c.name), c);
    }
    // Pass 2: DFC/split front faces ("Front // Back") only as a fallback.
    for (const c of cards) {
      const slash = c.name.indexOf(' // ');
      if (slash !== -1) {
        const front = normalize(c.name.slice(0, slash));
        if (!nameMap.has(front)) nameMap.set(front, c);
      }
    }

    // First pass: match lines to oracle cards.
    const matched: Array<{ line: ParsedLine; oracle: OracleCard }> = [];
    const unmatched: UnmatchedLine[] = [];
    for (const line of lines) {
      const key = normalize(line.name);
      const oracle = nameMap.get(key) ?? looseMap.get(alnum(line.name));
      if (oracle) matched.push({ line, oracle });
      else unmatched.push({ raw: line.raw, name: line.name, quantity: line.quantity, finish: line.finish, suggestions: [] });
    }

    // Suggestions for unmatched: gather plausible candidates (shared prefix,
    // shared word, or substring) then rank by edit distance so the closest
    // name comes first — good for typos like "Lightnng Bolt" → "Lightning Bolt".
    if (unmatched.length) {
      post({ type: 'progress', label: 'Finding suggestions…', fraction: 0.55 });
      const names = cards.map((c) => ({ name: c.name, norm: normalize(c.name) }));
      for (const u of unmatched) {
        const q = normalize(u.name);
        const head = q.slice(0, 3);
        const words = q.split(/\s+/).filter((w) => w.length >= 4);
        const cand: Array<{ name: string; d: number }> = [];
        for (const n of names) {
          if (n.norm.includes(q) || (head.length >= 3 && n.norm.startsWith(head)) || words.some((w) => n.norm.includes(w))) {
            cand.push({ name: n.name, d: editDistance(q, n.norm) });
            if (cand.length > 4000) break;
          }
        }
        cand.sort((a, b) => a.d - b.d);
        u.suggestions = cand.slice(0, 3).map((c) => c.name);
      }
    }

    // Bulk-fetch printings for all matched oracles, then resolve editions.
    post({ type: 'progress', label: 'Resolving editions…', fraction: 0.7 });
    const oracleIds = [...new Set(matched.map((m) => m.oracle.oracleId))];
    const allPrintings = await db.printings.where('oracleId').anyOf(oracleIds).toArray();
    const byOracle = new Map<string, Printing[]>();
    for (const p of allPrintings) {
      const arr = byOracle.get(p.oracleId);
      if (arr) arr.push(p);
      else byOracle.set(p.oracleId, [p]);
    }

    const resolved: ResolvedLine[] = [];
    for (const { line, oracle } of matched) {
      const printings = byOracle.get(oracle.oracleId) ?? [];
      const printing = resolvePrinting(line, oracle, printings);
      if (!printing) {
        unmatched.push({ raw: line.raw, name: line.name, quantity: line.quantity, finish: line.finish, suggestions: [] });
        continue;
      }
      const quantityForTrade =
        tradelistMode === 'all'
          ? line.quantity
          : tradelistMode === 'file'
            ? Math.min(line.quantity, line.quantityForTrade ?? 0)
            : 0;
      resolved.push({
        oracleId: oracle.oracleId,
        scryfallId: printing.scryfallId,
        name: oracle.name,
        quantity: line.quantity,
        quantityForTrade,
        condition: line.condition ?? 'NM',
        finish: pickFinish(line, printing),
        lang: line.lang ?? 'en',
      });
    }

    post({
      type: 'done',
      result: {
        format,
        resolved,
        unmatched,
        resolvedQuantity: resolved.reduce((s, r) => s + r.quantity, 0),
      },
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
