import { createPortal } from 'react-dom';
import type { OracleCard, Priced } from '@mtg/shared';
import { CardList, type CardItem } from './CardViews.js';
import { Icon } from './icons.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { useEscapeToClose } from './useEscapeToClose.js';
import { describeBatch, describeEvent, qtyBadge } from '../history/eventRegistry.js';
import { entryEvents, type HistoryEntry } from '../history/useHistoryEntries.js';

// Info modal for one edit-history entry: the action, when it happened, and the
// card(s) involved. Clicking a card opens its card sheet on the History tab.
// The Undo button appears only when the caller says this is the newest entry.

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtCents(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function EventSheet({
  entry,
  onOpenCard,
  onClose,
  canUndo = false,
  onUndo,
}: {
  entry: HistoryEntry;
  onOpenCard: (oracle: Priced<OracleCard>, scryfallId?: string) => void;
  onClose: () => void;
  canUndo?: boolean;
  onUndo?: () => void;
}) {
  const events = entryEvents(entry);
  const { printMap, oracleMap } = useCardMaps(events.map((e) => ({ scryfallId: e.scryfallId ?? '', oracleId: e.oracleId })));
  useEscapeToClose(onClose);

  const display = entry.kind === 'batch' ? describeBatch(entry.source, entry.label) : describeEvent(entry.event);
  const totalCards = events.reduce((s, e) => s + (e.qty ?? 0), 0);
  const single = entry.kind === 'single' ? entry.event : null;

  const items = events.map((e, i): CardItem => {
    const oracle = oracleMap?.get(e.oracleId);
    const printing = e.scryfallId ? printMap?.get(e.scryfallId) : undefined;
    return {
      key: `${i}-${e.id}`,
      name: oracle?.name ?? '(unknown card)',
      image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
      foil: e.finish != null && e.finish !== 'nonfoil',
      badge: qtyBadge(e) ?? undefined,
      sub: (
        <>
          {describeEvent(e).verb}
          {e.condition ? ` · ${e.condition}` : ''}
          {e.finish && e.finish !== 'nonfoil' ? ` · ${e.finish}` : ''}
        </>
      ),
      onClick: oracle ? () => onOpenCard(oracle, e.scryfallId ?? undefined) : undefined,
    };
  });

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Change details" onClick={(e) => e.stopPropagation()}>
        <div className="event-sheet-head">
          <span className="event-sheet-icon" aria-hidden>
            <Icon name={display.icon} />
          </span>
          <div className="event-sheet-titles">
            <div className="sheet-name">
              {display.verb}
              {entry.kind === 'batch' && ` · ${totalCards} card${totalCards === 1 ? '' : 's'}`}
            </div>
            <div className="result-sub">{fmtDateTime(entry.ts)}</div>
            {single?.priceEurCents != null && (
              <div className="result-sub">{fmtCents(single.priceEurCents)}/ea</div>
            )}
          </div>
        </div>

        <CardList items={items} />

        <div className="sheet-actions">
          {canUndo && onUndo && (
            <button className="danger-outline" onClick={onUndo}>
              Undo
            </button>
          )}
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
