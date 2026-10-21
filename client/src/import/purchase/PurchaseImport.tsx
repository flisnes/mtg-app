import { useMemo, useRef, useState, type ReactNode } from 'react';
import { PURCHASE_BATCH_PREFIX, type CollectionEntry, type Printing, type UserEvent } from '@mtg/shared';
import { db } from '../../db/schema.js';
import { Icon } from '../../components/icons.js';
import { ScanListRow } from '../../components/ScanListRow.js';
import { useToast } from '../../components/Toast.js';
import { FINISH_LABELS } from '@mtg/shared';
import { useKeySet } from '../../components/useKeySet.js';
import { dayKeyOf, tsOfDayKey } from '../../price/history.js';
import { fmtCents, fmtDate, plural } from '../../util/format.js';
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
import { planPurchase, reviewOf, type LinePlan } from './plan.js';
import { commitPurchase, type CommitLine } from './commit.js';
import { describeCopy } from '../intake/model.js';
import { describeFiling, type IntakeConfig, type IntakeResult } from '../intake/useIntakeReview.js';
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

/** Stored EUR cents in the display currency, like "bought for" on the card sheet. */
const money = (cents: number | null | undefined) => (cents == null ? 'no price' : fmtCents(cents));

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

/** The page's intake questionnaire: ticked cards go in through it like every bulk add. */
export type IntakeOpen = (cfg: IntakeConfig) => Promise<IntakeResult | null>;

