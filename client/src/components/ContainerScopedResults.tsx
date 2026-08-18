import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind, DeckFormat } from '@mtg/shared';
import { db } from '../db/schema.js';
import { joinDeckCards, type JoinedDeckCard } from '../db/queries.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { deckCardItem } from './cardRows.js';

// The global search, scoped into the deck/binder/box you're standing on: it
// searches that container's own cards instead of the whole database. Mirrors
// ScopedResults, but the rows come from db.deckCards for one deckId, and
// tapping one opens the same deck-slot editor the container page itself uses.
export function ContainerScopedResults({
  deckId,
  kind,
  format,
  query,
}: {
  deckId: string;
  kind: ContainerKind;
  format: DeckFormat | undefined;
  query: string;
}) {
  const [view, setView] = useViewMode();
  const [editing, setEditing] = useState<JoinedDeckCard | null>(null);

  const rows = useLiveQuery<JoinedDeckCard[]>(
    async () => joinDeckCards(await db.deckCards.where('deckId').equals(deckId).toArray()),
    [deckId],
  );
  const matches = useEntryMatcher(rows, query);

  const items = useMemo(() => {
    const out: CardItem[] = [];
    for (const r of rows ?? []) {
      if (!matches(r)) continue;
      out.push({ ...deckCardItem(r, { kind, onClick: () => setEditing(r) }), key: r.entry.id });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [rows, matches, kind]);

  const { limit, showMore } = usePagedLimit(`container:${deckId}|${query}`, 60);
  const visible = items.slice(0, limit);
  const loading = rows === undefined;

  return (
    <>
      <div className="meta-row">
        <p className="search-meta">
          {loading ? 'Loading…' : `${items.length} result${items.length === 1 ? '' : 's'}`}
        </p>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {!loading && items.length === 0 ? (
        <p className="search-meta">Nothing here matches.</p>
      ) : (
        <>
          <CardItems view={view} items={visible} />
          <LoadMoreSentinel hasMore={items.length > visible.length} onLoadMore={showMore} rearmKey={visible.length} />
        </>
      )}

      {editing?.oracle && (
        <CardSheet
          oracleCard={editing.oracle}
          deckCard={{
            id: editing.entry.id,
            quantity: editing.entry.quantity,
            scryfallId: editing.entry.scryfallId,
            anyBasic: editing.entry.anyBasic,
            condition: editing.entry.condition,
            finish: editing.entry.finish,
            lang: editing.entry.lang,
            board: editing.entry.board,
            deckId: editing.entry.deckId,
            commanderDeck: format === 'commander',
            containerKind: kind,
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
