import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { CONTAINER_META } from '../deck/containers.js';
import { joinCollectionEntries, type JoinedEntry } from '../db/queries.js';
import { removeCollectionEntriesBulk, setQuantityForTradeBulk } from '../db/dataAccess.js';
import { useFiling } from '../deck/useFiling.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode } from './CardViews.js';
import { collectionCardItem } from './cardRows.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { BulkActionBar, type BulkAction } from './BulkActionBar.js';
import { ContainerPickerSheet } from './ContainerPickerSheet.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { useMultiSelect } from './useMultiSelect.js';
import { PileView, CardBackSheet, type PileEntry } from './PileView.js';
import { SortControls, priceValue, pricedForFinish, sortCards, useCardSort } from './CardSorting.js';
import { historyChange } from '../price/history.js';
import { loadLastEdited, lastEditedFor } from '../history/lastEdited.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useGoblinMode } from './useGoblinMode.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { useListFilter, useOpenSearch } from './GlobalSearch.js';
import { useToast } from './Toast.js';
import { Icon } from './icons.js';

/** Join collection entries with their card + printing display data. */
function useJoinedCollection(): JoinedEntry[] | undefined {
  return useLiveQuery(async () => joinCollectionEntries(await db.collection.toArray()), []);
}

/** Narrow the list to copies that are (or aren't) in a deck, binder or box —
 *  or to the ones promised to more places than you own. */
type PlaceFilter = 'all' | 'unfiled' | 'filed' | 'conflict';

const PLACE_OPTIONS: [PlaceFilter, string][] = [
  ['all', 'Filed: Any'],
  ['unfiled', 'Filed: Nowhere'],
  ['filed', 'Filed: Somewhere'],
  ['conflict', 'Filed: In too many places'],
];

