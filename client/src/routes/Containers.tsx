import { useEffect, useMemo, useState } from 'react';
import { FilterSelect } from '../components/FilterSelect.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import {
  COLOR_NAME,
  COLORS,
  CONTAINER_KINDS,
  DECK_FORMATS,
  type Color,
  type ContainerKind,
  type Deck,
  type DeckFolder,
  type DeckFormat,
} from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import {
  createContainer,
  createDeckFolder,
  deleteDeck,
  deleteDeckFolder,
  renameDeckFolder,
  setDeckArchived,
  setDeckEmblem,
  setDeckFolder,
  unfileWholeContainer,
} from '../db/dataAccess.js';
import { useContainers, useContainersByRecent } from '../db/collectionSnapshot.js';
import { useDeckSummaries } from '../deck/deckSummary.js';
import { formatLabel } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { Icon } from '../components/icons.js';
import { Emblem } from '../components/Emblem.js';
import { EmblemPickerSheet } from '../components/EmblemPickerSheet.js';
import { ManaCost } from '../components/ManaCost.js';
import { HeaderValue, missingValue, useContainersValue, valueText, type ContainerValue } from '../components/ValueSummary.js';
import { sortRows } from '../components/cardSort.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { DeckFolderPickerSheet } from '../components/DeckFolderPickerSheet.js';
import { ArchiveDeckSheet } from '../components/ArchiveDeckSheet.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { convertToDisplay } from '../price/rates.js';
import { plural } from '../util/format.js';
import { Loading } from '../components/Loading.js';
import { MenuRow } from '../components/MenuRow.js';

/**
 * The Archived folder isn't a DeckFolder row — there is nothing to name, rename
 * or delete, and it exists before you have archived anything. It's a deck flag
 * (Deck.archivedAt) shown as a folder, so `openFolderId` carries this sentinel
 * when the archive is the open view. Reserved ids can't collide with a real
 * folder's: those are newId() output.
 */
const ARCHIVE_ID = '__archive__';

// 'recent' is the default — the deck list's existing order (updatedAt desc,
// straight off the DB query) — so adding sort/filter doesn't change what a
// deck list looks like until the user actually picks a field to sort by.
type DeckSortKey = 'recent' | 'name' | 'format' | 'color' | 'value';
type SortDir = 'asc' | 'desc';

/** colors is already WUBRG-ordered, so joining sorts mono before multi before
 *  colorless (a bare '' comes first, ahead of every letter) — reorder so
 *  colorless sorts last instead, which reads better in a deck list. */
function colorSortKey(colors: Color[]): string {
  return colors.length ? colors.join('') : '￿';
}

/** A single comparable number for "how much is this worth", converted into the
 *  display currency; falls back to the raw (mixed-currency) sum on the rare
 *  render where a conversion rate hasn't loaded yet — good enough for ordering. */
function ownedValueNumber(value: ContainerValue | undefined): number {
  if (!value) return 0;
  const eur = value.owned.eur > 0 ? convertToDisplay(value.owned.eur, 'EUR') : 0;
  const usd = value.owned.usd > 0 ? convertToDisplay(value.owned.usd, 'USD') : 0;
  if (eur != null && usd != null) return eur + usd;
  return value.owned.eur + value.owned.usd;
}

/**
 * Decks, binders and boxes, one screen with three segments. All three are rows
 * of the same table (see deck/containers.ts): a deck is a list you brew, a
 * binder or box is where the cards physically live. The segment only changes
 * which rows show, whether a format is offered, and the wording.
 */
