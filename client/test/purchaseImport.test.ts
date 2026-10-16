import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionEntry, UserEvent } from '@mtg/shared';
import { db, USER_DATA_TABLES } from '../src/db/schema.js';
import {
  cleanCardName,
  dateOfCardtraderCode,
  parseCardmarketCsv,
  parseCardmarketPdf,
  parseCardtraderPdf,
  parseCardtraderSheet,
  type PdfRow,
} from '../src/import/purchase/parse.js';
import { planPurchase, type PlanLine } from '../src/import/purchase/plan.js';
import { commitPurchase } from '../src/import/purchase/commit.js';
import { applyImport } from '../src/db/collectionWrites.js';
import { buildIntakeLines } from '../src/import/intake/model.js';
import { costBasisOf } from '../src/price/costBasis.js';
import { undoableIds } from '../src/db/undoScope.js';

// Purchase import (v0.201.0): marketplace order files in, acquisition dates and
// prices out. The parsers are pinned on hand-made copies of the four file
// shapes; the matcher on the cases that motivated it, chief among them a copy
// that was scanned in and has since been traded away.

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

describe('parsers', () => {
  it('reads a Cardmarket article CSV: ids, grades 1-7, per-copy price, order id from the file name', () => {
    const csv = [
      'idProduct;groupCount;price;idLanguage;condition;isFoil;isSigned;isAltered;isPlayset',
      '11862;1;12.96;1;3;;;;',
      '701757;1;0.39;1;2;1;;;',
      '723559;4;0.12;3;4;;;;',
    ].join('\n');
    const o = parseCardmarketCsv(csv, 'ArticlesFromShipment1128566936.csv');
    expect(o).toMatchObject({ source: 'cardmarket', fileKind: 'csv', orderId: '1128566936', date: null });
    expect(parseCardmarketCsv(csv, '19187874-ArticlesFromShipment1128566936.csv').orderId).toBe('1128566936');
    expect(o.lines).toEqual([
      { cardmarketId: 11862, quantity: 1, unitCents: 1296, condition: 'LP', conditionLabel: 'EX', finish: 'nonfoil', lang: 'en' },
      { cardmarketId: 701757, quantity: 1, unitCents: 39, condition: 'NM', conditionLabel: 'NM', finish: 'foil', lang: 'en' },
      { cardmarketId: 723559, quantity: 4, unitCents: 12, condition: 'MP', conditionLabel: 'GD', finish: 'nonfoil', lang: 'de' },
    ]);
  });

  it('reads a CardTrader sheet: Scryfall codes, cents, etched from the name, date from the order code', () => {
    const head = ['Game', 'Set Name', 'Set Code', 'Item Name', 'Price in EUR Cents', 'Quantity', 'Condition', 'Language', 'Foil/Reverse', 'Collector Number'];
    const o = parseCardtraderSheet('CardTrader order #20260819mf4dnh', [
      head,
      ['Magic: the Gathering', 'Tempest', 'TMP', 'Insight', 281, 1, 'Near Mint', 'en', false, '068'],
      ['Magic: the Gathering', 'March of the Machine: The Aftermath Collectors', 'CMAT', 'Tolarian Contempt (Etched Foil)', 20, 1, 'Slightly Played', 'en', true, '108e'],
    ]);
    expect(o.orderId).toBe('20260819mf4dnh');
    expect(o.date).toBe(day('2026-08-19'));
    expect(o.lines[0]).toMatchObject({ name: 'Insight', setCode: 'TMP', collectorNumber: '068', unitCents: 281, condition: 'NM' });
    expect(o.lines[1]).toMatchObject({ finish: 'etched', condition: 'LP', conditionLabel: 'Slightly Played' });
  });

  it('refuses a CardTrader order priced in another currency rather than mislabel it EUR', () => {
    expect(() => parseCardtraderSheet('x', [['Item Name', 'Price in USD Cents'], ['Insight', 100]])).toThrow(/USD/);
  });

  it('reads a CardTrader order code date only when it is one', () => {
    expect(dateOfCardtraderCode('20231301abc')).toBeNull();
    expect(dateOfCardtraderCode(null)).toBeNull();
  });

  // Words at made-up but consistent x positions, the way pdfText.ts lays them out.
  const words = (s: string, x0 = 10) => s.split(' ').map((w, i) => ({ x: x0 + i * 10, s: w }));

  it('reads a Cardmarket PDF, with and without a collector number, foil, and the paid date', () => {
    const rows: PdfRow[] = [
      'Purchase #1128566936',
      'Seller - Spellslingers Buyer - Mewis',
      'Unpaid: 25.09.2023 23:52 Paid: 26.09.2023 01:19 Sent: 02.10.2023 10:38',
      '1 Tangle Wire 139 EN EX NEM R 12,96 EUR',
      '1 Dwarven Miner EN NM ZNL U 0,88 EUR',
      '1 Samwise the Stouthearted 28 EN NM LTR U Foil 0,39 EUR',
      '1 Saradoc, Master of Buckland (V.1) 282 EN NM XLTR R 0,36 EUR',
    ].map((t, i) => ({ page: 1, y: 800 - i * 20, words: words(t) }));
    const o = parseCardmarketPdf(rows);
    expect(o).toMatchObject({ orderId: '1128566936', seller: 'Spellslingers', date: day('2023-09-26') });
    expect(o.lines.map((l) => [l.name, l.collectorNumber, l.setCode, l.finish, l.unitCents])).toEqual([
      ['Tangle Wire', '139', 'NEM', 'nonfoil', 1296],
      ['Dwarven Miner', undefined, 'ZNL', 'nonfoil', 88],
      ['Samwise the Stouthearted', '28', 'LTR', 'foil', 39],
      ['Saradoc, Master of Buckland (V.1)', '282', 'XLTR', 'nonfoil', 36],
    ]);
  });

  it('reads a CardTrader packing slip: wrapped names and numbers, line totals turned into per-copy prices', () => {
    const row = (y: number, cells: [number, string][]): PdfRow => ({ page: 1, y, words: cells.map(([x, s]) => ({ x, s })) });
    const rows: PdfRow[] = [
      row(704, [[28, 'Code:'], [98, '20260819mf4dnh']]),
      row(642, [[282, 'Seller:'], [340, 'Ct connect']]),
      row(624, [[288, 'Date:'], [340, '19 Aug 2026, 04:01AM']]),
      row(362, [[30, 'Qty'], [238, 'Item description'], [529, 'Item']]),
      row(323, [[38, '3'], [54, 'Open the Way'], [239, 'March of the Machine: The Aftermath'], [448, 'SP, EN, 023'], [526, '€4.68']]),
      row(302, [[38, '1'], [54, 'Bloodsworn Squire //'], [239, 'Innistrad: Crimson Vow'], [448, 'NM, EN, 097'], [527, '€0.19']]),
      row(285, [[54, 'Bloodsworn Knight']]),
      row(264, [[38, '1'], [54, 'Six'], [239, 'Secret Lair Drop Series'], [448, 'NM, EN, Foil,'], [526, '€19.26']]),
      row(247, [[448, '2660']]),
      row(200, [[400, 'Total'], [520, '€24.13']]),
      row(180, [[28, 'Attention: This is not an invoice!']]),
    ];
    const o = parseCardtraderPdf(rows);
    expect(o).toMatchObject({ orderId: '20260819mf4dnh', seller: 'Ct connect', date: day('2026-08-19') });
    expect(o.lines.map((l) => [l.quantity, l.name, l.collectorNumber, l.finish, l.unitCents])).toEqual([
      [3, 'Open the Way', '023', 'nonfoil', 156],
      [1, 'Bloodsworn Squire // Bloodsworn Knight', '097', 'nonfoil', 19],
      [1, 'Six', '2660', 'foil', 1926],
    ]);
  });

  it('strips the treatment a marketplace puts in the title', () => {
    expect(cleanCardName("Baldur's Gate (Extended Art)")).toBe("Baldur's Gate");
    expect(cleanCardName('Saradoc, Master of Buckland (V.1)')).toBe('Saradoc, Master of Buckland');
  });
});

