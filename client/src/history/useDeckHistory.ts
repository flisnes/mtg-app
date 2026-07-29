import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { entryEvents, groupEntries, type HistoryEntry } from './useHistoryEntries.js';

// One container's slice of the event log, for the history panel on the deck /
// binder / box page. Same rows and the same batch grouping as the global edit
// history (history/useHistoryEntries) — just scoped to one deckId and told as a
// story: entries fall into day groups, and each group says how big the deck was
// when that day ended, so you can see it grow, get cut down, and settle.
//
// Deck size is reconstructed *backwards* from what the deck holds right now,
// subtracting each change as we walk into the past. That makes the recent end
// exact and needs no stored snapshots. It goes wrong only where the log itself
// is incomplete (slots that predate the event log, added in v7), which shows up
// as a size dropping below zero — we then drop sizes entirely rather than draw
// a curve we don't believe.

/** Entries that happened on one calendar day, newest day first. */
export interface DeckHistoryDay {
  /** Grouping key (local calendar day). */
  key: string;
  /** Newest entry's timestamp in this day, for the heading date. */
  ts: number;
  entries: HistoryEntry[];
  /** Cards held when the day ended, or null when the log can't support it. */
  size: number | null;
}

export interface DeckHistory {
  days: DeckHistoryDay[];
  /** Entries in the whole log for this container (before `limit`). */
  total: number;
  hasMore: boolean;
  /** Copies ever added / ever removed, over the whole log. */
  added: number;
  removed: number;
  /** Oldest recorded change, or null when there are none. */
  since: number | null;
  /** Deck size after every recorded change, oldest first — the sparkline. */
  curve: number[];
  loading: boolean;
}

/** Net copies an entry moved: adds positive, removals negative. */
function deltaOf(entry: HistoryEntry): number {
  let delta = 0;
  for (const e of entryEvents(entry)) {
    if (e.kind === 'deck.add') delta += e.qty ?? 1;
    else if (e.kind === 'deck.remove') delta -= e.qty ?? 1;
  }
  return delta;
}

/** Local calendar day of a timestamp. Not a display string — just a stable key. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function useDeckHistory(deckId: string, limit: number): DeckHistory {
  const events = useLiveQuery(() => db.events.where('deckId').equals(deckId).toArray(), [deckId]);

  // What the container holds now — the anchor the walk backwards starts from.
  const held = useLiveQuery(
    async () => (await db.deckCards.where('deckId').equals(deckId).toArray()).reduce((n, c) => n + c.quantity, 0),
    [deckId],
  );

  // Newest first. Tie-break on id so a same-millisecond pair (a board move
  // emits its remove and add together) keeps a stable order between renders.
  const all = useMemo(
    () =>
      events
        ? groupEntries([...events].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)))
        : null,
    [events],
  );

  const sizes = useMemo(() => {
    if (!all || held == null) return null;
    const after = new Map<string, number>();
    let running = held;
    for (const entry of all) {
      after.set(entry.id, running);
      running -= deltaOf(entry);
      if (running < 0) return null; // log is missing changes; sizes would lie
    }
    return after;
  }, [all, held]);

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const entry of all ?? []) {
      for (const e of entryEvents(entry)) {
        if (e.kind === 'deck.add') added += e.qty ?? 1;
        else if (e.kind === 'deck.remove') removed += e.qty ?? 1;
      }
    }
    return { added, removed };
  }, [all]);

  const days = useMemo(() => {
    if (!all) return [];
    const out: DeckHistoryDay[] = [];
    for (const entry of all.slice(0, limit)) {
      const key = dayKey(entry.ts);
      const last = out[out.length - 1];
      if (last && last.key === key) last.entries.push(entry);
      // `all` is newest-first, so the day's first entry is its newest — and the
      // size after it is the size the day ended on.
      else out.push({ key, ts: entry.ts, entries: [entry], size: sizes?.get(entry.id) ?? null });
    }
    return out;
  }, [all, limit, sizes]);

  // Oldest → newest, so the line reads left-to-right like time does.
  const curve = useMemo(() => (all && sizes ? all.map((e) => sizes.get(e.id) ?? 0).reverse() : []), [all, sizes]);

  return {
    days,
    total: all?.length ?? 0,
    hasMore: (all?.length ?? 0) > limit,
    added: totals.added,
    removed: totals.removed,
    since: all?.length ? all[all.length - 1]!.ts : null,
    curve,
    loading: events === undefined || held === undefined,
  };
}
