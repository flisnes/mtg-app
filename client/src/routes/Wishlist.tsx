import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { joinWishlistEntries, type JoinedWish } from '../db/queries.js';
import { addToWishlistBulk, removeFromWishlist } from '../db/dataAccess.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode } from '../components/CardViews.js';
import { wishCardItem } from '../components/cardRows.js';
import { BulkActionBar } from '../components/BulkActionBar.js';
import { useMultiSelect } from '../components/useMultiSelect.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { addToTotal, formatTotal, priceValue, SortControls, sortCards, useCardSort, type PriceTotal } from '../components/CardSorting.js';
import { HeaderValue } from '../components/ValueSummary.js';
import { useListFilter, useOpenSearch } from '../components/GlobalSearch.js';
import { Icon } from '../components/icons.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { useToast } from '../components/Toast.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { loadLastEdited, lastEditedFor } from '../history/lastEdited.js';
import { buildWishlistText, downloadText } from '../import/export.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import type { ResolvedLine, UnmatchedLine } from '../import/types.js';

export function Wishlist() {
  const [view, setView] = useViewMode();
  const [sort, setSort] = useCardSort('wishlist');
  const openSearch = useOpenSearch();
  const [editing, setEditing] = useState<JoinedWish | null>(null);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const moverFlags = useMoverFlags();
  const ownership = useOwnershipIndex();
  const toast = useToast();
  const sel = useMultiSelect();
  const rows = useLiveQuery(async () => joinWishlistEntries(await db.wishlist.toArray()), []);
  // Header search scoped to the wishlist narrows these rows in place, so sort,
  // Select and the bulk remove all act on the search result.
  const query = useListFilter('wishlist');
  const matchesQuery = useEntryMatcher(rows, query);

  // Per-printing "last edited" (the top of that printing's History tab), not
  // entry.updatedAt — see CollectionListView. "Any printing" wishes span the
  // whole oracle; lastEditedFor handles the null scryfallId.
  const needEdited = sort.key === 'updated';
  const lastEdited = useLiveQuery(async () => (needEdited ? loadLastEdited() : undefined), [needEdited]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return sortCards(
      rows.filter(matchesQuery),
      (r) => ({
        name: r.oracle?.name,
        cmc: r.oracle?.cmc,
        price: priceValue(r.printing, r.oracle),
        added: r.entry.createdAt,
        updated: (lastEdited && lastEditedFor(lastEdited, r.entry.oracleId, r.entry.scryfallId)) ?? r.entry.updatedAt,
      }),
      sort,
    );
  }, [rows, matchesQuery, sort, lastEdited]);

  // Value covers the whole wishlist, not just the filtered view.
  const value = useMemo(() => {
    if (!rows) return undefined;
    const total: PriceTotal = { eur: 0, usd: 0 };
    for (const r of rows) addToTotal(total, r.entry.quantity, r.printing, r.oracle);
    return formatTotal(total);
  }, [rows]);

  const selectedRows = filtered.filter((r) => sel.selected.has(r.entry.id));
  const allKeys = filtered.map((r) => r.entry.id);

  async function bulkDelete() {
    const n = selectedRows.length;
    if (!window.confirm(`Remove ${n} ${n === 1 ? 'card' : 'cards'} from your wishlist?`)) return;
    for (const r of selectedRows) await removeFromWishlist(r.entry.id);
    toast(`Removed ${n} ${n === 1 ? 'card' : 'cards'} from wishlist`);
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
      subtitle="Cards you’re after, shown to trade partners during a session."
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
      {importing && <ImportPanel onDone={() => setImporting(false)} />}
      {rows === undefined ? (
        <p className="search-meta">Loading…</p>
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
          <div className="meta-row">
            <p className="search-meta">{filtered.length} card{filtered.length === 1 ? '' : 's'}</p>
            <div className="meta-actions">
              {!sel.active && filtered.length > 0 && (
                <button className="select-toggle" onClick={sel.enter} title="Select multiple cards">
                  <Icon name="check" size={15} /> Select
                </button>
              )}
              <SortControls prefs={sort} onChange={setSort} withDates />
              <ViewToggle mode={view} onChange={setView} />
            </div>
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
                wishCardItem(r, { ownership, moverFlags, onClick: r.oracle ? () => setEditing(r) : undefined }),
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
          actions={[{ label: 'Remove from wishlist', icon: 'trash', danger: true, onClick: bulkDelete }]}
        />
      )}

      {editing?.oracle && (
        <CardSheet oracleCard={editing.oracle} wishEntry={editing.entry} onClose={() => setEditing(null)} />
      )}

      {scanning && <ScanSheet target={{ kind: 'wishlist' }} onClose={() => setScanning(false)} />}
    </Page>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const { status, analyze, reset } = useImportAnalysis();
  const toast = useToast();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content);
  }

  // Wishlist wishes are printing-agnostic by default — a pasted "4 Lightning
  // Bolt" means "any printing", so every imported line lands as such.
  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: 0,
    condition: 'NM',
    finish: 'nonfoil',
    lang: 'en',
  });

  async function confirm(lines: ResolvedLine[]) {
    const res = await addToWishlistBulk(
      lines.map((l) => ({ oracleId: l.oracleId, scryfallId: null, quantity: l.quantity })),
      { label: 'Wishlist import' },
    );
    toast(`Added ${res.cards} card${res.cards === 1 ? '' : 's'} to wishlist`);
    onDone();
  }

  if (status.kind === 'review') {
    return (
      <div className="about-section">
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={confirm}
          onCancel={reset}
          confirmLabel={(n) => `Add ${n} to wishlist`}
        />
      </div>
    );
  }

  if (status.kind === 'working') {
    return (
      <div className="about-section">
        <p className="gate-msg">{status.label}</p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${Math.round(status.fraction * 100)}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="about-section">
      {status.kind === 'error' && <p className="gate-error">Error: {status.message}</p>}
      <p className="fine-print">Paste a list or upload a file. Everything imports as “any printing”.</p>
      <textarea
        className="search-input"
        style={{ minHeight: 140, fontFamily: 'ui-monospace, monospace' }}
        placeholder={'4 Lightning Bolt\n1 Sol Ring\n…or paste a Moxfield/Archidekt list'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="list-toolbar">
        <button className="primary" onClick={() => analyze(text)} disabled={!text.trim()}>
          Analyze
        </button>
        <input type="file" accept=".csv,.txt,text/*" onChange={onFile} />
      </div>
    </div>
  );
}