export function PurchaseImport({ intake, onActive }: { intake: IntakeOpen; onActive?: (active: boolean) => void }) {
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

  if (state.kind === 'review') return <PurchaseReview data={state.data} intake={intake} onDone={() => setState({ kind: 'idle' })} />;

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

/** One heading of the review: a title, a line of help, and the order's lines under it as list rows. */
function LineList({
  title,
  hint,
  toolbar,
  ids,
  lines,
  printings,
  row,
}: {
  title: ReactNode;
  hint?: ReactNode;
  toolbar?: ReactNode;
  ids: number[];
  lines: ResolvedPurchaseLine[];
  printings: Map<string, Printing>;
  /** How many copies the row is about, what to say under the name, and its tick when it has one. */
  row: (i: number) => { count: number; sub?: ReactNode; check?: { checked: boolean; onChange: (on: boolean) => void } };
}) {
  if (!ids.length) return null;
  return (
    <>
      <h3>{title}</h3>
      {hint && <p className="fine-print">{hint}</p>}
      {toolbar}
      <ul className="scan-list">
        {ids.map((i) => {
          const l = lines[i]!;
          const r = row(i);
          return (
            <ScanListRow
              key={i}
              image={l.printing?.imageSmall}
              name={`${r.count}× ${l.name}`}
              sub={
                <>
                  {describeLine(l, printings)}
                  {r.sub}
                </>
              }
              check={r.check}
            />
          );
        })}
      </ul>
    </>
  );
}

/** Set · number · the seller's grade · finish · language · price, as the filing prompt words a copy. */
function describeLine(l: ResolvedPurchaseLine, printings: Map<string, Printing>): string {
  const copy = describeCopy(
    { printings },
    { scryfallId: l.printing?.scryfallId ?? '', condition: l.line.conditionLabel, finish: l.finish, lang: l.line.lang },
  );
  const set = l.printing ? null : (l.line.setCode ?? l.line.setName);
  const price = `${money(l.line.unitCents)}${l.line.quantity > 1 ? ' each' : ''}`;
  return [set, copy, price].filter(Boolean).join(' · ');
}

function PurchaseReview({ data, intake, onDone }: { data: Loaded; intake: IntakeOpen; onDone: () => void }) {
  const { order, lines } = data;
  const toast = useToast();
  const [day, setDay] = useState(order.date == null ? '' : dayKeyOf(order.date));
  const date = tsOfDayKey(day);
  // Per line: update its matched copies (ticked unless skipped), add the missing ones (unticked unless picked).
  const skip = useKeySet();
  const add = useKeySet();
  const [busy, setBusy] = useState(false);
  const key = (i: number) => String(i);

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
  const review = useMemo(
    () => reviewOf(lines.map((l) => ({ quantity: l.line.quantity, unitCents: l.line.unitCents, printing: !!l.printing })), plans, date),
    [lines, plans, date],
  );
  const { found, upToDate, missing, unresolved, changing } = review;
  const printings = useMemo(
    () => new Map(lines.flatMap((l) => (l.printing ? [[l.printing.scryfallId, l.printing] as const] : []))),
    [lines],
  );

  const copies = (i: number) => changing[i]!.reduce((s, m) => s + m.take, 0);
  const updatingLines = found.filter((i) => !skip.has(key(i)));
  const updating = updatingLines.reduce((s, i) => s + copies(i), 0);
  const adding = missing.filter((i) => add.has(key(i))).reduce((s, i) => s + plans[i]!.missing, 0);
  const gone = updatingLines.filter((i) => plans[i]!.owned === 0).reduce((s, i) => s + copies(i), 0);
  const allPicked = updatingLines.length === found.length;
  const market = MARKET[order.source];
  const totalCopies = order.lines.reduce((s, l) => s + l.quantity, 0);

  async function apply() {
    setBusy(true);
    try {
      const label = `Bought on ${market}${order.seller ? ` from ${order.seller}` : ''}`;
      const toAdd: ResolvedLine[] = missing
        .filter((i) => add.has(key(i)))
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
      const commit: CommitLine[] = updatingLines.map((i) => ({ unitCents: lines[i]!.line.unitCents, matches: changing[i]! }));
      const exclude = found.filter((i) => skip.has(key(i))).flatMap((i) => changing[i]!.map((m) => m.eventId));
      let updated = 0;
      try {
        updated = await commitPurchase(commit, { batchId: data.batchId, batchLabel: label, date, exclude });
      } catch (err) {
        // The adds above are written and stay written; say so instead of
        // "couldn't import" over a half-done order.
        toast(
          `${added > 0 ? `Added ${added} ${plural(added, 'card')}, but the ` : "Couldn't update the "}updates to your history failed: ${(err as Error).message}`,
        );
        onDone();
        return;
      }
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

  const note = (text: ReactNode) => <span className="purchase-note">{text}</span>;

  return (
    <div className="about-section purchase-review">
      <h2>
        {market} order{order.orderId ? ` ${order.orderId}` : ''}
      </h2>
      <p className="fine-print">
        {[order.seller, `${totalCopies} ${plural(totalCopies, 'card')}`, money(orderTotalCents(order)) + ' before shipping']
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
      {review.reimport && (
        <p className="fine-print">You've imported this order before. Importing it again updates the same copies.</p>
      )}

      <dl className="kv">
        <dt>Will change</dt>
        <dd>
          {updating} {plural(updating, 'card')}
          {gone > 0 ? `, ${gone} no longer in your collection` : ''}
        </dd>
        {review.upToDateCopies > 0 && (
          <>
            <dt>Up to date</dt>
            <dd>{review.upToDateCopies}</dd>
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

      <LineList
        title="Found in your history"
        hint="Each copy's date and price as saved now, and what this order sets them to."
        toolbar={
          <div className="list-toolbar">
            <label className="chip" style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={allPicked} onChange={() => skip.reset(allPicked ? found.map(key) : [])} />{' '}
              {allPicked ? 'Unselect all' : 'Select all'}
            </label>
          </div>
        }
        ids={found}
        lines={lines}
        printings={printings}
        row={(i) => {
          const l = lines[i]!;
          const ms = changing[i]!;
          const grades = new Set(ms.map((m) => m.condition).filter(Boolean));
          const notes = [
            plans[i]!.owned === 0 && 'no longer in your collection',
            grades.size > 0 && !grades.has(l.line.condition) && `you have it as ${[...grades].join('/')}`,
          ].filter(Boolean);
          return {
            count: copies(i),
            check: { checked: !skip.has(key(i)), onChange: () => skip.toggle(key(i)) },
            sub: (
              <>
                {ms.map((m) => {
                  const after = [m.toTs !== m.ts && fmtDate(m.toTs), m.toCents !== m.priceEurCents && money(m.toCents)].filter(Boolean);
                  return note(
                    <span key={m.eventId}>
                      {ms.length > 1 ? `${m.take}× ` : ''}
                      {fmtDate(m.ts)}, {money(m.priceEurCents)} → <strong>{after.join(', ')}</strong>
                    </span>,
                  );
                })}
                {notes.length > 0 && note(notes.join(' · '))}
              </>
            ),
          };
        }}
      />

      <LineList
        title="Not found in your history"
        hint="No copy of this edition, finish and language was ever registered. If you have them, tick to add them as bought on this order."
        ids={missing}
        lines={lines}
        printings={printings}
        row={(i) => ({
          count: plans[i]!.missing,
          check: { checked: add.has(key(i)), onChange: () => add.toggle(key(i)) },
          sub: ownedInstead(lines[i]!) && note(ownedInstead(lines[i]!)),
        })}
      />

      <LineList
        title="Couldn't identify"
        hint="These are skipped."
        ids={unresolved}
        lines={lines}
        printings={printings}
        row={(i) => ({ count: lines[i]!.line.quantity, sub: note(lines[i]!.problem) })}
      />

      {upToDate.length > 0 && (
        <details className="purchase-uptodate">
          <summary>
            Already up to date ({review.upToDateCopies} {plural(review.upToDateCopies, 'card')})
          </summary>
          <LineList
            title={null}
            ids={upToDate}
            lines={lines}
            printings={printings}
            row={(i) => ({
              count: plans[i]!.matches.reduce((n, x) => n + x.take, 0),
              sub: note(fmtDate(plans[i]!.matches[0]!.ts)),
            })}
          />
        </details>
      )}

      <p className="fine-print">
        This corrects the history of copies you already have, so it can't be undone from Edit history. Importing the
        order again sets the same copies again.
      </p>
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
    </div>
  );
}
