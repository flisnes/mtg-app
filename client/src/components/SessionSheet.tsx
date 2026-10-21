import { useMemo, useState, type ReactNode } from 'react';
import { traitsLine, type OracleCard, type Priced } from '@mtg/shared';
import { getOracleCard, getPrinting } from '../db/queries.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { BOARD_NOUN, scanBoards } from '../deck/boards.js';
import { mergeSession, sessionKey, targetLabel, type ScanTarget, type SessionEntry } from '../scan/session.js';
import { plural } from '../util/format.js';
import { CardSheet, type SessionCardValues } from './CardSheet.js';
import { CardStacks, ViewToggle, useScanViewMode, type CardItem } from './CardViews.js';
import { addToTotal, formatPrice, formatTotal, pricedForFinish, type PriceTotal } from './cardSort.js';
import { QtyStepper } from './QtyStepper.js';
import { ScanListRow } from './ScanListRow.js';
import { SetSymbol } from './SetSymbol.js';
import { Sheet } from './Sheet.js';
import { useAsyncAction } from './useAsyncAction.js';

// The scan session as a list to review and edit before it is written: the
// scanner's list button opens it, and the drop review is this list on its own.

export function SessionSheet({
  entries,
  target,
  total,
  busy,
  onChange,
  onComplete,
  onClose,
  title = 'Scanned cards',
  emptyText = 'Nothing scanned yet. Tap the top half of a match to add it.',
  closeLabel = 'Keep scanning',
  notice,
}: {
  entries: SessionEntry[];
  target: ScanTarget;
  total: number;
  busy: boolean;
  onChange: (next: SessionEntry[]) => void;
  onComplete: () => void;
  onClose: () => void;
  /** Wording for the other user of this list, the drop review. */
  title?: string;
  emptyText?: string;
  closeLabel?: string;
  /** Status shown under the heading (what a drop is still identifying). */
  notice?: ReactNode;
}) {
  const action = useAsyncAction();
  // Row tap opens the card sheet on that line for full editing (edition,
  // condition, finish, language, quantity); Apply rewrites the line in place.
  const [editing, setEditing] = useState<{ index: number; oracle: Priced<OracleCard> } | null>(null);
  const [view, setView] = useScanViewMode();
  const showBoards = target.kind === 'deck' && scanBoards(target.containerKind, target.format).length > 1;
  // Both views show set names and prices, which a session entry doesn't
  // carry, and the footer sums them — so the lookup runs either way.
  const { printMap, oracleMap } = useCardMaps(entries.map((e) => ({ scryfallId: e.scryfallId, oracleId: e.oracleId })));
  const priceOf = (e: SessionEntry) => [pricedForFinish(printMap?.get(e.scryfallId), e.finish), oracleMap?.get(e.oracleId)];
  // What the pile in your hand is worth, by the same reckoning as every other
  // total in the app (per-card price × quantity, both currencies converted).
  const totalValue = useMemo(() => {
    const total: PriceTotal = { eur: 0, usd: 0 };
    for (const e of entries) addToTotal(total, e.qty, ...priceOf(e));
    return formatTotal(total);
  }, [entries, printMap, oracleMap]);

  const adjust = (i: number, delta: number) => {
    const e = entries[i]!;
    onChange(e.qty + delta <= 0 ? entries.filter((_, j) => j !== i) : entries.map((x, j) => (j === i ? { ...x, qty: x.qty + delta } : x)));
  };

  const cycleBoard = (i: number) => {
    if (target.kind !== 'deck') return;
    const boards = scanBoards(target.containerKind, target.format);
    onChange(
      mergeSession(
        entries.map((e, j) => (j === i ? { ...e, board: boards[(boards.indexOf(e.board) + 1) % boards.length]! } : e)),
      ),
    );
  };

  const openEntry = async (i: number) => {
    const id = entries[i]!.oracleId;
    // The list already looked it up for its prices; the DB read is the fallback
    // for a line that landed a moment ago.
    const oracle = oracleMap?.get(id) ?? (await getOracleCard(id));
    if (oracle) setEditing({ index: i, oracle });
  };

  /** Card-sheet Apply/Remove for one line (quantity 0 removes it). */
  const applyEdit = async (i: number, v: SessionCardValues) => {
    if (v.quantity <= 0) {
      onChange(entries.filter((_, j) => j !== i));
      return;
    }
    const e = entries[i]!;
    let next: SessionEntry = {
      ...e,
      qty: v.quantity,
      lang: v.lang ?? e.lang,
      finish: v.finish ?? e.finish,
      condition: v.condition ?? e.condition,
    };
    if (v.scryfallId !== e.scryfallId) {
      const p = await getPrinting(v.scryfallId);
      if (p) next = { ...next, scryfallId: p.scryfallId, set: p.set, collectorNumber: p.collectorNumber, image: p.imageNormal ?? undefined };
    }
    onChange(mergeSession(entries.map((x, j) => (j === i ? next : x))));
  };

  // The per-line card sheet stacks above this one and dismisses first.
  return (
    <Sheet
      onClose={onClose}
      dismiss={busy ? null : onClose}
      className="scan-list-sheet"
      title={title}
      headerRight={
        <>
          <span className="scan-target">→ {targetLabel(target)}</span>
          <ViewToggle mode={view} onChange={setView} options={['list', 'stack']} />
        </>
      }
      closeButton={{ label: 'Close list' }}
    >

        {notice}

        {entries.length === 0 ? (
          <p className="scan-list-empty">{emptyText}</p>
        ) : view === 'stack' ? (
          <CardStacks
            className="scan-stacks"
            items={entries.map((e, i): CardItem => {
              const printing = printMap?.get(e.scryfallId);
              const extras = traitsLine(e, { quiet: { condition: 'NM' } });
              return {
                key: sessionKey(e),
                name: e.name,
                image: printing?.imageNormal ?? e.image ?? null,
                foil: e.finish !== 'nonfoil',
                count: e.qty,
                badge: showBoards ? BOARD_NOUN[e.board] : undefined,
                sub: (
                  <>
                    <SetSymbol set={e.set} title={printing?.setName ?? e.set.toUpperCase()} />
                    <span className="stack-setname">{printing?.setName ?? e.set.toUpperCase()}</span> #
                    {e.collectorNumber}
                    {extras ? ` · ${extras}` : ''}
                  </>
                ),
                price: formatPrice(...priceOf(e)),
                onClick: () => void action.run('open that card', () => openEntry(i)),
                actions: (
                  <>
                    <QtyStepper compact value={e.qty} min={0} onChange={(v) => adjust(i, v - e.qty)} label={e.name} />
                    {showBoards && (
                      <button className="scan-chip" onClick={() => cycleBoard(i)}>
                        {BOARD_NOUN[e.board]}
                      </button>
                    )}
                  </>
                ),
              };
            })}
          />
        ) : (
          <ul className="scan-list">
            {entries.map((e, i) => (
              <ScanListRow
                key={sessionKey(e)}
                image={printMap?.get(e.scryfallId)?.imageSmall ?? e.image}
                name={e.name}
                sub={
                  <>
                    {e.set.toUpperCase()} #{e.collectorNumber} · {traitsLine(e, { quiet: { condition: 'NM', lang: null } })}
                  </>
                }
                price={formatPrice(...priceOf(e))}
                onClick={() => action.run('open that card', () => openEntry(i))}
                ariaLabel={`Edit ${e.name}`}
              >
                {showBoards && (
                  <button className="scan-chip" onClick={() => cycleBoard(i)}>
                    {BOARD_NOUN[e.board]}
                  </button>
                )}
                <QtyStepper compact value={e.qty} min={0} onChange={(v) => adjust(i, v - e.qty)} label={e.name} />
              </ScanListRow>
            ))}
          </ul>
        )}

        {entries.length > 0 && (
          <div className="scan-list-total">
            <span>Total value</span>
            <strong>{totalValue}</strong>
          </div>
        )}

        <div className="scan-confirm-actions">
          <button className="primary" disabled={total === 0 || busy} onClick={onComplete}>
            {busy
              ? 'Adding…'
              : target.kind === 'deck' && target.rescan
                ? `Review changes to ${targetLabel(target)}`
                : `Add ${total} ${plural(total, 'card')} to ${targetLabel(target)}`}
          </button>
          <button onClick={onClose} disabled={busy}>{closeLabel}</button>
        </div>

        {editing && entries[editing.index] && (
          <CardSheet
            mode="session"
            oracleCard={editing.oracle}
            sessionCard={{
              scryfallId: entries[editing.index]!.scryfallId,
              quantity: entries[editing.index]!.qty,
              lang: entries[editing.index]!.lang,
              finish: entries[editing.index]!.finish,
              condition: entries[editing.index]!.condition,
            }}
            onApply={(v) => void applyEdit(editing.index, v)}
            onClose={() => setEditing(null)}
          />
        )}
    </Sheet>
  );
}
