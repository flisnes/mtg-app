import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import {
  CONTAINER_KINDS,
  DECK_FORMATS,
  normalizeColors,
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
  setDeckEmblem,
  setDeckFolder,
} from '../db/dataAccess.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { formatLabel } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { Icon } from '../components/icons.js';
import { Emblem } from '../components/Emblem.js';
import { EmblemPickerSheet } from '../components/EmblemPickerSheet.js';
import { ManaCost } from '../components/ManaCost.js';
import { HeaderValue, missingValue, useContainersValue, valueText, type ContainerValue } from '../components/ValueSummary.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { DeckFolderPickerSheet } from '../components/DeckFolderPickerSheet.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { convertToDisplay } from '../price/rates.js';
import { COLOR_NAMES } from '../components/CardSorting.js';

// Canonical WUBRG order for pip display.
const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

/** Share of a container's coloured cards a colour needs before it earns a pip. */
const DOMINANT_SHARE = 0.1;

/**
 * Colours that actually characterise a binder or box, weighted by copies.
 *
 * Not the colour-identity union a deck gets: identity counts every mana symbol
 * on the card (Ana Battlemage is a green creature with a {U}{B} kicker), so
 * four strays in an 800-card box lit up all five pips and a shelf of sorted
 * boxes all looked the same. Printed colours, and only the ones pulling their
 * weight. Colourless cards and lands abstain rather than voting for nothing —
 * a box with no coloured cards falls back to {C}.
 */
