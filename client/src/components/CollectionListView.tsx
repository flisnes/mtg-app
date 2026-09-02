import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { CONTAINER_META } from '../deck/containers.js';
import { joinCollectionEntries, type JoinedEntry } from '../db/queries.js';
import { removeCollectionEntriesBulk, removeDeckCardsMatching, setQuantityForTradeBulk } from '../db/dataAccess.js';
import { useFiling } from '../deck/useFiling.js';
import { CardSheet } from './CardSheet.js';
import { useConfirm } from './ConfirmSheet.js';
import { CardItems, ViewToggle, useGridColumns, useViewMode } from './CardViews.js';
import { collectionCardItem } from './cardRows.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { BulkActionBar, type BulkAction } from './BulkActionBar.js';
import { ContainerPickerSheet } from './ContainerPickerSheet.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { useMultiSelect } from './useMultiSelect.js';
import { SelectToggle } from './SelectToggle.js';
import { PileView, CardBackSheet, type PileEntry } from './PileView.js';
import { SortControls, sortCards, useCardSort } from './CardSorting.js';
import { collectionSortFields, useEntrySortData } from './useEntrySort.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useGoblinMode } from './useGoblinMode.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { ListSearchButton, useListFilter, useOpenSearch } from './GlobalSearch.js';
import { useToast } from './Toast.js';
import { Icon } from './icons.js';
import { usePageMeta } from '../routes/Page.js';

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
  const [unfiling, setUnfiling] = useState(false);
  const { confirm, sheet: confirmSheet } = useConfirm();
  // Deliberately not persisted: a filter that hides cards shouldn't outlive the
  // visit that set it, or you come back tomorrow to a collection with holes.
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>('all');

  // The price-change and last-edited data the heavier sorts need, loaded only
  // while one of them is active. Shared with the search scoped into this list.
  const sortData = useEntrySortData(sort);

  // "Filed" is about copies, not rows. One row is every copy of one printing in
  // one finish, condition and language, so filing one of your two Bolts leaves a
  // row that is filed *and* loose: it belongs in "Somewhere" for the copy in the
  // deck and in "Nowhere" for the one still in the shoebox. Counting containers
  // instead of copies is what used to hide that loose Bolt. Until the index
  // loads there's nothing to judge by, so everything passes rather than the list
  // flashing empty.
  const matchesPlacement = useCallback(
    (r: JoinedEntry) => {
      if (placeFilter === 'all' || !placements) return true;
      const info = placements.lookup(r.entry.oracleId, r.entry.scryfallId, {
        condition: r.entry.condition,
        finish: r.entry.finish,
        lang: r.entry.lang,
      });
      if (placeFilter === 'conflict') return info.over;
      // Copies of this row a deck, binder or box says it's holding — the same
      // slots the row's badge counts.
      const filed = info.places.reduce((n, p) => n + p.quantity, 0);
      return placeFilter === 'filed' ? filed > 0 : filed < r.entry.quantity;
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
    return sortCards(matching, (r) => collectionSortFields(r, sortData), sort);
  }, [rows, matching, sort, sortData]);

  const totalQty = filtered.reduce((s, r) => s + r.entry.quantity, 0);
  // The count belongs in the page header, right under the title, so the cards
  // start as high up the screen as they can. Standing outside a Page (never
  // today, but the view doesn't require one) it falls back to its own line.
  const countLine = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'} · ${totalQty} card${totalQty === 1 ? '' : 's'}`;
  const hoistedCount = usePageMeta(countLine);

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
  const { gridRef, columns } = useGridColumns();
  const { limit, showMore } = usePagedLimit(filterSig, 60, columns);
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
    const ok = await confirm({
      title: `Delete ${n} ${n === 1 ? 'entry' : 'entries'}?`,
      body: `${n === 1 ? 'This copy' : 'These copies'} leave your collection, and any deck, binder or box holding ${n === 1 ? 'it' : 'them'} is left asking for a card you no longer have.`,
      confirmLabel: 'Delete from collection',
      danger: true,
    });
    if (!ok) return;
    await removeCollectionEntriesBulk(selectedRows.map((r) => r.entry.id));
    toast(`Deleted ${n} ${n === 1 ? 'entry' : 'entries'}`);
    sel.exit();
  }

  /**
   * Take the selection back out of a container. This lived only inside a
   * container, which meant the screen that *tells* you a card is double-filed
   * (the pills, the "in too many places" filter) was the one screen that
   * couldn't do anything about it.
   */
  async function bulkUnfile(containerId: string, kind: ContainerKind) {
    setUnfiling(false);
    const removed = await removeDeckCardsMatching(
      containerId,
      selectedRows.map((r) => ({
        oracleId: r.entry.oracleId,
        scryfallId: r.entry.scryfallId,
        quantity: r.entry.quantity,
        wants: { condition: r.entry.condition, finish: r.entry.finish, lang: r.entry.lang },
      })),
    );
    const noun = CONTAINER_META[kind].noun;
    toast(
      removed === 0
        ? `Nothing matched in that ${noun}`
        : `Took ${removed} card${plural(removed)} out of that ${noun}`,
    );
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
    const filing = await file(
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
    if (filing === null) return; // backed out of the prompt — selection stays put
    const noun = CONTAINER_META[kind].noun;
    // The count is what went in, not what was asked for: a line whose copies are
    // already in there adds nothing, and a toast that claims otherwise is how
    // you end up with three copies of a card you own two of.
    const copies = filing.filed;
    toast(
      copies === 0
        ? `Already in that ${noun}`
        : filing.mode === 'move'
          ? `Moved ${copies} card${plural(copies)} to ${noun}`
          : `Added ${copies} card${plural(copies)} to ${noun}`,
    );
    sel.exit();
  }

  // Where the selection is filed right now, so "Unfile…" can offer the places
  // that actually hold some of it (and grey itself out when none do).
  const elsewhere = new Map<string, number>();
  for (const r of selectedRows) {
    const wants = { condition: r.entry.condition, finish: r.entry.finish, lang: r.entry.lang };
    for (const p of placements?.lookup(r.entry.oracleId, r.entry.scryfallId, wants).places ?? []) {
      elsewhere.set(p.containerId, (elsewhere.get(p.containerId) ?? 0) + 1);
    }
  }

  // The tradelist is the collection with one prop flipped and holds the same
  // cardboard, so it gets the same verbs. Only "add to tradelist" is dropped:
  // everything here is already on it.
  const bulkActions: BulkAction[] = [
    ...(onlyTrade
      ? [{ label: 'Remove from tradelist', icon: 'tradelist' as const, onClick: bulkRemoveTradelist }]
      : [
          { label: 'Add to tradelist', icon: 'tradelist' as const, onClick: bulkAddTradelist },
          { label: 'Remove from tradelist', icon: 'close' as const, onClick: bulkRemoveTradelist },
        ]),
    { label: 'File away…', icon: 'decks', onClick: () => setPickingContainer(true) },
    { label: 'Unfile…', icon: 'minus', disabled: elsewhere.size === 0, onClick: () => setUnfiling(true) },
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => void bulkDelete() },
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
      {!hoistedCount && <p className="search-meta">{countLine}</p>}
      <div className="list-toolbar">
        {placeFilter === 'conflict' && filtered.length > 0 && (
          <button className="select-toggle" onClick={() => navigate('/conflicts')} title="Work through these one by one">
            <Icon name="balance" size={15} /> Sort them out
          </button>
        )}
        {!sel.active && (filtered.length > 0 || query) && <ListSearchButton />}
        {!sel.active && filtered.length > 0 && <SelectToggle onEnter={sel.enter} />}
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

      {/* Goblin mode has no Select of its own: ticking cards out of a shuffled
          heap fights the shove-and-flip gestures that are the whole point of
          it. Tapping Select lays the pile out as a list for as long as you're
          picking, and Cancel drops you back into the mess. */}
      {sel.active && pileMode && (
        <p className="search-meta">Picking cards — the pile comes back when you're done.</p>
      )}

      {pileMode && !sel.active ? (
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
          gridRef={gridRef}
          selectable={sel.active}
          selectedKeys={sel.selected}
          onToggleSelect={sel.toggle}
          items={visible.map((r) => collectionCardItem(r, { moverFlags, placements, onClick: () => setEditing(r) }))}
        />
      )}
      {(!pileMode || sel.active) && (
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
      {unfiling && (
        <ContainerPickerSheet
          title="Take out of"
          label="Choose where to remove these from"
          only={new Set(elsewhere.keys())}
          noteFor={(cid) => `holds ${elsewhere.get(cid) ?? 0} of these`}
          emptyText="None of the selected cards are filed anywhere."
          onPick={(id, kind) => void bulkUnfile(id, kind)}
          onClose={() => setUnfiling(false)}
        />
      )}
      {filingSheet}
      {confirmSheet}

      {editing?.oracle && <CardSheet mode="edit" oracleCard={editing.oracle} entry={editing.entry} onClose={() => setEditing(null)} />}
      {cardBack && <CardBackSheet onClose={() => setCardBack(false)} />}
    </>
  );
}
