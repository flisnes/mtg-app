import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind, DeckFormat } from '@mtg/shared';
import { db } from '../db/schema.js';
import { joinDeckCards, type JoinedDeckCard } from '../db/queries.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { CardSheet } from './CardSheet.js';
import type { CardItem } from './CardViews.js';
import { ResultsList, resultCount } from './ResultsList.js';
import { deckCardItem } from './cardRows.js';
import { SortControls, priceValue, sortCards, useCardSort } from './CardSorting.js';

// The global search, scoped into the deck/binder/box you're standing on: it
// searches that container's own cards instead of the whole database. Mirrors
// ScopedResults, but the rows come from db.deckCards for one deckId, and
// tapping one opens the same deck-slot editor the container page itself uses —
// sorting included, off the container page's own preference. Grouping isn't
// offered: these results are one flat list, not the container's boards.
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
  const [sort, setSort] = useCardSort('deck');
  const [editing, setEditing] = useState<JoinedDeckCard | null>(null);

  const rows = useLiveQuery<JoinedDeckCard[]>(
    async () => joinDeckCards(await db.deckCards.where('deckId').equals(deckId).toArray()),
    [deckId],
  );
  const matches = useEntryMatcher(rows, query);

  const items = useMemo(() => {
    const matched = (rows ?? []).filter(matches);
    return sortCards(
      matched,
      (r) => ({
        name: r.oracle?.name,
        cmc: r.oracle?.cmc,
        // A lands-box basic costs the container nothing, so it sorts by nothing.
        price: r.entry.anyBasic ? 0 : priceValue(r.printing, r.oracle),
      }),
      sort,
    ).map((r): CardItem => ({ ...deckCardItem(r, { kind, onClick: () => setEditing(r) }), key: r.entry.id }));
  }, [rows, matches, kind, sort]);

  const loading = rows === undefined;

  return (
    <>
      <ResultsList
        items={items}
        pageKey={`container:${deckId}|${query}|${sort.key}:${sort.dir}`}
        status={loading ? 'Loading…' : resultCount(items.length)}
        controls={<SortControls prefs={sort} onChange={setSort} />}
        showEmpty={!loading && items.length === 0}
      />

      {editing?.oracle && (
        <CardSheet
          mode="deck"
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