function dominantColors(
  cards: { oracleId: string; quantity: number }[],
  oracles: Map<string, { colors: Color[] }>,
): Color[] {
  const tally = new Map<Color, number>();
  let colored = 0;
  for (const card of cards) {
    const cardColors = normalizeColors(oracles.get(card.oracleId)?.colors);
    if (cardColors.length === 0) continue;
    colored += card.quantity;
    for (const c of cardColors) tally.set(c, (tally.get(c) ?? 0) + card.quantity);
  }
  // A multicolour card votes in every one of its colours, so the leading colour
  // always clears 1/5 of the pile: this never comes back empty.
  return COLOR_ORDER.filter((c) => (tally.get(c) ?? 0) >= colored * DOMINANT_SHARE);
}

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

  // How many decks sit in each folder — a cheap separate query (no card
  // lookups) so opening the sidebar doesn't pay for the detailed `rows` query
  // below across every deck, only the ones actually in view.
  const folderCounts = useLiveQuery(async () => {
    if (!isDeck) return new Map<string, number>();
    const decks = await db.decks.toArray();
    const counts = new Map<string, number>();
    for (const d of decks) {
      if (containerKind(d) !== 'deck' || !d.folderId) continue;
      counts.set(d.folderId, (counts.get(d.folderId) ?? 0) + 1);
    }
    return counts;
  }, [isDeck]);

  const rows = useLiveQuery(async () => {
    const list = (await db.decks.orderBy('updatedAt').reverse().toArray()).filter((d) => {
      if (containerKind(d) !== kind) return false;
      if (!isDeck || showAllDecks) return true;
      return openFolderId ? d.folderId === openFolderId : !d.folderId;
    });
    return Promise.all(
      list.map(async (deck) => {
        const cards = await db.deckCards.where('deckId').equals(deck.id).toArray();
        // Commander sits in the 100-card deck, so count it toward the mainboard.
        // Tokens never count toward the deck's size.
        const main = cards.filter((c) => c.board !== 'side' && c.board !== 'token').reduce((s, c) => s + c.quantity, 0);
        const side = cards.filter((c) => c.board === 'side').reduce((s, c) => s + c.quantity, 0);
        // A deck's colours are the union of every card's colour identity (for a
        // legal commander deck that collapses to the commander's identity). A
        // binder or box is hundreds of unrelated cards, where that union always
        // saturates to WUBRG — it gets the colours it's actually made of.
        const oracles = await getOracleCardsByIds(cards.map((c) => c.oracleId));
        let colors: Color[];
        if (isDeck) {
          // Tokens don't vote: a mono-white deck making a black-and-white cleric
          // is still mono-white.
          const present = new Set<Color>();
          for (const card of cards) {
            if (card.board === 'token') continue;
            for (const c of oracles.get(card.oracleId)?.colorIdentity ?? []) present.add(c);
          }
          colors = COLOR_ORDER.filter((c) => present.has(c));
        } else {
          colors = dominantColors(cards, oracles);
        }
        return { deck, main, side, colors };
      }),
    );
  }, [kind, openFolderId, showAllDecks]);

  const value = useContainersValue(kind);

  const visibleRows = useMemo(() => {
    if (!rows || !isDeck) return rows;
    const q = query.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter(({ deck }) => deck.name.toLowerCase().includes(q));
    if (filterFormat) out = out.filter(({ deck }) => (deck.format ?? 'casual') === filterFormat);
    if (filterColor) out = out.filter(({ colors }) => colors.includes(filterColor));
    if (sortKey === 'recent') return out;
    const mul = sortDir === 'desc' ? -1 : 1;
    return [...out].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'format') cmp = (a.deck.format ?? 'casual').localeCompare(b.deck.format ?? 'casual') * mul;
      else if (sortKey === 'color') cmp = colorSortKey(a.colors).localeCompare(colorSortKey(b.colors)) * mul;
      else if (sortKey === 'value') {
        cmp = (ownedValueNumber(value?.byId.get(a.deck.id)) - ownedValueNumber(value?.byId.get(b.deck.id))) * mul;
      }
      // Ties (and a plain name sort) fall back to name; direction only applies
      // when name IS the primary key, same as the card-list sort convention.
      if (cmp === 0) {
        cmp = a.deck.name.localeCompare(b.deck.name);
        if (sortKey === 'name') cmp *= mul;
      }
      return cmp;
    });
  }, [rows, isDeck, query, filterFormat, filterColor, sortKey, sortDir, value]);
  // Header leads with what the copies you actually hold are worth; the cards on
  // a list you don't own yet aren't money on your shelf.
  const ownedTotal = value ? (valueText(value.total.owned) ?? '—') : undefined;
  const missingTotal = value ? valueText(missingValue(value.total)) : undefined;

  async function create() {
    const id = await createContainer('', kind, 'casual', openFolderId ?? undefined);
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
      title={openFolder ? openFolder.name : meta.Plural}
      subtitle={openFolder ? 'Decks in this folder.' : meta.subtitle}
      aside={
        <HeaderValue
          label="Owned value"
          value={ownedTotal}
          note={missingTotal && `+${missingTotal} not owned`}
        />
      }
    >
      {openFolder && (
        <button className="linklike folder-crumb" onClick={() => setOpenFolderId(null)}>
          ‹ Up a level
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
          <select value={filterFormat} onChange={(e) => setFilterFormat(e.target.value as DeckFormat | '')} aria-label="Filter by format">
            <option value="">Any format</option>
            {DECK_FORMATS.map((f) => (
              <option key={f} value={f}>
                {formatLabel(f)}
              </option>
            ))}
          </select>
          <select value={filterColor} onChange={(e) => setFilterColor(e.target.value as Color | '')} aria-label="Filter by color">
            <option value="">Any color</option>
            {COLOR_ORDER.map((c) => (
              <option key={c} value={c}>
                {COLOR_NAMES[c]}
              </option>
            ))}
          </select>
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
            <p className="search-meta">Loading…</p>
          ) : visibleRows.length === 0 ? (
            <div className="empty-state">
              {rows && rows.length > 0 ? (
                <p>No decks match your filters.</p>
              ) : (
                <>
                  <p>
                    {openFolder ? `No decks in “${openFolder.name}” yet.` : `No ${meta.Plural.toLowerCase()} yet.`}
                  </p>
                  <p className="empty-phase">
                    {isDeck
                      ? `Tap “Add deck” above to make one.`
                      : `Tap “Add ${meta.noun}” above, then file cards into it from your collection.`}
                  </p>
                </>
              )}
            </div>
          ) : (
            <ul className="menu-list">
              {visibleRows.map(({ deck, main, side, colors }) => {
                const own = value?.byId.get(deck.id);
                const ownText = own && valueText(own.owned);
                const missText = own && valueText(missingValue(own));
                const folderName = showAllDecks && deck.folderId ? folderNameById.get(deck.folderId) : undefined;
                return (
                <li key={deck.id}>
                  <Link className="menu-item" to={`${meta.path}/${deck.id}`}>
                    <span className="menu-icon" aria-hidden>
                      <Emblem emblem={deck.emblem} kind={kind} size={28} />
                    </span>
                    <span className="deck-line">
                      <span className="deck-name">{deck.name}</span>
                      <span className="deck-meta">
                        {isDeck && <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>}
                        <ManaCost
                          cost={colors.length > 0 ? colors.map((c) => `{${c}}`).join('') : '{C}'}
                          className="deck-colors"
                        />
                        {isDeck ? (
                          <span className="badge" title={`${main} mainboard · ${side} sideboard`}>
                            {main} / {side}
                          </span>
                        ) : (
                          <span className="badge" title={`${main} card${main === 1 ? '' : 's'} filed here`}>
                            {main} card{main === 1 ? '' : 's'}
                          </span>
                        )}
                        {/* What you own in here, not what the list would cost to build. */}
                        {ownText && (
                          <span
                            className="badge badge-value"
                            title={
                              missText
                                ? `${ownText} owned · ${missText} more in cards you don't own`
                                : `${ownText} owned — everything here is in your collection`
                            }
                          >
                            {ownText}
                          </span>
                        )}
                        {folderName && <span className="badge deck-folder-badge">{folderName}</span>}
                      </span>
                    </span>
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
                  </Link>
                </li>
                );
              })}
            </ul>
          )}
        </div>

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
                        <span className="badge">{folderCounts?.get(folder.id) ?? 0}</span>
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
      {confirmSheet}
    </Page>
  );
}
