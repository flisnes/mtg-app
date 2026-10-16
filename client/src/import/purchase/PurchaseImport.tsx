import { useMemo, useRef, useState } from 'react';
import { PURCHASE_BATCH_PREFIX, type CollectionEntry, type Printing, type UserEvent } from '@mtg/shared';
import { db } from '../../db/schema.js';
import { Icon } from '../../components/icons.js';
import { useToast } from '../../components/Toast.js';
import { FINISH_LABELS } from '../../components/copyTraits.js';
import { fmtMoney } from '../../price/rates.js';
import { fmtDate, plural } from '../../util/format.js';
import { sha256Hex } from '../../util/sha256.js';
import {
  isCardmarketCsv,
  isCardmarketPdf,
  isCardtraderPdf,
  isCardtraderSheet,
  orderTotalCents,
  parseCardmarketCsv,
  parseCardmarketPdf,
  parseCardtraderPdf,
  parseCardtraderSheet,
  type PurchaseOrder,
} from './parse.js';
import { resolvePurchase, type ResolvedPurchaseLine } from './resolve.js';
import { planPurchase, type LinePlan, type PlannedMatch } from './plan.js';
import { commitPurchase, type CommitLine } from './commit.js';
import { describeFiling, useIntakeReview } from '../intake/useIntakeReview.js';
import type { ResolvedLine } from '../types.js';

// Import a marketplace order: set when each card was bought and what it cost.
// Copies already registered (still owned or long since traded away) get their
// acquisition corrected; the rest can be added. See plan.ts for the matching.

const MARKET = { cardmarket: 'Cardmarket', cardtrader: 'CardTrader' } as const;

async function readOrder(file: File): Promise<PurchaseOrder> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const { pdfRows } = await import('./pdfText.js');
    const rows = await pdfRows(await file.arrayBuffer());
    if (isCardmarketPdf(rows)) return parseCardmarketPdf(rows);
    if (isCardtraderPdf(rows)) return parseCardtraderPdf(rows);
    throw new Error("This PDF isn't a Cardmarket purchase or a CardTrader packing slip");
  }
  if (ext === 'xls') {
    const { readXls } = await import('./xls.js');
    const sheet = readXls(await file.arrayBuffer());
    if (isCardtraderSheet(sheet.rows)) return parseCardtraderSheet(sheet.name, sheet.rows);
    throw new Error("This spreadsheet isn't a CardTrader order export");
  }
  if (ext === 'xlsx') throw new Error('Only the older .xls format can be read. CardTrader exports that one.');
  const text = await file.text();
  if (isCardmarketCsv(text)) return parseCardmarketCsv(text, file.name);
  throw new Error("This file isn't a Cardmarket CSV, CardTrader XLS or either site's PDF");
}

/** The batch id an order's events share, stable across re-imports of it. */
async function batchIdOf(order: PurchaseOrder): Promise<string> {
  const key =
    order.orderId?.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) ||
    (await sha256Hex(JSON.stringify(order.lines))).slice(0, 16);
  return `${PURCHASE_BATCH_PREFIX}${order.source}-${key}`;
}

const isoDay = (ts: number | null) => (ts == null ? '' : new Date(ts).toISOString().slice(0, 10));
const fromIsoDay = (s: string): number | null => {
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
};
const eur = (cents: number | null | undefined) => (cents == null ? 'no price' : fmtMoney(cents / 100, 'EUR'));

interface Loaded {
  order: PurchaseOrder;
  lines: ResolvedPurchaseLine[];
  events: UserEvent[];
  collection: CollectionEntry[];
  /** The printings of the copies you have of these cards, to say which you own instead. */
  owned: Map<string, Printing>;
  batchId: string;
}

type State = { kind: 'idle' } | { kind: 'reading' } | { kind: 'review'; data: Loaded } | { kind: 'error'; message: string };