export function CollectionListView({ onlyTrade = false }: { onlyTrade?: boolean }) {
  const rows = useJoinedCollection();
  const navigate = useNavigate();
  const { file, sheet: filingSheet } = useFiling();
  const [editing, setEditing] = useState<JoinedEntry | null>(null);
  // The header search bar, when it's scoped to this list, narrows these rows
  // instead of covering them — so sort, Select and the bulk actions below all
  // operate on the search result. Blank whenever search isn't pointed here.
  const query = useListFilter(onlyTrade ? 'tradelist' : 'collection');
  const matchesQuery = useEntryMatcher(rows, query);
  // Goblin mode *replaces* the collection with the pile — it's the only view
  // while enabled, and there's no toggle out of it (turn goblin mode off in
  // settings to get list/grid + sorting back). Never on the tradelist screen.
  const goblin = useGoblinMode();
  const pileMode = goblin && !onlyTrade;
  const [view, setView] = useViewMode();
  const [cardBack, setCardBack] = useState(false);
  const [sort, setSort] = useCardSort(onlyTrade ? 'tradelist' : 'collection');
  const openSearch = useOpenSearch();
  const moverFlags = useMoverFlags();
  const toast = useToast();
  const sel = useMultiSelect();
  const placements = usePlacementIndex();
  const [pickingContainer, setPickingContainer] = useState(false);
  // Deliberately not persisted: a filter that hides cards shouldn't outlive the
  // visit that set it, or you come back tomorrow to a collection with holes.
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>('all');

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

  // "Filed" means exactly what the row's badge means: this copy — printing,
  // finish, condition, language — sits in a deck, binder or box. So "Nowhere"
  // is the set of cards with no placement badge, and selecting all of them is
  // the two-tap way to grab everything still loose in the shoebox. Until the
  // index loads there's nothing to judge by, so everything passes rather than
  // the list flashing empty.
  const matchesPlacement = useCallback(
    (r: JoinedEntry) => {
      if (placeFilter === 'all' || !placements) return true;
      const info = placements.lookup(r.entry.oracleId, r.entry.scryfallId, {
        condition: r.entry.condition,
        finish: r.entry.finish,
        lang: r.entry.lang,
      });
      if (placeFilter === 'conflict') return info.over;
      return placeFilter === 'filed' ? info.places.length > 0 : info.places.length === 0;
    },
    [placeFilter, placements],
  );

  // Rows this view is showing at all, before sorting: the tradelist filter plus
  // whatever the search bar is narrowing to. The pile needs the unsorted set.
  const matching = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => (!onlyTrade || r.entry.quantityForTrade > 0) && matchesPlacement(r) && matchesQuery(r),
      ),
    [rows, onlyTrade, matchesPlacement, matchesQuery],
  );

  const filtered = useMemo(() => {
    if (!rows) return [];
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
  }, [rows, matching, sort, changes, lastEdited]);

  const totalQty = filtered.reduce((s, r) => s + r.entry.quantity, 0);

  // The heap's cards. Memoized because PileView recomputes every copy's spot
  // whenever this array changes identity, and a fresh array on every render (a
  // card sheet opening, a price landing) would redo that for the whole
  // collection. Small art on purpose: a pile card is 96px wide, and `normal`
  // decodes to ~1.3 MB against ~120 KB, which is what buried Chrome.
  const pileItems = useMemo(
    () =>
      matching.map((r): PileEntry => {
        const back =
          r.printing?.imageBackSmall ??
          r.oracle?.imageBackSmall ??
          r.printing?.imageBackNormal ??
          r.oracle?.imageBackNormal ??
          null;
        return {
          key: r.entry.id,
          name: r.oracle?.name ?? '(unknown card)',
          image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? r.printing?.imageNormal ?? r.oracle?.imageNormal ?? null,
          imageBack: back,
          foil: r.entry.finish !== 'nonfoil',
          oversized: /oversized/i.test(r.printing?.setName ?? ''),
          count: r.entry.quantity,
          onLongPress: (faceDown) => {
            // Face-down single-faced card: only the generic back is showing, so
            // we tell them about the back, not the front.
            // Otherwise the same sheet a list or grid row opens: it still reads
            // as a look at the card (the entry opens read-only), but the way in
            // to fixing the copy is there when the pile is what you're staring at.
            if (faceDown && !back) setCardBack(true);
            else setEditing(r);
          },
        };
      }),
    [matching],
  );

  // Page the rendered list — the collection is the one list guaranteed to reach
  // thousands of entries, so rendering all of them (each a tile with images and
  // badges) janks on phones. Reset to page one when the sort or search changes.
  const filterSig = JSON.stringify({ onlyTrade, sort, query, placeFilter });
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
  /**
   * File the selection into a deck, binder or box. These are cards you own and
   * are holding, so the slots copy the entry whole: every copy of it, in that
   * printing, finish, condition and language. Two editions of the same card stay
   * two slots instead of folding into one generic line — and any copy already
   * filed somewhere else gets the move-or-both question (see deck/filing.ts).
   */
  async function bulkAddContainer(containerId: string, kind: ContainerKind) {
    setPickingContainer(false);
    const copies = selectedRows.reduce((sum, r) => sum + r.entry.quantity, 0);
    const mode = await file(
      containerId,
      selectedRows.map((r) => ({
        oracleId: r.entry.oracleId,
        quantity: r.entry.quantity,
        board: 'main' as const,
        scryfallId: r.entry.scryfallId,
        wants: { condition: r.entry.condition, finish: r.entry.finish, lang: r.entry.lang },
        label: r.oracle?.name,
        sub: [r.printing?.setName, r.entry.condition, r.entry.finish, r.entry.lang !== 'en' ? r.entry.lang : null]
          .filter(Boolean)
          .join(' · '),
      })),
    );
    if (mode === null) return; // backed out of the prompt — selection stays put
    const noun = CONTAINER_META[kind].noun;
    toast(
      mode === 'move'
        ? `Moved ${copies} card${plural(copies)} to ${noun}`
        : `Added ${copies} card${plural(copies)} to ${noun}`,
    );
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
        { label: 'File away', icon: 'decks', onClick: () => setPickingContainer(true) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: bulkDelete },
      ];

  if (rows === undefined) return <p className="search-meta">Loading…</p>;

  // An active filter emptying the list is not an empty collection — don't offer
  // the "add some cards" onboarding to someone who has simply filed them all.
  const emptyState = placeFilter === 'conflict' && !query ? (
    <p className="search-meta">Nothing is double-filed. Every copy is in exactly one place.</p>
  ) : query || placeFilter !== 'all' ? (
    <p className="search-meta">Nothing here matches.</p>
  ) : (
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
          {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'} · {totalQty} card{totalQty === 1 ? '' : 's'}
        </p>
        <div className="meta-actions">
          {placeFilter === 'conflict' && filtered.length > 0 && (
            <button className="select-toggle" onClick={() => navigate('/conflicts')} title="Work through these one by one">
              <Icon name="balance" size={15} /> Sort them out
            </button>
          )}
          {!pileMode && !sel.active && filtered.length > 0 && (
            <button className="select-toggle" onClick={sel.enter} title="Select multiple cards">
              <Icon name="check" size={15} /> Select
            </button>
          )}
          <div className="sort-controls">
            <select
              className={placeFilter === 'all' ? '' : 'filter-on'}
              value={placeFilter}
              onChange={(e) => setPlaceFilter(e.target.value as PlaceFilter)}
              aria-label="Filter by where cards are filed"
              title="Show only cards that are (or aren't) in a deck, binder or box"
            >
              {PLACE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {!pileMode && <SortControls prefs={sort} onChange={setSort} withChange withDates />}
          {!pileMode && <ViewToggle mode={view} onChange={setView} />}
        </div>
      </div>

      {pileMode ? (
        matching.length === 0 ? (
          emptyState
        ) : (
          <PileView items={pileItems} />
        )
      ) : filtered.length === 0 ? (
        emptyState
      ) : (
        <CardItems
          view={view}
          selectable={sel.active}
          selectedKeys={sel.selected}
          onToggleSelect={sel.toggle}
          items={visible.map((r) => collectionCardItem(r, { moverFlags, placements, onClick: () => setEditing(r) }))}
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
      {pickingContainer && (
        <ContainerPickerSheet onPick={bulkAddContainer} onClose={() => setPickingContainer(false)} />
      )}
      {filingSheet}

      {editing?.oracle && <CardSheet oracleCard={editing.oracle} entry={editing.entry} onClose={() => setEditing(null)} />}
      {cardBack && <CardBackSheet onClose={() => setCardBack(false)} />}
    </>
  );
}
