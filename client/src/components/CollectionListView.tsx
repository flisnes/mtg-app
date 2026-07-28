import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { joinCollectionEntries, type JoinedEntry } from '../db/queries.js';
import { addDeckCardsBulk, removeCollectionEntriesBulk, setQuantityForTradeBulk } from '../db/dataAccess.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode } from './CardViews.js';
import { collectionCardItem } from './cardRows.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { BulkActionBar, type BulkAction } from './BulkActionBar.js';
import { DeckPickerSheet } from './DeckPickerSheet.js';
import { useMultiSelect } from './useMultiSelect.js';
import { PileView, CardBackSheet, type PileEntry } from './PileView.js';
import { SortControls, priceValue, pricedForFinish, sortCards, useCardSort } from './CardSorting.js';
import { historyChange } from '../price/history.js';
import { loadLastEdited, lastEditedFor } from '../history/lastEdited.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useGoblinMode } from './useGoblinMode.js';
import { useOpenSearch } from './GlobalSearch.js';
import { useToast } from './Toast.js';
import { Icon } from './icons.js';

/** Join collection entries with their card + printing display data. */
function useJoinedCollection(): JoinedEntry[] | undefined {
  return useLiveQuery(async () => joinCollectionEntries(await db.collection.toArray()), []);
}

