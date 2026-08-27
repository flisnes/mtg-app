import { useMemo, useState } from 'react';
import type { OracleCard, Priced } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { undoEntry } from '../db/dataAccess.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { CardList, StackedThumb, type CardItem } from '../components/CardViews.js';
import { usePagedLimit } from '../components/usePagedLimit.js';
import { CardSheet } from '../components/CardSheet.js';
import { EventSheet } from '../components/EventSheet.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { batchCount, describeBatch, describeEvent, qtyBadge, FILTER_CATEGORIES } from '../history/eventRegistry.js';
import { entryEvents, undoRefOf, useHistoryEntries, type HistoryEntry } from '../history/useHistoryEntries.js';
import { fmtDate } from '../util/format.js';

const PAGE_SIZE = 100;

// Date presets → a [from, to) window computed from "now" at render time.
type DatePreset = 'all' | '7d' | '30d' | '90d' | 'year' | 'custom';
const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
];

function presetWindow(preset: DatePreset, customFrom: string, customTo: string): { from?: number; to?: number } {
  const now = Date.now();
  const day = 86_400_000;
  switch (preset) {
    case '7d':
      return { from: now - 7 * day };
    case '30d':
      return { from: now - 30 * day };
    case '90d':
      return { from: now - 90 * day };
    case 'year':
      return { from: new Date(new Date().getFullYear(), 0, 1).getTime() };
    case 'custom':
      return {
        from: customFrom ? new Date(customFrom).getTime() : undefined,
        // Inclusive end-of-day: bump to the next midnight (exclusive upper bound).
        to: customTo ? new Date(customTo).getTime() + day : undefined,
      };
    default:
      return {};
  }
}


export function EditHistory() {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [preset, setPreset] = useState<DatePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const { from, to } = presetWindow(preset, customFrom, customTo);
  const filters = { name, category, from, to };
  const noFilters = !name.trim() && !category && from == null && to == null;

  const { limit, showMore } = usePagedLimit(JSON.stringify({ name: name.trim(), category, from, to }), PAGE_SIZE);
  const { entries, hasMore, loading, undoable } = useHistoryEntries(filters, limit);

  // Enrich the visible entries with images/names for the rows.
  const allEvents = useMemo(() => entries.flatMap(entryEvents), [entries]);
  const { printMap, oracleMap } = useCardMaps(allEvents.map((e) => ({ scryfallId: e.scryfallId ?? '', oracleId: e.oracleId })));

  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null);
  const [card, setCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);
  const toast = useToast();

  const imgOf = (oracleId: string, scryfallId?: string | null): string | null =>
    (scryfallId ? printMap?.get(scryfallId)?.imageSmall : null) ?? oracleMap?.get(oracleId)?.imageSmall ?? null;

  function itemFor(entry: HistoryEntry): CardItem {
    if (entry.kind === 'batch') {
      const display = describeBatch(entry.source, entry.label, entry.events);
      const count = batchCount(entry.events);
      const imgs: string[] = [];
      for (const e of entry.events) {
        const img = imgOf(e.oracleId, e.scryfallId);
        if (img && !imgs.includes(img)) imgs.push(img);
        if (imgs.length >= 3) break;
      }
      return {
        key: entry.id,
        name: display.verb,
        image: null,
        thumb: <StackedThumb images={imgs} />,
        badge: <Icon name={display.icon} size={14} />,
        badgeTitle: display.verb,
        sub: `${count} card${count === 1 ? '' : 's'} · ${fmtDate(entry.ts)}`,
        onClick: () => setOpenEntry(entry),
      };
    }
    const e = entry.event;
    const display = describeEvent(e);
    const oracle = oracleMap?.get(e.oracleId);
    return {
      key: entry.id,
      name: oracle?.name ?? '(unknown card)',
      image: imgOf(e.oracleId, e.scryfallId),
      foil: e.finish != null && e.finish !== 'nonfoil',
      badge: qtyBadge(e) ?? <Icon name={display.icon} size={14} />,
      sub: `${display.verb} · ${fmtDate(e.ts)}`,
      onClick: () => setOpenEntry(entry),
    };
  }

  async function doUndo(entry: HistoryEntry) {
    const res = await undoEntry(undoRefOf(entry));
    if (res.undone) toast('Change undone');
    else toast(res.reason === 'conflict' ? "Can't undo: a newer change touched these cards" : "Couldn't undo that change");
    setOpenEntry(null);
  }

  // Undo is no longer the privilege of whatever sits at the top of the list:
  // any entry nothing newer has written over can be reversed, filters and all.
  const canUndo = (entry: HistoryEntry): boolean => undoable.has(entry.id);

  return (
    <Page title="Edit history" subtitle="Every change you've made to your collection, newest first.">
      <div className="list-toolbar">
        <input
          className="search-input grow"
          type="search"
          placeholder="Search by card or product name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Search history by name"
        />
      </div>
      <div className="filter-row">
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Event type">
          <option value="">All changes</option>
          {FILTER_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select value={preset} onChange={(e) => setPreset(e.target.value as DatePreset)} aria-label="Date range">
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {preset === 'custom' && (
        <div className="filter-row">
          <label className="field">
            <span>From</span>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </label>
        </div>
      )}

      {loading ? (
        <p className="search-meta">Loading…</p>
      ) : entries.length === 0 ? (
        <EmptyState>{noFilters ? 'No changes recorded yet.' : 'No changes match your filters.'}</EmptyState>
      ) : (
        <>
          <CardList items={entries.map(itemFor)} />
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
          canUndo={canUndo(openEntry)}
          onUndo={() => void doUndo(openEntry)}
        />
      )}
      {card && (
        <CardSheet
          mode="info"
          oracleCard={card.oracle}
          initialScryfallId={card.scryfallId}
          initialTab="history"
          onClose={() => setCard(null)}
        />
      )}
    </Page>
  );
}