export function PurchaseImport({ onActive }: { onActive?: (active: boolean) => void }) {
  const [state, setStateRaw] = useState<State>({ kind: 'idle' });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const setState = (s: State) => {
    setStateRaw(s);
    onActive?.(s.kind === 'review' || s.kind === 'reading');
  };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setState({ kind: 'reading' });
    try {
      const order = await readOrder(file);
      if (!order.lines.length) throw new Error('No cards found in this file');
      const lines = await resolvePurchase(order);
      const oracleIds = [...new Set(lines.flatMap((l) => (l.printing ? [l.printing.oracleId] : [])))];
      const [events, collection] = await Promise.all([
        db.events.where('oracleId').anyOf(oracleIds).toArray(),
        db.collection.where('oracleId').anyOf(oracleIds).toArray(),
      ]);
      const ownedIds = [...new Set(collection.map((r) => r.scryfallId))];
      const owned = new Map((await db.printings.bulkGet(ownedIds)).flatMap((p) => (p ? [[p.scryfallId, p] as const] : [])));
      setState({ kind: 'review', data: { order, lines, events, collection, owned, batchId: await batchIdOf(order) } });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }

  if (state.kind === 'review') return <PurchaseReview data={state.data} onDone={() => setState({ kind: 'idle' })} />;

  return (
    <div className="about-section">
      <h2>Purchase history</h2>
      <p className="fine-print">
        Got an old order from Cardmarket (CSV or PDF) or CardTrader (XLS or PDF)? It sets when you bought each card and
        what you paid, including cards you have since traded away.
      </p>
      {state.kind === 'error' && <p className="gate-error">{state.message}</p>}
      <div className="import-actions">
        <input ref={fileRef} type="file" accept=".csv,.xls,.pdf,text/csv,application/pdf" onChange={onFile} hidden />
        <button onClick={() => fileRef.current?.click()} disabled={state.kind === 'reading'}>
          <Icon name="receipt" size={16} /> {state.kind === 'reading' ? 'Reading…' : 'Import an order'}
        </button>
      </div>
    </div>
  );
}

