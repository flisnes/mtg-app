import { useMemo, useState } from 'react';
import type { ContainerKind, OracleCard, Priced } from '@mtg/shared';
import { useCardMaps } from '../db/useCardMaps.js';
import { CONTAINER_META } from '../deck/containers.js';
import { describeDeckBatch, describeDeckEvent, signedQty, type EventDisplay } from '../history/eventRegistry.js';
import { entryEvents, type HistoryEntry } from '../history/useHistoryEntries.js';
import { useDeckHistory } from '../history/useDeckHistory.js';
import { fmtDate } from '../util/format.js';
import { CardSheet } from './CardSheet.js';
import { EventSheet } from './EventSheet.js';
import { Icon } from './icons.js';
import { Sparkline } from './Sparkline.js';
import { usePagedLimit } from './usePagedLimit.js';

// "How this deck got here": the container's own changes, newest first, in day
// groups that carry the size the deck ended that day on. Nothing new is
// recorded for it — it's the same event log the edit-history page reads, scoped
// to one deckId (history/useDeckHistory), so a scan or a pasted list is one
// entry here too, and tapping a row opens the same event modal.

const PAGE_SIZE = 50;

/** DOM id of the panel, so the container's options menu can scroll to it. */
export const HISTORY_ANCHOR = 'deck-history';

/** Copies an entry moved each way; a re-scan does both at once. */
function movedBy(entry: HistoryEntry): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const e of entryEvents(entry)) {
    if (e.kind === 'deck.add') added += e.qty ?? 1;
    else if (e.kind === 'deck.remove') removed += e.qty ?? 1;
  }
  return { added, removed };
}

export function DeckHistory({
  deckId,
  kind,
  open,
  onToggle,
}: {
  deckId: string;
  kind: ContainerKind;
  open: boolean;
  onToggle: () => void;
}) {
  const { limit, showMore } = usePagedLimit(deckId, PAGE_SIZE);
  const { days, total, hasMore, added, removed, since, curve, loading } = useDeckHistory(deckId, limit);
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null);
  const [card, setCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  // Only single-card rows name a card; batches count them instead. One lookup
  // for every visible row, not one per row.
  const named = useMemo(
    () => days.flatMap((d) => d.entries).filter((e) => e.kind === 'single'),
    [days],
  );
  const { oracleMap } = useCardMaps(
    useMemo(() => named.map((e) => ({ scryfallId: '', oracleId: entryEvents(e)[0]!.oracleId })), [named]),
  );

  // Wait for the first read rather than flash an empty section that then fills.
  if (loading) return null;

  const meta = CONTAINER_META[kind];

  return (
    <div className="about-section" id={HISTORY_ANCHOR}>
      <button className="history-toggle" onClick={onToggle} aria-expanded={open}>
        <span className={`history-caret${open ? ' open' : ''}`} aria-hidden>
          <Icon name="chevronRight" size={16} />
        </span>
        <h2 className="history-toggle-title">
          History <span className="badge">{total}</span>
        </h2>
        {curve.length > 1 && <Sparkline values={curve} width={64} height={20} />}
        {total > 0 && (
          <span className="history-when">
            <span className="history-qty-in">+{added}</span> <span className="history-qty-out">−{removed}</span>
          </span>
        )}
      </button>

      {open && (
        <>
          {since == null ? (
            <p className="fine-print">
              Nothing recorded yet. History starts when you add or remove cards in this {meta.noun}.
            </p>
          ) : (
            <p className="history-summary">
              {total} change{total === 1 ? '' : 's'} to this {meta.noun} since {fmtDate(since)}.
            </p>
          )}
          {days.map((day) => (
            <div key={day.key} className="card-group">
              <h3 className="card-group-title">
                {fmtDate(day.ts)}
                {day.size != null && (
                  <span className="badge">
                    {day.size} card{day.size === 1 ? '' : 's'}
                  </span>
                )}
              </h3>
              <ul className="history-list">
                {day.entries.map((entry) => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    kind={kind}
                    name={oracleMap?.get(entryEvents(entry)[0]!.oracleId)?.name}
                    onClick={() => setOpenEntry(entry)}
                  />
                ))}
              </ul>
            </div>
          ))}
          {hasMore && (
            <button className="show-more" onClick={showMore}>
              Show {PAGE_SIZE} more
            </button>
          )}
        </>
      )}

      {openEntry && (
        <EventSheet
          entry={openEntry}
          onOpenCard={(oracle, scryfallId) => setCard({ oracle, scryfallId })}
          onClose={() => setOpenEntry(null)}
        />
      )}
      {card && (
        <CardSheet
          oracleCard={card.oracle}
          initialScryfallId={card.scryfallId}
          initialTab="history"
          readOnly
          onClose={() => setCard(null)}
        />
      )}
    </div>
  );
}

/** One line: how many copies moved, which card (or how many), and where to. */
function Row({
  entry,
  kind,
  name,
  onClick,
}: {
  entry: HistoryEntry;
  kind: ContainerKind;
  name?: string;
  onClick: () => void;
}) {
  const { added, removed } = movedBy(entry);
  const display: EventDisplay =
    entry.kind === 'single' ? describeDeckEvent(entry.event, kind) : describeDeckBatch(entry.source, added, removed);
  const label =
    entry.kind === 'single'
      ? (name ?? '(unknown card)')
      : `${entry.events.length} card${entry.events.length === 1 ? '' : 's'}`;

  return (
    <li className="history-item">
      <button className="history-row history-row-editable" onClick={onClick}>
        {display.direction === 'neutral' ? (
          // A re-scan both gave and took; showing one number would hide half of it.
          <span className="history-qty history-qty-both">
            <span className="history-qty-in">+{added}</span> <span className="history-qty-out">−{removed}</span>
          </span>
        ) : (
          <span className={`history-qty history-qty-${display.direction}`}>{signedQty(display.direction, added + removed)}</span>
        )}
        <span className="history-label">{label}</span>
        <span className="history-when">{display.verb}</span>
      </button>
    </li>
  );
}
