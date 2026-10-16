import { beforeEach, describe, expect, test } from 'vitest';
import type { DeckCard, Printing, Priced } from '@mtg/shared';
import { db } from '../src/db/schema.js';
import { buildRescanReview } from '../src/scan/rescan.js';
import { countByPrinting, mergeSession, sessionKey, type SessionEntry } from '../src/scan/session.js';
import { filterBySet, onePrinting, type Candidate } from '../src/scan/tray.js';

const entry = (over: Partial<SessionEntry>): SessionEntry => ({
  scryfallId: 'p1',
  oracleId: 'o1',
  name: 'Sol Ring',
  set: 'cmr',
  collectorNumber: '1',
  finish: 'nonfoil',
  lang: 'en',
  condition: 'NM',
  board: 'main',
  qty: 1,
  ...over,
});

const cand = (scryfallId: string, set: string, collectorNumber = '1'): Candidate => ({
  scryfallId,
  distance: 0,
  printing: { scryfallId, set, collectorNumber, oracleId: 'o1' } as Priced<Printing>,
});

describe('scan session', () => {
  test('a filed deck slot keys like the session line for the same copy', () => {
    const slot = { scryfallId: 'p1', finish: 'nonfoil', condition: 'NM', lang: 'en', board: 'main' } as const;
    expect(sessionKey(slot)).toBe(sessionKey(entry({})));
    // A slot that names no copy keys apart from every scanned line.
    expect(sessionKey({ board: 'main' })).not.toBe(sessionKey(entry({})));
  });

  test('mergeSession folds same copies and keeps languages apart', () => {
    const merged = mergeSession([entry({ qty: 2 }), entry({ qty: 1 }), entry({ lang: 'ja' })]);
    expect(merged.map((e) => [e.lang, e.qty])).toEqual([
      ['en', 3],
      ['ja', 1],
    ]);
  });

  test('countByPrinting sums across finishes and boards', () => {
    const counts = countByPrinting([entry({ qty: 2 }), entry({ finish: 'foil' }), entry({ board: 'side' }), entry({ scryfallId: 'p2' })]);
    expect(counts.get('p1')).toBe(4);
    expect(counts.get('p2')).toBe(1);
  });
});

describe('scan tray', () => {
  test('a set pin that matches nothing steps aside', () => {
    const cs = [cand('a', 'cmr'), cand('b', 'c21')];
    expect(filterBySet(cs, 'c21').map((c) => c.scryfallId)).toEqual(['b']);
    expect(filterBySet(cs, 'lea').map((c) => c.scryfallId)).toEqual(['a', 'b']);
  });

  test('foil and nonfoil siblings count as one printing', () => {
    expect(onePrinting([cand('a', 'cmr'), cand('a-foil', 'cmr')])?.scryfallId).toBe('a');
    expect(onePrinting([cand('a', 'cmr'), cand('b', 'cmr', '2')])).toBeNull();
  });
});

describe('deck re-scan review', () => {
  beforeEach(async () => {
    await db.deckCards.clear();
  });

  const slot = (over: Partial<DeckCard>): DeckCard => ({
    id: crypto.randomUUID(),
    deckId: 'd1',
    oracleId: 'o1',
    quantity: 1,
    board: 'main',
    ...over,
  }) as DeckCard;

  test('same filed copies: no changes, nothing to refile', async () => {
    await db.deckCards.add(slot({ scryfallId: 'p1', finish: 'nonfoil', condition: 'NM', lang: 'en' }));
    const r = await buildRescanReview([entry({})], 'd1');
    expect(r.changes).toEqual([]);
    expect(r.refiles).toBe(false);
  });

  test('a listed but unfiled line is no change to the list, but still a refile', async () => {
    await db.deckCards.add(slot({}));
    const r = await buildRescanReview([entry({})], 'd1');
    expect(r.changes).toEqual([]);
    expect(r.refiles).toBe(true);
  });

  test('adds, quantity changes and removals', async () => {
    await db.deckCards.bulkAdd([slot({ quantity: 1 }), slot({ oracleId: 'o2' })]);
    const r = await buildRescanReview([entry({ qty: 3 }), entry({ scryfallId: 'p3', oracleId: 'o3', name: 'Arcane Signet' })], 'd1');
    expect(r.changes.map((c) => c.kind).sort()).toEqual(['add', 'change', 'remove']);
  });
});
