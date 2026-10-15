import { useMemo, useState } from 'react';
import { Page } from './Page.js';
import { type JoinedWish } from '../db/queries.js';
import { useJoinedWishes, useWishes } from '../db/collectionSnapshot.js';
import { addToWishlistBulk, removeFromWishlist, wishKey } from '../db/dataAccess.js';
import { preferredScryfallId } from '../cardDb/preferredPrinting.js';
import { useDisplayPrintings } from '../cardDb/useDisplayPrintings.js';
import { CardSheet } from '../components/CardSheet.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { describeFiling, useIntakeReview } from '../import/intake/useIntakeReview.js';
import { CardItems, ViewToggle, useViewMode } from '../components/CardViews.js';
import { wishCardItem } from '../components/cardRows.js';
import { BulkActionBar } from '../components/BulkActionBar.js';
import { useMultiSelect } from '../components/useMultiSelect.js';
import { SelectToggle } from '../components/SelectToggle.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { addToTotal, formatTotal, SortControls, sortCards, useCardSort, type PriceTotal } from '../components/CardSorting.js';
import { wishSortFields } from '../components/useEntrySort.js';
import { HeaderValue } from '../components/ValueSummary.js';
import { ListSearchButton, useListFilter, useOpenSearch } from '../components/GlobalSearch.js';
import { Icon } from '../components/icons.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheetLazy.js';
import { CardDropZone } from '../components/CardDropZone.js';
import { useToast } from '../components/Toast.js';
import { useUndoShortcut } from '../history/useUndoShortcut.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { buildWishlistText, downloadText } from '../import/export.js';
import { ImportPanel } from '../import/ImportPanel.js';
import { OverlapChoice, applyOverlap, type OverlapMode } from '../import/ImportExtras.js';
import type { ResolvedLine } from '../import/types.js';
import { fmtCardCount, plural } from '../util/format.js';
import { Loading } from '../components/Loading.js';

export function Wishlist() {
  const [view, setView] = useViewMode();
  useUndoShortcut({ kind: 'wishlist' });
  const [sort, setSort] = useCardSort('wishlist');
  const openSearch = useOpenSearch();
  const [editing, setEditing] = useState<JoinedWish | null>(null);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const moverFlags = useMoverFlags();
  const ownership = useOwnershipIndex();
  const toast = useToast();
  const sel = useMultiSelect();
  const { confirm, sheet: confirmSheet } = useConfirm();
  const { open: review, sheet: intakeSheet } = useIntakeReview();
  const rows = useJoinedWishes();
  // An "any printing" wish wears your preferred printing, same as a search result.
  const anyWishes = useMemo(() => rows?.filter((r) => !r.entry.scryfallId).map((r) => r.entry), [rows]);
  const shown = useDisplayPrintings(anyWishes);
  // Header search scoped to the wishlist narrows these rows in place, so sort,
  // Select and the bulk remove all act on the search result.
  const query = useListFilter('wishlist');
  const matchesQuery = useEntryMatcher(rows, query);


  const filtered = useMemo(() => {
    if (!rows) return [];
    return sortCards(rows.filter(matchesQuery), (r) => wishSortFields(r), sort);
  }, [rows, matchesQuery, sort]);

  // Value covers the whole wishlist, not just the filtered view.
  const value = useMemo(() => {
    if (!rows) return undefined;
    const total: PriceTotal = { eur: 0, usd: 0 };
    for (const r of rows) addToTotal(total, r.entry.quantity, r.printing ?? shown.get(r.entry.oracleId), r.oracle);
    return formatTotal(total);
  }, [rows, shown]);

  const selectedRows = filtered.filter((r) => sel.selected.has(r.entry.id));
  const allKeys = filtered.map((r) => r.entry.id);

  async function bulkDelete() {
    const n = selectedRows.length;
    const ok = await confirm({
      title: `Remove ${n} ${n === 1 ? 'card' : 'cards'}?`,
      body: `${n === 1 ? 'It comes' : 'They come'} off your wishlist. Nothing else changes.`,
      confirmLabel: 'Remove from wishlist',
      danger: true,
    });
    if (!ok) return;
    for (const r of selectedRows) await removeFromWishlist(r.entry.id);
    toast(`Removed ${n} ${n === 1 ? 'card' : 'cards'} from wishlist`);
    sel.exit();
  }

  /**
   * "I bought these": the whole point of a wishlist, and the one thing you
   * couldn't do to a selection of it. Each wish becomes a collection entry —
   * the edition it asked for, or your preferred printing when it wished for
   * "any" — comes off the wishlist, and is offered a home in one go.
   */
  async function bulkAcquire() {
    const rows = selectedRows.filter((r) => r.oracle);
    if (rows.length === 0) return;
    const lines: ResolvedLine[] = [];
    for (const r of rows) {
      const scryfallId = r.entry.scryfallId ?? (await preferredScryfallId(r.oracle!));
      lines.push({
        oracleId: r.entry.oracleId,
        scryfallId,
        name: r.oracle!.name,
        quantity: r.entry.quantity,
        quantityForTrade: 0,
        // A wish's traits are preferences, and "no preference" means the
        // ordinary copy — the same reading the wishlist scan uses.
        condition: r.entry.condition ?? 'NM',
        finish: r.entry.finish ?? 'nonfoil',
        lang: r.entry.lang ?? 'en',
      });
    }
    // "Where do these live?" comes first; nothing is written if they back out.
    const res = await review({ flow: 'bought', lines, source: 'import', label: 'Bought from wishlist' });
    if (!res) return;
    for (const r of rows) await removeFromWishlist(r.entry.id);
    toast(`Moved ${res.added} ${plural(res.added, 'card')} into your collection${describeFiling(res)}`);
    sel.exit();
  }

  async function exportWishlist() {
    if (!rows?.length) {
      toast('Your wishlist is empty');
      return;
    }
    const text = await buildWishlistText();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`mtg-wishlist-${stamp}.txt`, text);
    toast('Exported wishlist');
  }

  return (
    <Page
      title="Wishlist"
      meta={
        rows && rows.length > 0
          ? fmtCardCount(filtered.reduce((s, r) => s + r.entry.quantity, 0), filtered.length)
          : undefined
      }
      aside={<HeaderValue value={value} />}
      menu={
        <OptionsMenu
          label="Wishlist options"
          actions={[
            { label: 'Scan cards', icon: 'camera', onClick: () => setScanning(true) },
            { label: 'Import', icon: 'import', onClick: () => setImporting((v) => !v) },
            { label: 'Export', icon: 'export', onClick: exportWishlist },
          ]}
        />
      }
    >
      {importing && <WishlistImport onDone={() => setImporting(false)} />}
      {rows === undefined ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p>Nothing on your wishlist yet.</p>
          <p className="empty-phase">
            <button className="linklike" onClick={openSearch}>Search for cards</button> and tap +
            <Icon name="wishlist" size={14} />.
          </p>
        </div>
      ) : (
        <>
          <div className="list-toolbar">
            {!sel.active && <ListSearchButton />}
            {!sel.active && filtered.length > 0 && <SelectToggle onEnter={sel.enter} />}
            <SortControls prefs={sort} onChange={setSort} withDates withRelease />
            <ViewToggle mode={view} onChange={setView} />
          </div>
          {filtered.length === 0 ? (
            <p className="search-meta">Nothing here matches.</p>
          ) : (
            <CardItems
              view={view}
              selectable={sel.active}
              selectedKeys={sel.selected}
              onToggleSelect={sel.toggle}
              items={filtered.map((r) =>
                wishCardItem(r, {
                  ownership,
                  moverFlags,
                  showYear: sort.key === 'released',
                  shown: shown.get(r.entry.oracleId),
                  onClick: r.oracle ? () => setEditing(r) : undefined,
                }),
              )}
            />
          )}
        </>
      )}

      {sel.active && (
        <BulkActionBar
          count={selectedRows.length}
          allSelected={allKeys.length > 0 && allKeys.every((k) => sel.selected.has(k))}
          onToggleAll={() => sel.toggleAll(allKeys)}
          onCancel={sel.exit}
          actions={[
            { label: 'I bought these', icon: 'collection', onClick: () => void bulkAcquire() },
            { label: 'Remove from wishlist', icon: 'trash', danger: true, onClick: () => void bulkDelete() },
          ]}
        />
      )}

      {editing?.oracle && (
        <CardSheet mode="wish" oracleCard={editing.oracle} wishEntry={editing.entry} onClose={() => setEditing(null)} />
      )}

      {scanning && <ScanSheet target={{ kind: 'wishlist' }} onClose={() => setScanning(false)} />}
      <CardDropZone target={scanning ? null : { kind: 'wishlist' }} />
      {confirmSheet}
      {intakeSheet}
    </Page>
  );
}