export function Containers({ kind }: { kind: ContainerKind }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { confirm, sheet: confirmSheet } = useConfirm();
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [movingDeck, setMovingDeck] = useState<{ id: string; name: string; folderId?: string } | null>(null);
  const [emblemDeck, setEmblemDeck] = useState<Deck | null>(null);
  const [archivingDeck, setArchivingDeck] = useState<{ id: string; name: string; filed: number } | null>(null);
  const [query, setQuery] = useState('');
  const [filterFormat, setFilterFormat] = useState<DeckFormat | ''>('');
  const [filterColor, setFilterColor] = useState<Color | ''>('');
  const [sortKey, setSortKey] = useState<DeckSortKey>('recent');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // Ignore folder grouping entirely and show every deck flattened — folders
  // stay put, this just bypasses them. Clearing the open folder alongside it
  // keeps "which folder is a new deck created into" unambiguous.
  const [showAllDecks, setShowAllDecks] = useState(false);
  const meta = CONTAINER_META[kind];
  const isDeck = kind === 'deck';

  // Folders are a deck-only concept; leaving the deck tab drops back to the
  // top level so returning to Decks doesn't reopen a folder from memory.
  useEffect(() => {
    if (!isDeck) setOpenFolderId(null);
  }, [isDeck]);

  const folders = useLiveQuery(
    () => (isDeck ? db.deckFolders.orderBy('name').toArray() : Promise.resolve<DeckFolder[]>([])),
    [isDeck],
  );
  const folderNameById = useMemo(() => new Map((folders ?? []).map((f) => [f.id, f.name])), [folders]);
  const hasFolders = isDeck && !!folders && folders.length > 0;
  const openFolder = isDeck ? folders?.find((f) => f.id === openFolderId) : undefined;
  const archiveOpen = isDeck && openFolderId === ARCHIVE_ID;

  // How many decks sit in each folder, and how many are archived — a cheap
  // separate pass (no card lookups) so opening the sidebar doesn't pay for the
  // detailed `rows` summary below across every deck, only the ones actually in
  // view. An archived deck keeps its folderId but no longer counts toward it:
  // it isn't in there any more, and a folder reading "3" with one deck inside
  // sends you looking for the other two.
  const { containers } = useContainers();
  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    if (!containers) return undefined;
    if (!isDeck) return { counts, archived: 0 };
    let archived = 0;
    for (const d of containers) {
      if (containerKind(d) !== 'deck') continue;
      if (d.archivedAt) {
        archived++;
        continue;
      }
      if (!d.folderId) continue;
      counts.set(d.folderId, (counts.get(d.folderId) ?? 0) + 1);
    }
    return { counts, archived };
  }, [containers, isDeck]);
  const archivedCount = tally?.archived ?? 0;

  // Restore the last deck in the archive and the view you're looking at has
  // nothing left in it — and the tile that got you here is dimmed and inert, so
  // you couldn't come back to see it. Drop back up a level instead of leaving
  // you on a dead end. `tally &&` so the first render, before the count loads,
  // doesn't bounce you straight out.
  useEffect(() => {
    if (archiveOpen && tally && tally.archived === 0) setOpenFolderId(null);
  }, [archiveOpen, tally]);

  const recent = useContainersByRecent();
  const listed = useMemo(() => {
    const inArchive = isDeck && openFolderId === ARCHIVE_ID;
    return recent?.filter((d) => {
      if (containerKind(d) !== kind) return false;
      if (!isDeck) return true;
      // The archive is the only view an archived deck shows in — including
      // "All decks", which means every deck you're still playing.
      if (inArchive) return !!d.archivedAt;
      if (d.archivedAt) return false;
      if (showAllDecks) return true;
      return openFolderId ? d.folderId === openFolderId : !d.folderId;
    });
  }, [recent, kind, isDeck, openFolderId, showAllDecks]);
  // Size, colours and filed copies (for the archive prompt's "take them out
  // too?") per row: one oracle lookup for the whole view.
  const rows = useDeckSummaries(listed);

  const value = useContainersValue(kind);

  const visibleRows = useMemo(() => {
    if (!rows || !isDeck) return rows;
    const q = query.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter(({ deck }) => deck.name.toLowerCase().includes(q));
    if (filterFormat) out = out.filter(({ deck }) => (deck.format ?? 'casual') === filterFormat);
    if (filterColor) out = out.filter(({ colors }) => colors.includes(filterColor));
    if (sortKey === 'recent') return out;
    return sortRows(
      out,
      { key: sortKey, dir: sortDir },
      (r, key) =>
        key === 'format'
          ? (r.deck.format ?? 'casual')
          : key === 'color'
            ? colorSortKey(r.colors)
            : key === 'value'
              ? ownedValueNumber(value?.byId.get(r.deck.id))
              : null,
      (r) => r.deck.name,
    );
  }, [rows, isDeck, query, filterFormat, filterColor, sortKey, sortDir, value]);
  // Header leads with what the copies you actually hold are worth; the cards on
  // a list you don't own yet aren't money on your shelf.
  const ownedTotal = value ? (valueText(value.total.owned) ?? '—') : undefined;
  const missingTotal = value ? valueText(missingValue(value.total)) : undefined;

  async function create() {
    // The archive is a view, not a home for new decks — brew into the top level.
    const id = await createContainer('', kind, 'casual', archiveOpen ? undefined : openFolderId ?? undefined);
    // The name/format are edited on the container's own page (works great
    // there), so land straight on it with the name field ready to type into.
    navigate(`${meta.path}/${id}`, { state: { focusName: true } });
  }

  async function createFolder() {
    const id = await createDeckFolder('');
    setRenamingFolderId(id);
    setRenameValue('Untitled folder');
  }

  function startRenameFolder(folder: DeckFolder) {
    setRenamingFolderId(folder.id);
    setRenameValue(folder.name);
  }

  async function commitRenameFolder() {
    if (renamingFolderId) await renameDeckFolder(renamingFolderId, renameValue);
    setRenamingFolderId(null);
  }

  async function removeFolder(folder: DeckFolder) {
    const ok = await confirm({
      title: `Delete folder “${folder.name}”?`,
      body: 'The decks inside it move back to the unorganized list. Nothing else is lost.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    if (openFolderId === folder.id) setOpenFolderId(null);
    await deleteDeckFolder(folder.id);
    toast(`Deleted folder “${folder.name}”`);
  }

  /**
   * Archive a deck, having asked whether the cardboard goes back on the shelf.
   * The list survives either way — that's the whole point of archiving over
   * deleting — so this never touches a slot's contents, only whether it's
   * holding a copy (see setDeckCardsUnfiled).
   */
  async function archiveDeck(unfile: boolean) {
    const deck = archivingDeck;
    if (!deck) return;
    setArchivingDeck(null);
    const freed = unfile ? await unfileWholeContainer(deck.id) : 0;
    await setDeckArchived(deck.id, true);
    toast(
      freed > 0
        ? `Archived “${deck.name}” · ${freed} ${plural(freed, 'card')} back on the shelf`
        : `Archived “${deck.name}”`,
    );
  }

  /** Out of the archive and back into the deck list — into its old folder, which
   *  it never left. Cards that were unfiled stay unfiled: rebuilding the deck
   *  means going and finding the cardboard again. */
  async function restoreDeck(deck: { id: string; name: string; folderId?: string }) {
    await setDeckArchived(deck.id, false);
    const where = deck.folderId ? folderNameById.get(deck.folderId) : undefined;
    toast(where ? `Restored “${deck.name}” to “${where}”` : `Restored “${deck.name}”`);
  }

  async function removeDeck(deck: { id: string; name: string }) {
    const ok = await confirm({
      title: `Delete “${deck.name}”?`,
      body: 'Everything filed in it goes with it. Cards you own stay in your collection. This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteDeck(deck.id);
    toast(`Deleted “${deck.name}”`);
  }

  // Swallow the click before it bubbles to the enclosing <Link> — stopping
  // propagation alone doesn't cancel the anchor's own navigation, so this also
  // needs preventDefault (bit us once already, with the folder-picker <select>
  // this replaced: opening it still navigated to the deck).
  function swallow(e: { preventDefault(): void; stopPropagation(): void }) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <Page
      title={archiveOpen ? 'Archived' : openFolder ? openFolder.name : meta.Plural}
      subtitle={
        archiveOpen
          ? 'Decks you have put away. Their lists are all still here.'
          : openFolder
            ? 'Decks in this folder.'
            : meta.subtitle
      }
      aside={
        <HeaderValue
          label={missingTotal ? 'Owned value' : 'Value'}
          value={ownedTotal}
          note={missingTotal && `+${missingTotal} not owned`}
        />
      }
    >
      {(openFolder || archiveOpen) && (
        <button className="linklike folder-crumb" onClick={() => setOpenFolderId(null)}>
          <Icon name="chevronLeft" size={16} className="chev" />
          Up a level
        </button>
      )}

      <div className="seg-row" role="tablist" aria-label="Decks, binders or boxes">
        {CONTAINER_KINDS.map((k) => (
          <Link
            key={k}
            role="tab"
            aria-selected={k === kind}
            className={k === kind ? 'seg seg-active' : 'seg'}
            to={CONTAINER_META[k].path}
          >
            {CONTAINER_META[k].Plural}
          </Link>
        ))}
      </div>

      <div className="list-toolbar">
        <button className="primary" onClick={create}>
          Add {meta.noun}
        </button>
        {isDeck && <button onClick={createFolder}>Add folder</button>}
      </div>

      {isDeck && (
        <div className="filter-row deck-filter-row">
          <input
            className="search-input"
            type="search"
            placeholder="Filter by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter decks by name"
          />
          <FilterSelect<DeckFormat | ''>
            value={filterFormat}
            onChange={setFilterFormat}
            neutral=""
            options={[['', 'Any format'], ...DECK_FORMATS.map((f) => [f, formatLabel(f)] as const)]}
            label="Filter by format"
          />
          <FilterSelect<Color | ''>
            value={filterColor}
            onChange={setFilterColor}
            neutral=""
            options={[['', 'Any color'], ...COLORS.map((c) => [c, COLOR_NAME[c]] as const)]}
            label="Filter by color"
          />
          <div className="sort-controls" role="group" aria-label="Sort decks">
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as DeckSortKey)} aria-label="Sort by">
              <option value="recent">Sort: Recent</option>
              <option value="name">Sort: Name</option>
              <option value="format">Sort: Format</option>
              <option value="color">Sort: Colors</option>
              <option value="value">Sort: Value</option>
            </select>
            {sortKey !== 'recent' && (
              <button
                className="sort-dir"
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                aria-label={sortDir === 'asc' ? 'Sort ascending' : 'Sort descending'}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            )}
          </div>
          {hasFolders && (
            <label className="deck-all-toggle">
              <input
                type="checkbox"
                checked={showAllDecks}
                onChange={(e) => {
                  setShowAllDecks(e.target.checked);
                  setOpenFolderId(null);
                }}
              />
              All decks
            </label>
          )}
        </div>
      )}

      <div className={hasFolders ? 'deck-board deck-board-split' : 'deck-board'}>
        <div className="deck-col-list">
          {visibleRows === undefined ? (
            <Loading />
          ) : visibleRows.length === 0 ? (
            <div className="empty-state">
              {rows && rows.length > 0 ? (
                <p>No decks match your filters.</p>
              ) : (
                <>
                  <p>
                    {archiveOpen
                      ? 'Nothing in the archive.'
                      : openFolder
                        ? `No decks in “${openFolder.name}” yet.`
                        : `No ${meta.Plural.toLowerCase()} yet.`}
                  </p>
                  <p className="empty-phase">
                    {archiveOpen
                      ? 'Archive a deck from its options menu to keep its list after you take it apart.'
                      : isDeck
                        ? `Tap “Add deck” above to make one.`
                        : `Tap “Add ${meta.noun}” above, then file cards into it from your collection.`}
                  </p>
                </>
              )}
            </div>
          ) : (
            <ul className="menu-list">
              {visibleRows.map(({ deck, main, side, colors, filed }) => {
                const own = value?.byId.get(deck.id);
                const ownText = own && valueText(own.owned);
                const missText = own && valueText(missingValue(own));
                const folderName = showAllDecks && deck.folderId ? folderNameById.get(deck.folderId) : undefined;
                return (
                <li key={deck.id}>
                  <MenuRow
                    to={`${meta.path}/${deck.id}`}
                    icon={<Emblem emblem={deck.emblem} kind={kind} size={28} />}
                    label={deck.name}
                    chevron={false}
                    meta={
                      <>
                        {isDeck && <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>}
                        <ManaCost
                          cost={colors.length > 0 ? colors.map((c) => `{${c}}`).join('') : '{C}'}
                          className="deck-colors"
                        />
                        {isDeck ? (
                          <span className="badge" title={`${main} mainboard · ${side} sideboard`}>
                            {main} {plural(main, 'card')}
                            {side > 0 && ` · ${side} side`}
                          </span>
                        ) : (
                          <span className="badge" title={`${main} ${plural(main, 'card')} filed here`}>
                            {main} {plural(main, 'card')}
                          </span>
                        )}
                        {folderName && <span className="badge deck-folder-badge">{folderName}</span>}
                      </>
                    }
                    end={
                      <span className="deck-row-end">
                        {/* What you own in here, not what the list would cost to build. */}
                        {ownText && (
                          <span
                            className="badge badge-value"
                            title={
                              missText
                                ? `${ownText} owned · ${missText} more in cards you don't own`
                                : `${ownText} owned, all of it in your collection`
                            }
                          >
                            {ownText}
                          </span>
                        )}
                        <span onClick={swallow}>
                          <OptionsMenu
                            label={`${deck.name} options`}
                            actions={[
                              {
                                label: deck.emblem ? 'Change emblem' : 'Choose an emblem',
                                icon: 'emblem' as const,
                                onClick: () => setEmblemDeck(deck),
                              },
                              ...(isDeck
                                ? [
                                    {
                                      label: 'Move to folder',
                                      icon: 'folder' as const,
                                      onClick: () => setMovingDeck({ id: deck.id, name: deck.name, folderId: deck.folderId }),
                                    },
                                    deck.archivedAt
                                      ? {
                                          label: 'Restore from archive',
                                          icon: 'refresh' as const,
                                          onClick: () => void restoreDeck(deck),
                                        }
                                      : {
                                          label: 'Archive deck',
                                          icon: 'archive' as const,
                                          onClick: () => setArchivingDeck({ id: deck.id, name: deck.name, filed }),
                                        },
                                  ]
                                : []),
                              {
                                label: `Delete ${meta.noun}`,
                                icon: 'trash',
                                danger: true,
                                onClick: () => void removeDeck(deck),
                              },
                            ]}
                          />
                        </span>
                      </span>
                    }
                  />
                </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Below the deck list, not above it like the folder nav: the archive is
            where decks go to rest, so it shouldn't be the first thing between
            you and the decks you actually play. On a wide screen it tucks in
            under Folders in the sidebar (see the media query). */}
        {isDeck && (
          <div className="deck-col-archive">
            <h2 className="deck-folders-title">Archive</h2>
            <ul className="menu-list">
              <li>
                <div
                  className={[
                    'menu-item folder-item archive-item',
                    archivedCount === 0 ? 'archive-item-empty' : '',
                    archiveOpen ? 'folder-item-active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    className="folder-item-open"
                    // Dimmed and inert until there's something in it — an empty
                    // folder you can open just to be told it's empty is a dead end.
                    disabled={archivedCount === 0}
                    onClick={() => {
                      setShowAllDecks(false);
                      setOpenFolderId(ARCHIVE_ID);
                    }}
                  >
                    <span className="menu-icon" aria-hidden>
                      <Icon name="archive" />
                    </span>
                    <span className="deck-name">Archived</span>
                    <span className="badge">{archivedCount}</span>
                  </button>
                </div>
              </li>
            </ul>
            {archivedCount === 0 && (
              <p className="fine-print">Archiving a deck keeps its list after you take the cards out of it.</p>
            )}
          </div>
        )}

        {hasFolders && (
          <div className="deck-col-folders">
            <h2 className="deck-folders-title">Folders</h2>
            <ul className="menu-list">
              {folders!.map((folder) => (
                <li key={folder.id}>
                  {renamingFolderId === folder.id ? (
                    <div className="menu-item folder-item folder-item-editing">
                      <span className="menu-icon" aria-hidden>
                        <Icon name="folder" />
                      </span>
                      <input
                        className="search-input grow"
                        value={renameValue}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRenameFolder();
                          if (e.key === 'Escape') setRenamingFolderId(null);
                        }}
                        onBlur={() => void commitRenameFolder()}
                        aria-label={`Rename ${folder.name}`}
                      />
                    </div>
                  ) : (
                    <div
                      className={
                        folder.id === openFolderId ? 'menu-item folder-item folder-item-active' : 'menu-item folder-item'
                      }
                    >
                      <button
                        className="folder-item-open"
                        onClick={() => {
                          setShowAllDecks(false);
                          setOpenFolderId(folder.id);
                        }}
                      >
                        <span className="menu-icon" aria-hidden>
                          <Icon name="folder" />
                        </span>
                        <span className="deck-name">{folder.name}</span>
                        <span className="badge">{tally?.counts.get(folder.id) ?? 0}</span>
                      </button>
                      <OptionsMenu
                        label={`${folder.name} options`}
                        actions={[
                          { label: 'Rename', icon: 'edit', onClick: () => startRenameFolder(folder) },
                          { label: 'Delete folder', icon: 'trash', danger: true, onClick: () => void removeFolder(folder) },
                        ]}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {emblemDeck && (
        <EmblemPickerSheet
          emblem={emblemDeck.emblem}
          kind={kind}
          name={emblemDeck.name}
          onSave={(next) => void setDeckEmblem(emblemDeck.id, next)}
          onClose={() => setEmblemDeck(null)}
        />
      )}
      {movingDeck && (
        <DeckFolderPickerSheet
          deckName={movingDeck.name}
          currentFolderId={movingDeck.folderId}
          onClose={() => setMovingDeck(null)}
          onPick={(folderId) => {
            void setDeckFolder(movingDeck.id, folderId);
            setMovingDeck(null);
          }}
        />
      )}
      {archivingDeck && (
        <ArchiveDeckSheet
          deckName={archivingDeck.name}
          filedCopies={archivingDeck.filed}
          onArchive={(unfile) => void archiveDeck(unfile)}
          onClose={() => setArchivingDeck(null)}
        />
      )}
      {confirmSheet}
    </Page>
  );
}