// ---- matching ---------------------------------------------------------------

const PRINT = 's-wire';
const add = (over: Partial<UserEvent> & { id: string }): UserEvent => ({
  ts: day('2026-07-16'),
  updatedAt: day('2026-07-16'),
  kind: 'collection.add',
  oracleId: 'o-wire',
  scryfallId: PRINT,
  qty: 1,
  condition: 'NM',
  finish: 'nonfoil',
  lang: 'en',
  priceEurCents: 2539,
  ...over,
});
const row = (qty: number): CollectionEntry => ({
  id: 'row',
  oracleId: 'o-wire',
  scryfallId: PRINT,
  condition: 'NM',
  finish: 'nonfoil',
  lang: 'en',
  quantity: qty,
  quantityForTrade: 0,
  createdAt: 0,
  updatedAt: 0,
});
const want = (over: Partial<PlanLine> = {}): PlanLine => ({
  scryfallId: PRINT,
  finish: 'nonfoil',
  lang: 'en',
  condition: 'LP',
  quantity: 1,
  ...over,
});
const BATCH = 'purchase-cardmarket-1';
const opts = { batchId: BATCH, date: day('2023-09-26') };

describe('planPurchase', () => {
  it('finds a copy that was scanned in and has since been traded away', () => {
    const events = [
      add({ id: 'scan', source: 'scan' }),
      { ...add({ id: 'gone', kind: 'collection.remove', reason: 'traded', source: 'trade', tradeId: 't1' }) },
    ];
    const [plan] = planPurchase([want()], events, [], opts);
    expect(plan!.matches.map((m) => m.eventId)).toEqual(['scan']);
    expect(plan!.missing).toBe(0);
    expect(plan!.owned).toBe(0);
  });

  it('skips copies received in a trade or opened from sealed, but takes a trade backfill', () => {
    const events = [
      add({ id: 'received', source: 'trade', tradeId: 't1' }),
      add({ id: 'cracked', source: 'sealed' }),
      add({ id: 'backfill', source: 'trade', tradeId: 't2', reconcile: true }),
    ];
    const [plan] = planPurchase([want()], events, [], opts);
    expect(plan!.matches.map((m) => m.eventId)).toEqual(['backfill']);
  });

  it('never takes a copy registered before the purchase, nor one another order claimed', () => {
    const events = [
      add({ id: 'before', ts: day('2023-01-01') }),
      add({ id: 'claimed', batchId: 'purchase-cardtrader-x' }),
    ];
    const [plan] = planPurchase([want()], events, [row(2)], opts);
    expect(plan!.matches).toEqual([]);
    expect(plan!.missing).toBe(1);
  });

  it('without a date, any unclaimed copy will do, oldest first', () => {
    const events = [add({ id: 'new', ts: day('2026-09-01') }), add({ id: 'old', ts: day('2022-01-01') })];
    const [plan] = planPurchase([want()], events, [], { batchId: BATCH, date: null });
    expect(plan!.matches.map((m) => m.eventId)).toEqual(['old']);
  });

  it('a second import of the same order finds the copies it updated last time', () => {
    const events = [add({ id: 'other', ts: day('2026-07-16') }), add({ id: 'mine', ts: day('2023-09-26'), batchId: BATCH })];
    const [plan] = planPurchase([want()], events, [], opts);
    expect(plan!.matches.map((m) => m.eventId)).toEqual(['mine']);
    expect(plan!.reimport).toBe(true);
  });

  it('on a re-import, two lines of one card at two prices each take back their own copy', () => {
    const events = [add({ id: 'a', batchId: BATCH, priceEurCents: 814 }), add({ id: 'b', batchId: BATCH, priceEurCents: 937 })];
    const plans = planPurchase([want({ unitCents: 937 }), want({ unitCents: 814 })], events, [], opts);
    expect(plans.map((p) => p.matches[0]!.eventId)).toEqual(['b', 'a']);
  });

  it('hands each line copies of its own grade first, then splits what is left', () => {
    const events = [add({ id: 'scan4', qty: 4, condition: 'NM' }), add({ id: 'lp1', condition: 'LP' })];
    const plans = planPurchase([want({ condition: 'NM', quantity: 1 }), want({ condition: 'LP', quantity: 3 })], events, [], opts);
    expect(plans[0]!.matches).toMatchObject([{ eventId: 'scan4', take: 1 }]);
    expect(plans[1]!.matches).toMatchObject([
      { eventId: 'lp1', take: 1 },
      { eventId: 'scan4', take: 2 },
    ]);
  });

  it('ignores other finishes and languages', () => {
    const events = [add({ id: 'foil', finish: 'foil' }), add({ id: 'de', lang: 'de' })];
    const [plan] = planPurchase([want()], events, [], opts);
    expect(plan!.missing).toBe(1);
  });
});

