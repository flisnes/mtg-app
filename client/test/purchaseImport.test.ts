import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeCardmarketIndex,
  encodeCardmarketIndex,
  type CollectionEntry,
  type OracleCard,
  type Printing,
  type UserEvent,
} from '@mtg/shared';
import { db, USER_DATA_TABLES } from '../src/db/schema.js';
import {
  cleanCardName,
  dateOfCardtraderCode,
  parseCardmarketCsv,
  parseCardmarketPdf,
  parseCardtraderPdf,
  parseCardtraderSheet,
  parseMoneyCents,
  type PdfRow,
} from '../src/import/purchase/parse.js';
import { readXls } from '../src/import/purchase/xls.js';
import { resolvePurchase } from '../src/import/purchase/resolve.js';
import { planPurchase, reviewOf, type PlanLine } from '../src/import/purchase/plan.js';
import { commitPurchase } from '../src/import/purchase/commit.js';
import { applyImport } from '../src/db/collectionWrites.js';
import { buildIntakeLines } from '../src/import/intake/model.js';
import { costBasisOf } from '../src/price/costBasis.js';
import { undoableIds } from '../src/db/undoScope.js';
import { describeBatch } from '../src/history/eventRegistry.js';
import { buildXls } from './xlsFixture.js';

// Purchase import (v0.201.0): marketplace order files in, acquisition dates and
// prices out. The parsers are pinned on hand-made copies of the four file
// shapes; the matcher on the cases that motivated it, chief among them a copy
// that was scanned in and has since been traded away.

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

