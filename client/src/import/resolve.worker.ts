/// <reference lib="webworker" />
import type { Finish, OracleCard, Printing } from '@mtg/shared';
import { normalize as normalizeText } from '../cardDb/querySyntax.js';
import { buildNameMultiIndex, cardPriority } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { parseImport } from './parse.js';
import type { ParsedLine, ResolveRequest, ResolveResponse, ResolvedLine, UnmatchedLine } from './types.js';

function post(msg: ResolveResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

const normalize = (s: string) => normalizeText(s).trim();
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

const setMatches = (p: Printing, set: string) => p.set.toLowerCase() === set || normalize(p.setName) === set;

/**
 * Pick which oracle a line refers to when several cards share its name (real
 * card vs. its token/art-series printing). The set code is ground truth: prefer
 * the candidate that actually has a printing in that set — so "Warren Warleader
 * (BLB)" resolves to the card and "Angel (TWAR)" to the token. With no set code
 * (or an unrecognized one) fall back to the real card over token/art.
 */
function pickOracle(line: ParsedLine, candidates: OracleCard[], byOracle: Map<string, Printing[]>): OracleCard {
  if (candidates.length === 1) return candidates[0]!;
  if (line.scryfallId) {
    const owner = candidates.find((c) => (byOracle.get(c.oracleId) ?? []).some((p) => p.scryfallId === line.scryfallId));
    if (owner) return owner;
  }
  if (line.setCode) {
    const set = line.setCode.toLowerCase();
    const inSet = candidates.find((c) => (byOracle.get(c.oracleId) ?? []).some((p) => setMatches(p, set)));
    if (inSet) return inSet;
  }
  // candidates are pre-sorted real-first; the first is the sensible default.
  return candidates[0]!;
}

/** Choose the concrete printing for a matched line. */
function resolvePrinting(line: ParsedLine, oracle: OracleCard, printings: Printing[]): Printing | undefined {
  if (line.scryfallId) {
    const byId = printings.find((p) => p.scryfallId === line.scryfallId);
    if (byId) return byId;
  }
  if (line.setCode) {
    const set = line.setCode.toLowerCase();
    const inSet = printings.filter((p) => setMatches(p, set));
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
    const nameMap = buildNameMultiIndex(cards);
    // Loose fallback: names reduced to alphanumerics, for punctuation mismatches.
    const looseMap = new Map<string, OracleCard[]>();
    for (const c of cards) {
      const key = alnum(c.name);
      const arr = looseMap.get(key);
      if (arr) arr.push(c);
      else looseMap.set(key, [c]);
    }
    for (const arr of looseMap.values()) arr.sort((a, b) => cardPriority(a) - cardPriority(b));

    // First pass: match lines to their candidate oracle cards (a name may be
    // shared by a real card and its token/art printing — disambiguated below
    // once printings are loaded).
    const candidateMatches: Array<{ line: ParsedLine; candidates: OracleCard[] }> = [];
    const unmatched: UnmatchedLine[] = [];
    for (const line of lines) {
      // Art cards (dropped from the DB — no oracle_id) export as a doubled
      // "Name / Name"; also handle plain "Front // Back". Fall back to the front
      // face so the line resolves to the real card, not nothing.
      const front = line.name.split(/\s*\/\/?\s*/)[0]!;
      const candidates =
        nameMap.get(normalize(line.name)) ??
        looseMap.get(alnum(line.name)) ??
        nameMap.get(normalize(front)) ??
        looseMap.get(alnum(front));
      if (candidates?.length) candidateMatches.push({ line, candidates });
      else unmatched.push({ raw: line.raw, name: line.name, quantity: line.quantity, finish: line.finish, board: line.board, suggestions: [] });
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

    // Bulk-fetch printings for every candidate oracle (both the real card and
    // any token/art namesake), then pick the intended oracle per line by set.
    post({ type: 'progress', label: 'Resolving editions…', fraction: 0.7 });
    const oracleIds = [...new Set(candidateMatches.flatMap((m) => m.candidates.map((c) => c.oracleId)))];
    const allPrintings = await db.printings.where('oracleId').anyOf(oracleIds).toArray();
    const byOracle = new Map<string, Printing[]>();
    for (const p of allPrintings) {
      const arr = byOracle.get(p.oracleId);
      if (arr) arr.push(p);
      else byOracle.set(p.oracleId, [p]);
    }

    const resolved: ResolvedLine[] = [];
    for (const { line, candidates } of candidateMatches) {
      const oracle = pickOracle(line, candidates, byOracle);
      const printings = byOracle.get(oracle.oracleId) ?? [];
      const printing = resolvePrinting(line, oracle, printings);
      if (!printing) {
        unmatched.push({ raw: line.raw, name: line.name, quantity: line.quantity, finish: line.finish, board: line.board, suggestions: [] });
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
        board: line.board,
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