function PurchaseReview({ data, onDone }: { data: Loaded; onDone: () => void }) {
  const { order, lines } = data;
  const toast = useToast();
  // Ticked cards go in the way every bulk add does: "is this the copy you
  // have?", then where it lives.
  const { open: intake, sheet: intakeSheet } = useIntakeReview();
  const [day, setDay] = useState(isoDay(order.date));
  const date = fromIsoDay(day);
  // Per line: update its matched copies (default on), add the missing ones (default off).
  const [skipUpdate, setSkipUpdate] = useState<Set<number>>(new Set());
  const [addMissing, setAddMissing] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const plans: (LinePlan | null)[] = useMemo(() => {
    const resolved = lines.flatMap((l, i) => (l.printing ? [{ i, l, p: l.printing }] : []));
    const planned = planPurchase(
      resolved.map(({ l, p }) => ({
        scryfallId: p.scryfallId,
        finish: l.finish,
        lang: l.line.lang,
        condition: l.line.condition,
        quantity: l.line.quantity,
        unitCents: l.line.unitCents,
      })),
      data.events,
      data.collection,
      { batchId: data.batchId, date },
    );
    const out: (LinePlan | null)[] = lines.map(() => null);
    resolved.forEach(({ i }, k) => (out[i] = planned[k]!));
    return out;
  }, [lines, data, date]);

  const toggle = (set: Set<number>, i: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(i);
    else next.delete(i);
    return next;
  };

  // A matched copy only counts as a change when the order would move its date
  // or its price. A re-import, or a card you already fixed by hand, has none.
  const changes = (i: number, m: PlannedMatch) => {
    const ts = date ?? m.ts;
    const cents = lines[i]!.line.unitCents;
    return { ts, cents, any: ts !== m.ts || cents !== m.priceEurCents };
  };
  const changing = (i: number) => plans[i]?.matches.filter((m) => changes(i, m).any) ?? [];
  const all = lines.map((_, i) => i);
  const found = all.filter((i) => changing(i).length > 0);
  const upToDate = all.filter((i) => (plans[i]?.matches.length ?? 0) > 0 && changing(i).length === 0);
  const missing = all.filter((i) => (plans[i]?.missing ?? 0) > 0);
  const unresolved = all.filter((i) => !lines[i]!.printing);
  const copies = (i: number) => changing(i).reduce((s, m) => s + m.take, 0);
  const upToDateCopies = upToDate.reduce((s, i) => s + plans[i]!.matches.reduce((n, m) => n + m.take, 0), 0);
  const updating = found.filter((i) => !skipUpdate.has(i)).reduce((s, i) => s + copies(i), 0);
  const adding = missing.filter((i) => addMissing.has(i)).reduce((s, i) => s + plans[i]!.missing, 0);
  const gone = found.filter((i) => plans[i]!.owned === 0).reduce((s, i) => s + copies(i), 0);
  const reimport = plans.some((p) => p?.reimport);
  const market = MARKET[order.source];
  const totalCopies = order.lines.reduce((s, l) => s + l.quantity, 0);

  async function apply() {
    setBusy(true);
    try {
      const label = `Bought on ${market}${order.seller ? ` from ${order.seller}` : ''}`;
      const toAdd: ResolvedLine[] = missing
        .filter((i) => addMissing.has(i))
        .map((i) => {
          const l = lines[i]!;
          return {
            oracleId: l.printing!.oracleId,
            scryfallId: l.printing!.scryfallId,
            name: l.name,
            quantity: plans[i]!.missing,
            quantityForTrade: 0,
            condition: l.line.condition,
            finish: l.finish,
            lang: l.line.lang,
            pinnedPrinting: true,
            acquired: { ts: date, priceEurCents: l.line.unitCents },
          };
        });
      // First, because it can be backed out of: then nothing at all is written
      // and the review is still here.
      let added = 0;
      let filing = '';
      if (toAdd.length) {
        const res = await intake({
          flow: 'collection',
          lines: toAdd,
          source: 'import',
          label,
          batchId: data.batchId,
          incomingLabel: market,
        });
        if (!res) return;
        added = res.added;
        filing = describeFiling(res);
      }
      const commit: CommitLine[] = found
        .filter((i) => !skipUpdate.has(i))
        .map((i) => ({ unitCents: lines[i]!.line.unitCents, matches: changing(i) }));
      const updated = await commitPurchase(commit, { batchId: data.batchId, batchLabel: label, date });
      const parts = [
        updated > 0 && `updated ${updated} ${plural(updated, 'card')}`,
        added > 0 && `added ${added}`,
      ].filter(Boolean);
      toast(parts.length ? `${market} order: ${parts.join(', ')}${filing}` : 'Nothing changed');
      onDone();
    } catch (err) {
      toast(`Couldn't import the order: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // "You have a foil copy", "you have PNEO #60p": the usual reason a card
  // you're sure you own shows up as never registered. Edition first.
  const ownedInstead = (l: ResolvedPurchaseLine): string | null => {
    const p = l.printing;
    if (!p) return null;
    const rows = data.collection.filter((r) => r.oracleId === p.oracleId);
    if (!rows.length) return null;
    const same = rows.filter((r) => r.scryfallId === p.scryfallId);
    if (same.length) {
      const kinds = [...new Set(same.map((r) => (r.finish !== l.finish ? FINISH_LABELS[r.finish].toLowerCase() : r.lang.toUpperCase())))];
      return `you have a ${kinds.join(' and ')} copy of this edition`;
    }
    const eds = [...new Set(rows.map((r) => {
      const o = data.owned.get(r.scryfallId);
      return o ? `${o.set.toUpperCase()} #${o.collectorNumber}` : 'another edition';
    }))];
    return `you have it as ${eds.slice(0, 3).join(', ')}`;
  };

  const where = (l: ResolvedPurchaseLine) =>
    [
      l.printing ? `${l.printing.set.toUpperCase()} #${l.printing.collectorNumber}` : l.line.setCode ?? l.line.setName,
      l.line.conditionLabel,
      l.finish !== 'nonfoil' ? FINISH_LABELS[l.finish] : null,
      l.line.lang !== 'en' ? l.line.lang.toUpperCase() : null,
      `${eur(l.line.unitCents)}${l.line.quantity > 1 ? ' each' : ''}`,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="about-section purchase-review">
      <h2>
        {market} order{order.orderId ? ` ${order.orderId}` : ''}
      </h2>
      <p className="fine-print">
        {[order.seller, `${totalCopies} ${plural(totalCopies, 'card')}`, eur(orderTotalCents(order)) + ' before shipping']
          .filter(Boolean)
          .join(' · ')}
      </p>

      <div className="import-fields">
        <label className="import-field">
          <span>Bought on</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Purchase date" />
        </label>
      </div>
      <p className="fine-print">
        {order.date != null
          ? order.fileKind === 'pdf'
            ? 'From the receipt.'
            : 'From the order code.'
          : 'This file has no date. Leave it empty to keep the dates on record and only set the prices.'}
      </p>
      {reimport && (
        <p className="fine-print">You've imported this order before. Importing it again updates the same copies.</p>
      )}

      <dl className="kv">
        <dt>Will change</dt>
        <dd>
          {updating} {plural(updating, 'card')}
          {gone > 0 ? `, ${gone} no longer in your collection` : ''}
        </dd>
        {upToDateCopies > 0 && (
          <>
            <dt>Up to date</dt>
            <dd>{upToDateCopies}</dd>
          </>
        )}
        <dt>Not found</dt>
        <dd>{missing.reduce((s, i) => s + plans[i]!.missing, 0)}</dd>
        {unresolved.length > 0 && (
          <>
            <dt>Not identified</dt>
            <dd>{unresolved.reduce((s, i) => s + lines[i]!.line.quantity, 0)}</dd>
          </>
        )}
      </dl>

      {found.length > 0 && (
        <>
          <h3>Found in your history</h3>
          <p className="fine-print">Each copy's date and price as saved now, and what this order sets them to.</p>
          <div className="chips" role="group" aria-label="Choose which cards to update">
            <button className="chip" onClick={() => setSkipUpdate(new Set())} disabled={skipUpdate.size === 0}>
              Select all
            </button>
            <button className="chip" onClick={() => setSkipUpdate(new Set(found))} disabled={updating === 0}>
              Select none
            </button>
          </div>
          <ul className="result-list">
            {found.map((i) => {
              const l = lines[i]!;
              const plan = plans[i]!;
              const ms = changing(i);
              const grades = new Set(ms.map((m) => m.condition).filter(Boolean));
              const notes = [
                plan.owned === 0 && 'no longer in your collection',
                grades.size > 0 && !grades.has(l.line.condition) && `you have it as ${[...grades].join('/')}`,
              ].filter(Boolean);
              return (
                <li key={i} className="result-row purchase-line">
                  <label className="purchase-check">
                    <input
                      type="checkbox"
                      checked={!skipUpdate.has(i)}
                      onChange={(e) => setSkipUpdate(toggle(skipUpdate, i, !e.target.checked))}
                    />
                    <div className="result-main">
                      <div className="result-name">
                        {copies(i)}× {l.name}
                      </div>
                      <div className="result-sub">{where(l)}</div>
                      {ms.map((m) => {
                        const c = changes(i, m);
                        const after = [c.ts !== m.ts && fmtDate(c.ts), c.cents !== m.priceEurCents && eur(c.cents)].filter(Boolean);
                        return (
                          <div key={m.eventId} className="result-sub purchase-change">
                            {ms.length > 1 ? `${m.take}× ` : ''}
                            {fmtDate(m.ts)}, {eur(m.priceEurCents)} → <strong>{after.join(', ')}</strong>
                          </div>
                        );
                      })}
                      {notes.length > 0 && <div className="result-sub">{notes.join(' · ')}</div>}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {missing.length > 0 && (
        <>
          <h3>Not found in your history</h3>
          <p className="fine-print">
            No copy of this edition, finish and language was ever registered. If you have them, tick to add them as
            bought on this order.
          </p>
          <ul className="result-list">
            {missing.map((i) => {
              const l = lines[i]!;
              const n = plans[i]!.missing;
              return (
                <li key={i} className="result-row purchase-line">
                  <label className="purchase-check">
                    <input
                      type="checkbox"
                      checked={addMissing.has(i)}
                      onChange={(e) => setAddMissing(toggle(addMissing, i, e.target.checked))}
                    />
                    <div className="result-main">
                      <div className="result-name">
                        {n}× {l.name}
                      </div>
                      <div className="result-sub">{where(l)}</div>
                      {ownedInstead(l) && <div className="result-sub">{ownedInstead(l)}</div>}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {unresolved.length > 0 && (
        <>
          <h3>Couldn't identify</h3>
          <p className="fine-print">These are skipped.</p>
          <ul className="result-list">
            {unresolved.map((i) => {
              const l = lines[i]!;
              return (
                <li key={i} className="result-row purchase-line">
                  <div className="result-main">
                    <div className="result-name">
                      {l.line.quantity}× {l.name}
                    </div>
                    <div className="result-sub">
                      {where(l)} · {l.problem}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}


      {upToDate.length > 0 && (
        <details className="purchase-uptodate">
          <summary>
            Already up to date ({upToDateCopies} {plural(upToDateCopies, 'card')})
          </summary>
          <ul className="result-list">
            {upToDate.map((i) => {
              const l = lines[i]!;
              const m = plans[i]!.matches[0]!;
              return (
                <li key={i} className="result-row purchase-line">
                  <div className="result-main">
                    <div className="result-name">
                      {plans[i]!.matches.reduce((n, x) => n + x.take, 0)}× {l.name}
                    </div>
                    <div className="result-sub">
                      {where(l)} · {fmtDate(m.ts)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <div className="sheet-actions">
        <button onClick={onDone} disabled={busy}>
          Back
        </button>
        <button className="primary" onClick={() => void apply()} disabled={busy || (updating === 0 && adding === 0)}>
          {busy
            ? 'Saving…'
            : [updating > 0 && `Update ${updating}`, adding > 0 && `add ${adding}`].filter(Boolean).join(' · ') ||
              'Nothing to do'}
        </button>
      </div>
      {intakeSheet}
    </div>
  );
}