describe('parsers', () => {
  it('reads money the German and the English way, thousands and all', () => {
    expect(parseMoneyCents('12,96')).toBe(1296);
    expect(parseMoneyCents('0,39')).toBe(39);
    expect(parseMoneyCents('12.96')).toBe(1296);
    expect(parseMoneyCents('€4.68')).toBe(468);
    // v0.201.0 read these as 1% of their value: the first comma became the point.
    expect(parseMoneyCents('1.234,56 EUR')).toBe(123456);
    expect(parseMoneyCents('€1,234.56')).toBe(123456);
    expect(parseMoneyCents('2.000,00')).toBe(200000);
    // A lone separator with three digits after it groups thousands; receipts always print cents.
    expect(parseMoneyCents('1.234')).toBe(123400);
    expect(parseMoneyCents('7')).toBe(700);
    expect(parseMoneyCents('')).toBe(0);
  });

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

  it("turns CardTrader's language codes into Scryfall's, and takes the marketplaces' grade words", () => {
    const head = ['Item Name', 'Set Code', 'Price in EUR Cents', 'Quantity', 'Condition', 'Language', 'Foil/Reverse', 'Collector Number'];
    const o = parseCardtraderSheet('CardTrader order #20260819mf4dnh', [
      head,
      ['Insight', 'TMP', 281, 1, 'Near Mint', 'jp', false, '068'],
      ['Insight', 'TMP', 281, 1, 'Played', 'zh-CN', false, '068'],
      ['Insight', 'TMP', 281, 1, 'Moderately Played', 'zh-TW', false, '068'],
      ['Insight', 'TMP', 281, 1, 'Poor', 'de', false, '068'],
    ]);
    expect(o.lines.map((l) => [l.lang, l.condition])).toEqual([
      ['ja', 'NM'],
      ['zhs', 'HP'],
      ['zht', 'MP'],
      ['de', 'DMG'],
    ]);
  });

  it('reads a real BIFF8 workbook: shared strings across a CONTINUE, RK and formula cells, and a cut-short file', () => {
    const head = ['Set Name', 'Set Code', 'Item Name', 'Price in EUR Cents', 'Quantity', 'Condition', 'Language', 'Foil/Reverse', 'Collector Number'];
    const file = buildXls(
      'CardTrader order #202607034z00we',
      [
        ['Game'],
        head,
        ['Secrets of Strixhaven', 'SOS', 'Emeritus of Truce // Swords to Plowshares', 387, { rk: 1 }, 'Near Mint', 'en', false, '013'],
        ['Commander: Secrets of Strixhaven', 'SOC', { formula: 'Ominous Harvest' }, { formula: 129 }, 1, 'Slightly Played', 'en', { formula: true }, '028'],
        ['Tempest', 'TMP', 'Dépêche', { rk: 281 }, 2, 'Poor', 'en', true, '068'],
      ],
      // Split the long name across a CONTINUE record.
      { splitSst: head.length + 2 },
    );
    const sheet = readXls(file);
    expect(sheet.name).toBe('CardTrader order #202607034z00we');
    expect(sheet.rows[2]).toEqual(['Secrets of Strixhaven', 'SOS', 'Emeritus of Truce // Swords to Plowshares', 387, 1, 'Near Mint', 'en', false, '013']);
    expect(sheet.rows[3]).toEqual(['Commander: Secrets of Strixhaven', 'SOC', 'Ominous Harvest', 129, 1, 'Slightly Played', 'en', true, '028']);
    expect(sheet.rows[4]).toEqual(['Tempest', 'TMP', 'Dépêche', 281, 2, 'Poor', 'en', true, '068']);
    const o = parseCardtraderSheet(sheet.name, sheet.rows);
    expect(o.date).toBe(day('2026-07-03'));
    expect(o.lines.map((l) => [l.name, l.unitCents, l.quantity, l.condition, l.finish])).toEqual([
      ['Emeritus of Truce // Swords to Plowshares', 387, 1, 'NM', 'nonfoil'],
      ['Ominous Harvest', 129, 1, 'LP', 'foil'],
      ['Dépêche', 281, 2, 'DMG', 'foil'],
    ]);
    // Anything but a readable workbook says so in one sentence: no RangeError in the toast.
    expect(() => readXls(file.subarray(0, 2000))).toThrow("Couldn't read this .xls file");
    expect(() => readXls(new Uint8Array(100))).toThrow("Couldn't read this .xls file");
    expect(() => readXls(new Uint8Array(4096))).toThrow("Couldn't read this .xls file");
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

  it('refuses either PDF when the prices are not in euros', () => {
    const row = (y: number, cells: [number, string][]): PdfRow => ({ page: 1, y, words: cells.map(([x, s]) => ({ x, s })) });
    expect(() =>
      parseCardtraderPdf([
        row(704, [[28, 'Code:'], [98, '20260819mf4dnh']]),
        row(362, [[30, 'Qty'], [238, 'Item description'], [529, 'Item']]),
        row(323, [[38, '3'], [54, 'Open the Way'], [239, 'March of the Machine'], [448, 'SP, EN, 023'], [526, '$4.68']]),
      ]),
    ).toThrow(/USD/);
    expect(() =>
      parseCardmarketPdf([
        { page: 1, y: 800, words: words('Purchase #1128566936') },
        { page: 1, y: 780, words: words('1 Tangle Wire 139 EN EX NEM R 12.96 GBP') },
      ]),
    ).toThrow(/GBP/);
    // Over a thousand euros on one line: the German thousands point stays a point.
    const o = parseCardmarketPdf([{ page: 1, y: 780, words: words('1 Black Lotus 232 EN EX LEA R 1.234,56 EUR') }]);
    expect(o.lines[0]!.unitCents).toBe(123456);
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

  it('leaves an add the review offered and the user unticked alone, even on a re-import with a date', async () => {
    await db.events.bulkPut([
      add({ id: 'kept', batchId: BATCH, ts: day('2024-01-01'), priceEurCents: 80 }),
      add({ id: 'other', batchId: BATCH, ts: day('2024-01-01'), priceEurCents: 90 }),
    ]);
    await commitPurchase([], { ...label, exclude: ['kept'] });
    expect((await db.events.get('kept'))!.ts).toBe(day('2024-01-01'));
    expect((await db.events.get('other'))!.ts).toBe(day('2023-09-26'));
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

// ---- the review, and importing twice -----------------------------------------

describe('reviewOf', () => {
  const lineOf = (unitCents: number, printing = true) => ({ quantity: 1, unitCents, printing });

  it('sorts lines into found, up to date, missing and unresolved', () => {
    const m = { eventId: 'e', take: 1, ts: day('2023-09-26'), priceEurCents: 1296 };
    const r = reviewOf(
      [lineOf(1296), lineOf(50), lineOf(1296), lineOf(1, false)],
      [
        { matches: [m], missing: 0, owned: 1, reimport: true },
        { matches: [m], missing: 0, owned: 0, reimport: false },
        { matches: [], missing: 1, owned: 0, reimport: false },
        null,
      ],
      day('2023-09-26'),
    );
    expect(r).toMatchObject({ found: [1], upToDate: [0], missing: [2], unresolved: [3], upToDateCopies: 1, reimport: true });
    expect(r.changing[1]).toEqual([{ ...m, toTs: day('2023-09-26'), toCents: 50 }]);
  });

  it('with no date, only a price can change', () => {
    const m = { eventId: 'e', take: 2, ts: day('2026-01-01'), priceEurCents: 1296 };
    const r = reviewOf([lineOf(1296)], [{ matches: [m], missing: 0, owned: 2, reimport: false }], null);
    expect(r.found).toEqual([]);
    expect(r.upToDateCopies).toBe(2);
  });
});

describe('importing an order twice', () => {
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => day('2026-10-16'));
    await Promise.all([...USER_DATA_TABLES, db.outbox].map((t) => t.clear()));
  });
  afterEach(() => vi.restoreAllMocks());

  const importOnce = async (lines: PlanLine[], date: number | null) => {
    const events = await db.events.toArray();
    const plans = planPurchase(lines, events, [], { batchId: BATCH, date });
    const review = reviewOf(lines.map((l) => ({ ...l, unitCents: l.unitCents ?? 0, printing: true })), plans, date);
    const commit = review.found.map((i) => ({ unitCents: lines[i]!.unitCents!, matches: review.changing[i]! }));
    const updated = await commitPurchase(commit, { batchId: BATCH, batchLabel: 'Bought on Cardmarket', date });
    return { review, updated };
  };
  const totals = async () => {
    const all = await db.events.toArray();
    return { events: all.length, qty: all.reduce((s, e) => s + (e.qty ?? 0), 0) };
  };

  it('finds nothing left to change the second time: no new events, the same copies', async () => {
    await db.events.bulkPut([add({ id: 'scan4', qty: 4, source: 'scan' }), add({ id: 'scan1', source: 'scan' })]);
    const first = await importOnce([want({ quantity: 1, unitCents: 1296 }), want({ quantity: 3, unitCents: 50 })], day('2023-09-26'));
    expect(first.updated).toBe(4);
    const after = await totals();
    expect(after.qty).toBe(5);
    const second = await importOnce([want({ quantity: 1, unitCents: 1296 }), want({ quantity: 3, unitCents: 50 })], day('2023-09-26'));
    expect(second.review.found).toEqual([]);
    expect(second.review.reimport).toBe(true);
    expect(second.updated).toBe(0);
    expect(await totals()).toEqual(after);
  });

  it("the order's CSV after its PDF changes nothing: same printing, same price, and no date to move", async () => {
    await db.events.put(add({ id: 'scan', source: 'scan' }));
    await importOnce([want({ unitCents: 1296 })], day('2023-09-26'));
    const csv = await importOnce([want({ unitCents: 1296 })], null);
    expect(csv.review.found).toEqual([]);
    expect(csv.review.upToDateCopies).toBe(1);
    expect((await db.events.get('scan'))!.ts).toBe(day('2023-09-26'));
  });
});

// ---- resolving lines to printings -------------------------------------------

describe('resolvePurchase', () => {
  const oracle = (oracleId: string, name: string): OracleCard => ({
    oracleId,
    name,
    manaCost: null,
    cmc: 0,
    typeLine: 'Instant',
    oracleText: null,
    colors: [],
    colorIdentity: [],
    rarity: 'common',
    imageSmall: null,
    imageNormal: null,
    defaultScryfallId: '',
  });
  const printing = (over: Pick<Printing, 'scryfallId' | 'oracleId' | 'set' | 'setName' | 'collectorNumber'> & Partial<Printing>): Printing => ({
    lang: 'en',
    finishes: ['nonfoil', 'foil'],
    releasedAt: '2020-01-01',
    imageSmall: null,
    imageNormal: null,
    ...over,
  });

  beforeEach(async () => {
    await db.oracleCards.clear();
    await db.printings.clear();
    await db.oracleCards.bulkPut([
      oracle('o-contempt', 'Tolarian Contempt'),
      oracle('o-miner', 'Dwarven Miner'),
      oracle('o-insight', 'Insight'),
      oracle('o-six', 'Six'),
      oracle('o-squire', 'Bloodsworn Squire // Bloodsworn Knight'),
    ]);
    await db.printings.bulkPut([
      printing({ scryfallId: 'p-contempt-mat', oracleId: 'o-contempt', set: 'mat', setName: 'March of the Machine: The Aftermath', collectorNumber: '108', finishes: ['nonfoil', 'etched'] }),
      printing({ scryfallId: 'p-miner-ody', oracleId: 'o-miner', set: 'ody', setName: 'Odyssey', collectorNumber: '313' }),
      printing({ scryfallId: 'p-miner-list', oracleId: 'o-miner', set: 'plst', setName: 'The List', collectorNumber: 'ODY-313' }),
      printing({ scryfallId: 'p-insight-tmp', oracleId: 'o-insight', set: 'tmp', setName: 'Tempest', collectorNumber: '68' }),
      printing({ scryfallId: 'p-insight-vis', oracleId: 'o-insight', set: 'vis', setName: 'Visions', collectorNumber: '34' }),
      printing({ scryfallId: 'p-six-sld', oracleId: 'o-six', set: 'sld', setName: 'Secret Lair Drop', collectorNumber: '2660' }),
      printing({ scryfallId: 'p-six-sld2', oracleId: 'o-six', set: 'sld', setName: 'Secret Lair Drop', collectorNumber: '2660★' }),
      printing({ scryfallId: 'p-six-plst', oracleId: 'o-six', set: 'plst', setName: 'The List', collectorNumber: 'SLD-2660' }),
      printing({ scryfallId: 'p-squire-vow', oracleId: 'o-squire', set: 'vow', setName: 'Innistrad: Crimson Vow', collectorNumber: '97' }),
    ]);
  });

  const line = (over: Partial<import('../src/import/purchase/parse.js').PurchaseLine>) => ({
    quantity: 1,
    unitCents: 100,
    condition: 'NM' as const,
    conditionLabel: 'NM',
    finish: 'nonfoil' as const,
    lang: 'en',
    ...over,
  });
  const resolve = (...lines: ReturnType<typeof line>[]) =>
    resolvePurchase({ source: 'cardtrader', fileKind: 'xls', orderId: null, date: null, lines });

  it("tries the parent set behind CardTrader's own code, and reads 108e as the etched 108", async () => {
    const [r] = await resolve(line({ name: 'Tolarian Contempt (Etched Foil)', setCode: 'CMAT', collectorNumber: '108e', finish: 'etched' }));
    expect(r!.printing?.scryfallId).toBe('p-contempt-mat');
    expect(r!.finish).toBe('etched');
    expect(r!.name).toBe('Tolarian Contempt');
  });

  it("finds a The List card by the original's number, when the set name says so", async () => {
    const [list, ody] = await resolve(
      line({ name: 'Dwarven Miner', setName: 'The List', collectorNumber: '313' }),
      line({ name: 'Dwarven Miner', setName: 'Odyssey', collectorNumber: '313' }),
    );
    expect(list!.printing?.scryfallId).toBe('p-miner-list');
    expect(ody!.printing?.scryfallId).toBe('p-miner-ody');
  });

  it('falls back to the name and a set name that clearly matches, and resolves the front face of a split card', async () => {
    const [insight, squire, vague] = await resolve(
      line({ name: 'Insight', setName: 'Tempest' }),
      line({ name: 'Bloodsworn Squire', setName: 'Innistrad: Crimson Vow', collectorNumber: '097' }),
      line({ name: 'Insight' }),
    );
    expect(insight!.printing?.scryfallId).toBe('p-insight-tmp');
    expect(squire!.printing?.scryfallId).toBe('p-squire-vow');
    expect(squire!.name).toBe('Bloodsworn Squire // Bloodsworn Knight');
    expect(vague!.printing).toBeNull();
    expect(vague!.problem).toMatch(/which printing of Insight/);
  });

  it('trusts the only printing with that number, and refuses to guess between several', async () => {
    const [one, several, unknown] = await resolve(
      line({ name: 'Insight', collectorNumber: '34' }),
      line({ name: 'Six', collectorNumber: '2660' }),
      line({ name: 'Insight Beyond', collectorNumber: '1' }),
    );
    expect(one!.printing?.scryfallId).toBe('p-insight-vis');
    expect(several!.printing).toBeNull();
    expect(several!.problem).toBe('Several printings of Six are numbered 2660');
    expect(unknown!.problem).toBe('No card called "Insight Beyond"');
  });
});

describe('the Cardmarket id index', () => {
  it('round-trips product ids and Scryfall id prefixes through the pipeline encoder and the client decoder', () => {
    const index = encodeCardmarketIndex([
      [723559, 'fedcba98-7654-3210-fedc-ba9876543210'],
      [11862, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
      [11863, '0123456789abcdef-0000-0000-0000-000000000000'],
    ]);
    expect(index.d).toEqual([11862, 1, 711696]);
    expect(index.s).toHaveLength(30);
    expect([...decodeCardmarketIndex(index)]).toEqual([
      [11862, 'a1b2c3d4e5'],
      [11863, '0123456789'],
      [723559, 'fedcba9876'],
    ]);
  });
});

describe('purchase events elsewhere', () => {
  it('names a purchase batch "Bought" even when the swap it starts with is a removal', () => {
    const swap = add({ id: 'swap', kind: 'collection.remove', batchId: BATCH });
    expect(describeBatch('import', undefined, [swap, add({ id: 'a', batchId: BATCH })]).verb).toBe('Bought');
    expect(describeBatch('import', 'Bought on Cardmarket', [swap]).verb).toBe('Bought on Cardmarket');
  });

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