// ---- writing ----------------------------------------------------------------

describe('commitPurchase', () => {
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => day('2026-10-16'));
    await Promise.all([...USER_DATA_TABLES, db.outbox].map((t) => t.clear()));
  });
  afterEach(() => vi.restoreAllMocks());

  const line = { oracleId: 'o-wire', scryfallId: PRINT, condition: 'LP' as const, finish: 'nonfoil' as const, lang: 'en', unitCents: 1296 };
  const label = { batchId: BATCH, batchLabel: 'Bought on Cardmarket', date: day('2023-09-26') };

  it("re-dates and re-prices a traded-away copy's add without touching the collection", async () => {
    await db.events.bulkPut([
      add({ id: 'scan', source: 'scan' }),
      add({ id: 'gone', kind: 'collection.remove', ts: day('2026-09-03'), reason: 'traded', tradeId: 't1' }),
    ]);
    const res = await commitPurchase([{ ...line, matches: [{ eventId: 'scan', take: 1, ts: 0, priceEurCents: 2539 }] }], label);
    expect(res).toBe(1);
    expect(await db.collection.count()).toBe(0);
    expect(await db.events.get('scan')).toMatchObject({
      ts: day('2023-09-26'),
      priceEurCents: 1296,
      batchId: BATCH,
      batchLabel: 'Bought on Cardmarket',
      source: 'scan',
      updatedAt: day('2026-10-16'),
    });
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });

  it('splits an add when the order bought fewer copies than it covers, leaving the rest as they were', async () => {
    await db.events.put(add({ id: 'scan4', qty: 4 }));
    await commitPurchase(
      [
        { ...line, matches: [{ eventId: 'scan4', take: 1, ts: 0, priceEurCents: 0 }] },
        { ...line, unitCents: 50, matches: [{ eventId: 'scan4', take: 2, ts: 0, priceEurCents: 0 }] },
      ],
      label,
    );
    const all = await db.events.toArray();
    const rest = all.find((e) => e.id === 'scan4')!;
    expect(rest).toMatchObject({ qty: 1, ts: day('2026-07-16'), priceEurCents: 2539 });
    const bought = all.filter((e) => e.batchId === BATCH).map((e) => [e.qty, e.priceEurCents, e.ts]);
    expect(bought.sort()).toEqual([
      [1, 1296, day('2023-09-26')],
      [2, 50, day('2023-09-26')],
    ]);
    expect(all.reduce((s, e) => s + (e.qty ?? 0), 0)).toBe(4);
  });

  it("dates the copies an earlier, dateless import of the same order pinned", async () => {
    await db.events.bulkPut([
      add({ id: 'csv-only', batchId: BATCH, priceEurCents: 80 }),
      // The questionnaire's swap: that copy left today, whatever the order's date.
      add({ id: 'swapped', kind: 'collection.remove', reason: 'other', batchId: BATCH, ts: day('2026-10-16') }),
    ]);
    await commitPurchase([], label);
    expect(await db.events.get('csv-only')).toMatchObject({ ts: day('2023-09-26'), priceEurCents: 80 });
    expect((await db.events.get('swapped'))!.ts).toBe(day('2026-10-16'));
  });

  // Ticked copies go through the shared intake write (applyImport), which
  // takes the receipt's date and price instead of now and the market.
  it('adds ticked copies as bought on the order, through the shared import write', async () => {
    const copy = { oracleId: 'o-wire', scryfallId: PRINT, condition: 'LP' as const, finish: 'nonfoil' as const, lang: 'en' };
    const res = await applyImport(
      [{ ...copy, quantity: 2, quantityForTrade: 0, acquired: { ts: day('2023-09-26'), priceEurCents: 1296 } }],
      { source: 'import', batchId: BATCH, batchLabel: 'Bought on Cardmarket' },
    );
    expect(res.cards).toBe(2);
    expect(await db.collection.toArray()).toMatchObject([{ scryfallId: PRINT, condition: 'LP', quantity: 2 }]);
    expect(await db.events.toArray()).toMatchObject([
      { kind: 'collection.add', qty: 2, ts: day('2023-09-26'), updatedAt: day('2026-10-16'), priceEurCents: 1296, source: 'import', batchId: BATCH },
    ]);
  });

  it('merges two receipt lines of one copy into one add at their average price', async () => {
    const base = { oracleId: 'o-wire', scryfallId: PRINT, name: 'Tangle Wire', quantityForTrade: 0, condition: 'NM' as const, finish: 'nonfoil' as const, lang: 'en' };
    const [merged] = await buildIntakeLines([
      { ...base, quantity: 1, acquired: { ts: 1, priceEurCents: 814 } },
      { ...base, quantity: 1, acquired: { ts: 1, priceEurCents: 937 } },
    ]);
    expect(merged!.line).toMatchObject({ quantity: 2, acquired: { ts: 1, priceEurCents: 876 } });
  });
});

describe('purchase events elsewhere', () => {
  it("trusts a purchased foil's price even though it predates foil pricing", () => {
    const foil = add({ id: 'f', finish: 'foil', ts: day('2023-09-26'), priceEurCents: 39 });
    expect(costBasisOf([foil], PRINT, undefined, 'foil')!.crossFinish).toBe(true);
    expect(costBasisOf([{ ...foil, batchId: BATCH }], PRINT, undefined, 'foil')!.crossFinish).toBe(false);
  });

  it('never offers to undo a purchase import', () => {
    const groups = [
      { id: 'b:purchase', events: [add({ id: 'p', batchId: BATCH })] },
      { id: 'b:other', events: [add({ id: 'o', scryfallId: 's-other', batchId: 'scan-1' })] },
    ];
    expect([...undoableIds(groups)]).toEqual(['b:other']);
  });
});