function WishlistImport({ onDone }: { onDone: () => void }) {
  const [overlap, setOverlap] = useState<OverlapMode>('add');
  const toast = useToast();
  // What's already wished for, so the import can say so instead of silently
  // stacking a second copy of every line onto the first.
  const wishes = useWishes();

  // A wish that names no edition means "any printing", but a line that *did*
  // name one asked for that edition, and throwing it away made the list say
  // something it didn't. Same for finish and language: the defaults mean "any",
  // anything else is a stated preference and is kept.
  const wishLine = (l: ResolvedLine) => ({
    oracleId: l.oracleId,
    scryfallId: l.pinnedPrinting ? l.scryfallId : null,
    quantity: l.quantity,
    ...(l.condition !== 'NM' ? { condition: l.condition } : {}),
    ...(l.finish !== 'nonfoil' ? { finish: l.finish } : {}),
    ...(l.lang !== 'en' ? { lang: l.lang } : {}),
  });

  const keyOf = (w: { oracleId: string; scryfallId: string | null; condition?: string; finish?: string; lang?: string }) =>
    `${w.oracleId}|${wishKey(w as Parameters<typeof wishKey>[0])}`;

  const have = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of wishes ?? []) map.set(keyOf(w), (map.get(keyOf(w)) ?? 0) + w.quantity);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wishes]);

  async function confirm(lines: ResolvedLine[]) {
    const wanted = applyOverlap(lines.map(wishLine), overlap, have, keyOf);
    if (wanted.length === 0) {
      toast('Nothing added: every card was already on your wishlist');
      onDone();
      return;
    }
    const res = await addToWishlistBulk(wanted, { label: 'Wishlist import' });
    toast(`Added ${res.cards} ${plural(res.cards, 'card')} to wishlist`);
    onDone();
  }

  return (
    <ImportPanel
      intro="Paste a list or upload a file. A line that names an edition wishes for that edition; the rest import as “any printing”."
      showCondition={false}
      onConfirm={confirm}
      confirmLabel={(n) => `Add ${n} to wishlist`}
      aboveReview={(resolved) => {
        const already = resolved.filter((l) => (have.get(keyOf(wishLine(l))) ?? 0) > 0).length;
        return already > 0 && <OverlapChoice count={already} where="on your wishlist" value={overlap} onChange={setOverlap} />;
      }}
    />
  );
}