export function CollectionListView({ onlyTrade = false }: { onlyTrade?: boolean }) {
  const rows = useJoinedCollection();
  const [editing, setEditing] = useState<JoinedEntry | null>(null);
  // Pile view is goblin-mode only and never offered on the tradelist screen.
  const goblin = useGoblinMode();
  const allowPile = goblin && !onlyTrade;
  const [view, setView] = useViewMode(allowPile);
  const pileMode = view === 'pile' && allowPile;
  const [info, setInfo] = useState<JoinedEntry | null>(null);
  const [cardBack, setCardBack] = useState(false);
  const [sort, setSort] = useCardSort(onlyTrade ? 'tradelist' : 'collection');
  const openSearch = useOpenSearch();
  const moverFlags = useMoverFlags();
  const toast = useToast();
  const sel = useMultiSelect();
  const [pickingDeck, setPickingDeck] = useState(false);

  // scryfallId → recorded price change; only loaded while a change sort is
  // active (the histories table is the biggest user-data table).
  const needChanges = sort.key === 'change' || sort.key === 'changePct';
  const changes = useLiveQuery(async () => {
    if (!needChanges) return undefined;
    const m = new Map<string, { delta: number; pct: number | null }>();
    for (const h of await db.priceHistories.toArray()) {
      const c = historyChange(h);
      if (c) m.set(h.scryfallId, { delta: c.delta, pct: c.pct });
    }
    return m;
  }, [needChanges]);

  // Per-printing "last edited", matching the top row of that printing's History
  // tab. This is what the sort keys off, NOT collection.updatedAt: updatedAt can
  // move for reasons that leave no history entry, so the event log is the source
  // of truth the user actually sees. Loaded only while the sort is active
  // (events is an append-only table that grows without bound).
  const needEdited = sort.key === 'updated';
  const lastEdited = useLiveQuery(async () => (needEdited ? loadLastEdited() : undefined), [needEdited]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const matching = onlyTrade ? rows.filter((r) => r.entry.quantityForTrade > 0) : rows;
    return sortCards(
      matching,
      (r) => ({
        name: r.oracle?.name,
        cmc: r.oracle?.cmc,
        price: priceValue(pricedForFinish(r.printing, r.entry.finish), r.oracle),
        change: changes?.get(r.entry.scryfallId)?.delta ?? null,
        changePct: changes?.get(r.entry.scryfallId)?.pct ?? null,
        added: r.entry.createdAt,
        updated: (lastEdited && lastEditedFor(lastEdited, r.entry.oracleId, r.entry.scryfallId)) ?? r.entry.updatedAt,
      }),
      sort,
    );
  }, [rows, onlyTrade, sort, changes, lastEdited]);

  const totalQty = filtered.reduce((s, r) => s + r.entry.quantity, 0);

  // Page the rendered list — the collection is the one list guaranteed to reach
  // thousands of entries, so rendering all of them (each a tile with images and
  // badges) janks on phones. Reset to page one when the sort changes.
  const filterSig = JSON.stringify({ onlyTrade, sort });
  const { limit, showMore } = usePagedLimit(filterSig, 60);
  const visible = filtered.slice(0, limit);

  // Selected keys (= entry ids) resolved back to their rows for bulk actions.
  const selectedRows = filtered.filter((r) => sel.selected.has(r.entry.id));
  const allKeys = filtered.map((r) => r.entry.id);
  const plural = (n: number) => (n === 1 ? '' : 's');

  async function bulkAddTradelist() {
    const n = selectedRows.length;
    await setQuantityForTradeBulk(selectedRows.map((r) => ({ id: r.entry.id, quantityForTrade: r.entry.quantity })));
    toast(`Added ${n} card${plural(n)} to tradelist`);
    sel.exit();
  }
  async function bulkRemoveTradelist() {
    const n = selectedRows.filter((r) => r.entry.quantityForTrade > 0).length;
    await setQuantityForTradeBulk(selectedRows.map((r) => ({ id: r.entry.id, quantityForTrade: 0 })));
    toast(n === 0 ? 'None were on the tradelist' : `Removed ${n} card${plural(n)} from tradelist`);
    sel.exit();
  }
  async function bulkDelete() {
    const n = selectedRows.length;
    if (!window.confirm(`Delete ${n} ${n === 1 ? 'entry' : 'entries'} from your collection?`)) return;
    await removeCollectionEntriesBulk(selectedRows.map((r) => r.entry.id));
    toast(`Deleted ${n} ${n === 1 ? 'entry' : 'entries'}`);
    sel.exit();
  }
  async function bulkAddDeck(deckId: string) {
    setPickingDeck(false);
    const n = selectedRows.length;
    await addDeckCardsBulk(
      deckId,
      selectedRows.map((r) => ({ oracleId: r.entry.oracleId, quantity: 1, board: 'main' as const, scryfallId: r.entry.scryfallId })),
    );
    toast(`Added ${n} card${plural(n)} to deck`);
    sel.exit();
  }

  const bulkActions: BulkAction[] = onlyTrade
    ? [
        { label: 'Remove from tradelist', icon: 'tradelist', onClick: bulkRemoveTradelist },
        { label: 'Delete', icon: 'trash', danger: true, onClick: bulkDelete },
      ]
    : [
        { label: 'Add to tradelist', icon: 'tradelist', onClick: bulkAddTradelist },
        { label: 'Remove from tradelist', icon: 'close', onClick: bulkRemoveTradelist },
        { label: 'Add to deck', icon: 'decks', onClick: () => setPickingDeck(true) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: bulkDelete },
      ];

  if (rows === undefined) return <p className="search-meta">Loading…</p>;

  const emptyState = (
    <div className="empty-state">
      <p>Nothing here yet.</p>
      <p className="empty-phase">
        <button className="linklike" onClick={openSearch}>
          Search for cards
        </button>{' '}
        to add some.
      </p>
    </div>
  );

  return (
    <>
      <div className="meta-row">
        <p className="search-meta">
          {pileMode ? rows.length : filtered.length} entr{(pileMode ? rows.length : filtered.length) === 1 ? 'y' : 'ies'} ·{' '}
          {pileMode ? rows.reduce((s, r) => s + r.entry.quantity, 0) : totalQty} card
          {(pileMode ? rows.reduce((s, r) => s + r.entry.quantity, 0) : totalQty) === 1 ? '' : 's'}
        </p>
        <div className="meta-actions">
          {!pileMode && !sel.active && filtered.length > 0 && (
            <button className="select-toggle" onClick={sel.enter} title="Select multiple cards">
              <Icon name="check" size={15} /> Select
            </button>
          )}
          {!pileMode && <SortControls prefs={sort} onChange={setSort} withChange withDates />}
          <ViewToggle mode={view} onChange={setView} showPile={allowPile} />
        </div>
      </div>

      {pileMode ? (
        rows.length === 0 ? (
          emptyState
        ) : (
          <PileView
            items={rows.map(
              (r): PileEntry => ({
                key: r.entry.id,
                name: r.oracle?.name ?? '(unknown card)',
                image: r.printing?.imageNormal ?? r.oracle?.imageNormal ?? r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
                imageBack: r.printing?.imageBackNormal ?? r.oracle?.imageBackNormal ?? r.printing?.imageBackSmall ?? r.oracle?.imageBackSmall ?? null,
                foil: r.entry.finish !== 'nonfoil',
                oversized: /oversized/i.test(r.printing?.setName ?? ''),
                count: r.entry.quantity,
                onLongPress: (faceDown) => {
                  // Face-down single-faced card: only the generic back is
                  // showing, so we tell them about the back, not the front.
                  const hasBack = !!(r.printing?.imageBackNormal ?? r.oracle?.imageBackNormal ?? r.printing?.imageBackSmall ?? r.oracle?.imageBackSmall);
                  if (faceDown && !hasBack) setCardBack(true);
                  else setInfo(r);
                },
              }),
            )}
          />
        )
      ) : filtered.length === 0 ? (
        emptyState
      ) : (
        <CardItems
          view={view}
          selectable={sel.active}
          selectedKeys={sel.selected}
          onToggleSelect={sel.toggle}
          items={visible.map((r) => collectionCardItem(r, { moverFlags, onClick: () => setEditing(r) }))}
        />
      )}
      {!pileMode && (
        <LoadMoreSentinel
          hasMore={filtered.length > visible.length}
          onLoadMore={showMore}
          rearmKey={visible.length}
        />
      )}

      {sel.active && (
        <BulkActionBar
          count={selectedRows.length}
          allSelected={allKeys.length > 0 && allKeys.every((k) => sel.selected.has(k))}
          onToggleAll={() => sel.toggleAll(allKeys)}
          onCancel={sel.exit}
          actions={bulkActions}
        />
      )}
      {pickingDeck && <DeckPickerSheet onPick={bulkAddDeck} onClose={() => setPickingDeck(false)} />}

      {editing?.oracle && <CardSheet oracleCard={editing.oracle} entry={editing.entry} onClose={() => setEditing(null)} />}
      {info?.oracle && <CardSheet oracleCard={info.oracle} initialScryfallId={info.entry.scryfallId} readOnly onClose={() => setInfo(null)} />}
      {cardBack && <CardBackSheet onClose={() => setCardBack(false)} />}
    </>
  );
}
