import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { holdsCopy, MAX_DECK_NAME_LENGTH, isMarkerCard, type ContainerKind, type OracleCard, type Priced } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds, deckWishlistCandidates, type MissingCard } from '../db/queries.js';
import {
  deleteDeck,
  renameDeck,
  setContainerForTrade,
  setDeckArchived,
  setDeckEmblem,
  setDeckFormat,
  tidyDeckBoards,
  unfileWholeContainer,
} from '../db/dataAccess.js';
import { checkDeckLegality, pairButtonLabel, type LegalityReport } from '../deck/legality.js';
import { useOpenPairSearch, useOpenSearch } from '../search/searchContext.js';
import { DeckSummary, StorageSummary } from '../components/ContainerSummary.js';
import { CONTAINER_META, containerKind, deleteContainerConfirm } from '../deck/containers.js';
import { useFiling } from '../deck/useFiling.js';
import { shareDeckLink } from '../deck/share.js';
import { payloadText } from '../deck/cardClipboard.js';
import { useCutSlots } from '../deck/useCardClipboard.js';
import { isFavoriteDeck } from '../account/ownProfile.js';
import { useAccount } from '../account/useAccount.js';
import { downloadText } from '../import/export.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { useToast } from '../components/Toast.js';
import { CardSheet } from '../components/CardSheet.js';
import { StackToggle, ViewToggle, useStackPrintings, useViewMode } from '../components/CardViews.js';
import { ContainerBoard, EMPTY_ISSUES, type BoardSelection } from '../components/ContainerBoard.js';
import { useSetTypes } from '../cardDb/useSetTypes.js';
import { usePrefs } from '../usePrefs.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { containerValue, HeaderValue, missingValue, valueText } from '../components/ValueSummary.js';
import { ContainerValueChartSheet } from '../components/ChartSheetsLazy.js';
import { deckManaStats } from '../deck/manaStats.js';
import { SortControls, pricedForFinish, useCardSort } from '../components/CardSorting.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { Emblem } from '../components/Emblem.js';
import { EmblemPickerSheet } from '../components/EmblemPickerSheet.js';
import { AssembleSheet, type AssembleItem } from '../components/AssembleSheet.js';
import { ScanSheet } from '../components/ScanSheetLazy.js';
import { CardDropZone } from '../components/CardDropZone.js';
import { DeckHistory, HISTORY_ANCHOR } from '../components/DeckHistory.js';
import { SelectionBar } from '../components/BulkActionBar.js';
import { ArchiveDeckSheet } from '../components/ArchiveDeckSheet.js';
import { useMultiSelect } from '../components/useMultiSelect.js';
import { SelectToggle } from '../components/SelectToggle.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { Icon } from '../components/icons.js';
import { useUndoShortcut } from '../history/useUndoShortcut.js';
import { CardCursorProvider } from '../components/useCardCursor.js';
import { BackLink } from '../components/BackLink.js';
import { plural } from '../util/format.js';
import { sumQty } from '../util/groupBy.js';
import { clipSlot, groupSlots, sortRows, type EditTarget, type Row, type SlotRow, type SlotStack, type StackCtx } from './container/rows.js';
import { ContainerImport } from './container/ContainerImport.js';
import { MissingWishSheet } from './container/MissingWishSheet.js';
import { TokenSuggestions } from './container/TokenSuggestions.js';
import { useContainerBulkActions } from './container/useContainerBulkActions.js';
import { CursorCardKeys, useContainerClipboard } from './container/useContainerClipboard.js';
import { Loading } from '../components/Loading.js';

/**
 * The one sheet a container page has open over it, if any. The import panel
 * and the history panel stay out of it: they sit inline in the page, and
 * tapping a card while either is open shouldn't throw away what's in them.
 */
type PageSheet =
  | { kind: 'scan'; mode: 'add' | 'rescan' }
  // The "add what's missing to your wishlist" sheet. It shows up on the way out
  // of a deck (`leaving`), and on demand from the options menu.
  | { kind: 'wish'; cards: MissingCard[]; leaving: boolean }
  | { kind: 'emblem' }
  | { kind: 'valueChart' }
  // See ArchiveDeckSheet for why "and take the cards out?" is a question
  // rather than part of the action.
  | { kind: 'archive' }
  // The "assemble from my collection" walkthrough, frozen at the moment it opens.
  | { kind: 'assemble'; items: AssembleItem[] }
  | { kind: 'card'; target: EditTarget };

const NO_ROWS: Row[] = [];

/**
 * One deck, binder or box. The same screen for all three (they're the same
 * stored row — see deck/containers.ts): a binder or box simply has no format, no
 * legality panel, no sideboard or command zone, and swaps deck-brewing actions
 * for storage ones ("mark everything in here for trade").
 */
export function ContainerDetail({ kind }: { kind: ContainerKind }) {
  // The provider sits above the page so the page's own hooks run inside it.
  return (
    <CardCursorProvider>
      <ContainerPage kind={kind} />
    </CardCursorProvider>
  );
}

function ContainerPage({ kind }: { kind: ContainerKind }) {
  const { id = '' } = useParams();
  useUndoShortcut({ kind: 'container', id });
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const account = useAccount();
  const [sheet, setSheet] = useState<PageSheet | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const openCard = useCallback((target: EditTarget) => setSheet({ kind: 'card', target }), []);
  // The inline import panel. `text` is a pasted decklist, handed over so the
  // panel can go straight to the review rather than making you paste again.
  const [importing, setImporting] = useState<{ text: string | null } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [view, setView] = useViewMode();
  // Stack printings: two slots of one card (a Beta Bolt and an M10 one) read
  // as one tile. Same switch the collection reads.
  const [stacking, setStacking] = useStackPrintings();
  const prefs = usePrefs();
  const setTypes = useSetTypes(stacking);
  const stackCtx = useMemo<StackCtx>(() => (stacking ? { prefs, setTypes } : null), [stacking, prefs, setTypes]);
  const [sort, setSort] = useCardSort('deck', { group: 'type' });
  const sel = useMultiSelect();
  const placements = usePlacementIndex();
  const { file, sheet: filingSheet } = useFiling();
  const { confirm, sheet: confirmSheet } = useConfirm();
  const openPairSearch = useOpenPairSearch();
  const openSearch = useOpenSearch();
  const cutIds = useCutSlots(id);

  const ownership = useOwnershipIndex();
  const slotData = useLiveQuery(async () => {
    const deck = await db.decks.get(id);
    if (!deck) return { deck: null, rows: [] as SlotRow[], suggestedTokens: [] as Priced<OracleCard>[] };
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    const [oracleMap, printMap] = await Promise.all([
      getOracleCardsByIds(cards.map((c) => c.oracleId)),
      getPrintingsByIds(cards.map((c) => c.scryfallId).filter((s): s is string => !!s)),
    ]);
    // Spread the slot rather than copying it field by field: a field added to
    // DeckCard reaches the rows (and the card sheet behind them) on its own.
    const rows: SlotRow[] = cards.map((c) => ({
      ...c,
      oracle: oracleMap.get(c.oracleId),
      printing: c.scryfallId ? printMap.get(c.scryfallId) : undefined,
    }));
    // Tokens the deck's own cards create and marker cards they reference, minus
    // whatever's already sitting in the token board — the "you'll need these"
    // suggestions. Tokens sort first; markers are the rarer ask.
    const haveToken = new Set(rows.filter((r) => r.board === 'token').map((r) => r.oracleId));
    const neededTokenIds = new Set<string>();
    for (const r of rows) {
      if (r.board === 'token') continue;
      for (const t of r.oracle?.tokenOracleIds ?? []) {
        if (!haveToken.has(t)) neededTokenIds.add(t);
      }
    }
    const suggestedMap = neededTokenIds.size ? await getOracleCardsByIds(neededTokenIds) : new Map<string, Priced<OracleCard>>();
    const suggestedTokens = [...suggestedMap.values()].sort((a, b) => {
      const rank = (c: OracleCard) => (isMarkerCard(c.name, c.typeLine) ? 1 : 0);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
    return { deck, rows, suggestedTokens };
  }, [id]);
  // Owned counts come off the shared ownership index rather than a collection
  // read of our own, so a collection edit doesn't re-run the slot join. Held
  // back until the index is built, or every tile would flash "missing" first.
  const data = useMemo(
    () =>
      slotData && ownership
        ? { ...slotData, rows: slotData.rows.map((r): Row => ({ ...r, owned: ownership.lookup(r.oracleId).qty })) }
        : undefined,
    [slotData, ownership],
  );
  const rows = data?.rows ?? NO_ROWS;
  const meta = CONTAINER_META[kind];
  const isDeck = kind === 'deck';
  const isCommander = isDeck && (data?.deck?.format ?? 'casual') === 'commander';

  // Arriving straight from "Add deck"/"Add binder"/"Add box" (Containers.tsx):
  // the name field is the first thing worth typing into, so focus and select
  // its placeholder text ("Untitled deck") instead of making that a separate
  // click. The name input only exists once `data.deck` has loaded off the
  // liveQuery above (the first render or two show a loading/redirect state
  // instead), so this can't just run once on mount — it waits for the deck to
  // show up, then consumes the flag via a replace-navigation so navigating
  // back here later (browser back/forward) doesn't steal focus again.
  useEffect(() => {
    if (!data?.deck) return;
    if (!(location.state as { focusName?: boolean } | null)?.focusName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
    navigate(location.pathname, { replace: true, state: null });
  }, [data?.deck, location.state, location.pathname, navigate]);

  // A deck from before the Companion zone (or a sideboard an older build synced
  // into a Commander deck) gets its zones tidied for its format when it opens.
  const deckFormat = data?.deck?.format;
  const strayBoards = rows.some((r) => r.board === (deckFormat === 'commander' ? 'side' : 'companion'));
  useEffect(() => {
    if (strayBoards) void tidyDeckBoards(id);
  }, [id, deckFormat, strayBoards]);

  const summary = useMemo(() => {
    // Tokens never count toward "cards" — they're a separate, uncounted list —
    // and neither do the cards you're only considering.
    const counted = rows.filter((r) => r.board !== 'token' && r.board !== 'maybe');
    const byOracle = new Map<string, { need: number; owned: number }>();
    let need = 0;
    let have = 0;
    for (const r of counted) {
      // "Any printing" basics come out of the lands box, not the collection:
      // needed, and always had, without touching the owned counts.
      if (r.anyBasic) {
        need += r.quantity;
        have += r.quantity;
        continue;
      }
      const cur = byOracle.get(r.oracleId) ?? { need: 0, owned: r.owned };
      cur.need += r.quantity;
      byOracle.set(r.oracleId, cur);
    }
    byOracle.forEach((v) => {
      need += v.need;
      have += Math.min(v.owned, v.need);
    });
    return { need, have };
  }, [rows]);

  // Worth leads with the copies you own — the money actually sitting here — and
  // names the gap separately, rather than quoting a total you don't hold.
  const value = useMemo(() => {
    const counted = rows.filter((r) => r.board !== 'token' && r.board !== 'maybe');
    if (counted.length === 0) return undefined;
    // A slot that asks for a foil is worth the foil price.
    return containerValue(counted.map((r) => ({ ...r, printing: pricedForFinish(r.printing, r.finish ?? 'nonfoil') })));
  }, [rows]);
  const ownedWorth = valueText(value?.owned);
  const missingWorth = value && valueText(missingValue(value));

  const legality = useMemo<LegalityReport>(
    () =>
      checkDeckLegality(
        deckFormat,
        rows.map((r) => ({ oracleId: r.oracleId, quantity: r.quantity, board: r.board, oracle: r.oracle, chosenColor: r.chosenColor })),
      ),
    [rows, deckFormat],
  );

  // The mana arithmetic behind the stats line and its sheet. Deck-only: a binder
  // or box is a shelf, not a curve.
  const stats = useMemo(
    () => deckManaStats(rows.map((r) => ({ quantity: r.quantity, board: r.board, oracle: r.oracle })), deckFormat),
    [rows, deckFormat],
  );

  // Each board sorted once per change, not once per render: the boards are
  // memoized and only skip a render when these keep their identity.
  const boards = useMemo(() => {
    const of = (board: Row['board']) => sortRows(rows.filter((r) => r.board === board), sort);
    const commander = of('commander');
    const main = of('main');
    const side = of('side');
    const companion = of('companion');
    const maybe = of('maybe');
    const tokens = of('token');
    // Storage has one pile, sorted as a whole. Slots written before (or by an
    // import that guessed a sideboard) still show up in it.
    const storage = isDeck ? NO_ROWS : sortRows([...commander, ...companion, ...main, ...side, ...maybe], sort);
    return { commander, main, side, companion, maybe, tokens, storage };
  }, [rows, sort, isDeck]);

  // Each pile is grouped once and the same stacks feed both the selection keys
  // here and the tiles each board draws. Stacked, a tile's key is its lead
  // slot's id and ticking it means every slot under it, so each slot answers
  // to its lead. (Storage stacks across the whole pile; a deck stacks within
  // each board, same as the tiles are drawn.)
  const { stacks, leadIdOf } = useMemo(() => {
    const piles = isDeck
      ? [boards.commander, boards.companion, boards.main, boards.side, boards.maybe, boards.tokens]
      : [boards.storage];
    const stacks = new Map<Row[], SlotStack[]>(piles.map((p) => [p, groupSlots(p, stackCtx)]));
    const leadIdOf = new Map<string, string>();
    if (stackCtx) stacks.forEach((gs) => gs.forEach((g) => g.rows.forEach((r) => leadIdOf.set(r.id, g.lead.id))));
    return { stacks, leadIdOf };
  }, [boards, stackCtx, isDeck]);
  const stacksFor = (pile: Row[]) => stacks.get(pile) ?? [];
  const selectedRows = useMemo(
    () => rows.filter((r) => sel.selected.has(leadIdOf.get(r.id) ?? r.id)),
    [rows, sel.selected, leadIdOf],
  );
  const allKeys = useMemo(
    () => rows.filter((r) => (leadIdOf.get(r.id) ?? r.id) === r.id).map((r) => r.id),
    [rows, leadIdOf],
  );
  const selection = useMemo<BoardSelection>(
    () => ({ selectable: sel.active, selectedKeys: sel.selected, onToggleSelect: sel.toggle }),
    [sel.active, sel.selected, sel.toggle],
  );

  const cardKeys = useContainerClipboard({
    id,
    rows,
    selectedRows,
    allKeys,
    sel,
    isDeck,
    isCommander,
    noun: meta.noun,
    enabled: !!data?.deck,
    file,
    onPasteText: (text) => setImporting({ text }),
    onOpen: openCard,
  });

  const { bulkActions, sheets: bulkSheets } = useContainerBulkActions({
    id,
    deckName: data?.deck?.name ?? '',
    noun: meta.noun,
    isDeck,
    isCommander,
    commander: boards.commander,
    selectedRows,
    sel,
    placements,
    file,
    confirm,
  });

  // A solo commander with a pairing ability gets a shortcut to the other half:
  // search narrowed to legal pairs, identity waived.
  const solo = isCommander && boards.commander.length === 1 ? boards.commander[0]!.oracle : undefined;
  const pairLabel = solo && pairButtonLabel(solo);
  const pairFooter = useMemo(
    () =>
      solo && pairLabel ? (
        <button className="chip pair-find-btn" onClick={() => openPairSearch(solo)}>
          <Icon name="search" size={14} /> {pairLabel}
        </button>
      ) : undefined,
    [solo, pairLabel, openPairSearch],
  );

  if (data === undefined) return <Loading />;
  // A row is only reachable under its own kind's route, so a mismatch (an old
  // bookmark, a hand-typed hash) is a miss rather than the wrong screen.
  if (!data.deck || containerKind(data.deck) !== kind) {
    return <div className="page">{meta.Noun} not found.</div>;
  }
  const deck = data.deck;
  const { commander, main, side, companion, maybe, tokens } = boards;

  function goBack() {
    // Only a brewed deck has "cards I still need" — a binder or box holds what
    // you already own, so there's nothing to wishlist on the way out.
    const candidates = isDeck && ownership ? deckWishlistCandidates(rows, ownership) : [];
    if (candidates.length) setSheet({ kind: 'wish', cards: candidates, leaving: true });
    else navigate(meta.path);
  }

  /** Options menu: wishlist whatever this deck still needs, without leaving the page. */
  function wishlistMissing() {
    const candidates = ownership ? deckWishlistCandidates(rows, ownership) : [];
    if (candidates.length) setSheet({ kind: 'wish', cards: candidates, leaving: false });
    else toast(`Nothing missing: this ${meta.noun} is covered by your collection and wishlist`);
  }

  /** Storage action: put every card filed here on the tradelist, or take it off. */
  async function markAllForTrade(forTrade: boolean) {
    const n = await setContainerForTrade(id, forTrade);
    if (n === 0) {
      toast(forTrade ? 'Nothing here is in your collection to mark' : `Nothing in this ${meta.noun} was for trade`);
    } else {
      toast(`${forTrade ? 'Marked' : 'Unmarked'} ${n} ${plural(n, 'card')} for trade`);
    }
  }

  /**
   * Walk the list card by card, pointing each slot at a copy you actually own.
   * Only slots that still need one make the cut: a lands-box basic claims no
   * cardboard, a card you don't own can't be pulled off a shelf, and a slot
   * already backed by your copy is built. The list is frozen here so resolving a
   * card doesn't shuffle the ones behind it.
   */
  function startAssemble() {
    if (!placements) return;
    const todo: AssembleItem[] = [...commander, ...companion, ...main, ...side, ...maybe, ...tokens]
      .filter((r) => !r.anyBasic && r.owned > 0 && placements.allocated(r.id) < r.quantity)
      .map((r) => ({ slotId: r.id, oracleId: r.oracleId, name: r.oracle?.name ?? 'Card' }));
    if (todo.length === 0) {
      toast(`Every card here you own is already pointed at a copy`);
      return;
    }
    setSheet({ kind: 'assemble', items: todo });
  }

  function exportDeck() {
    // The boards in their sorted order, so the file reads like the page.
    const text = payloadText([...commander, ...main, ...side, ...tokens, ...companion, ...maybe].map(clipSlot));
    downloadText(`${deck.name.replace(/[^\w-]+/g, '_')}.txt`, text);
    toast(`Exported ${meta.noun}`);
  }

  /** Expand the history panel and scroll it into view (it renders below the cards). */
  function showHistory() {
    setHistoryOpen(true);
    requestAnimationFrame(() =>
      document.getElementById(HISTORY_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  /**
   * Put the deck away: it leaves the deck list for the Archived folder and keeps
   * everything it has, so the list you built survives being taken apart. The
   * cards are the separate question the sheet asks.
   */
  async function archiveDeck(unfile: boolean) {
    setSheet(null);
    const freed = unfile ? await unfileWholeContainer(id) : 0;
    await setDeckArchived(id, true);
    toast(
      freed > 0
        ? `Archived · ${freed} ${plural(freed, 'card')} back on the shelf`
        : 'Archived · find it under Archived in the deck list',
    );
    navigate(meta.path);
  }

  async function shareDeck() {
    const session = account.session;
    if (!session) return;
    // Only favorited decks resolve at a share link.
    if (!(await isFavoriteDeck(session, deck.id))) {
      toast('Favorite this deck on your profile to share it');
      return;
    }
    const result = await shareDeckLink({ username: session.username, deckId: deck.id, name: deck.name, format: deck.format });
    if (result === 'copied') toast('Share link copied');
    else if (result === 'failed') toast('Could not copy the link');
  }

  // What every board shares. Spread into each, so a board skips its render
  // when none of these (nor its own rows) changed.
  const boardProps = {
    deckId: id,
    view,
    issues: legality.issues,
    onEdit: openCard,
    ownership,
    placements,
    cutIds,
    selection,
    commanderDeck: isCommander,
    showYear: sort.key === 'released',
  };

  return (
    <section className="page">
      <div className="deck-head">
        <BackLink label={meta.Plural} onClick={goBack} />
        {/* The same readout the collection header carries, in the same empty
            space beside the options menu — and the same way in to the chart. */}
        <div className="deck-head-aside">
          {ownedWorth && (
            <HeaderValue
              label={missingWorth ? 'Owned value' : 'Value'}
              value={ownedWorth}
              onClick={() => setSheet({ kind: 'valueChart' })}
              title={`Open the ${meta.noun} value chart`}
            />
          )}
          <OptionsMenu
          label={`${meta.Noun} options`}
          actions={[
            // Three groups: the deck itself, bulk moves on the cards in it, and
            // the two ways out. Analysis leads; it's the one people come back for.
            ...(isDeck
              ? [{ label: 'Deck analysis', icon: 'chart' as const, onClick: () => navigate(`/decks/${id}/analysis`) }]
              : []),
            // Go and find the cardboard: the list card by card, each showing the
            // copies you own, so the slots end up pointing at real cards.
            {
              label: isDeck ? 'Assemble from my collection' : 'Fill from my collection',
              icon: 'collection',
              onClick: startAssemble,
            },
            { label: 'Scan cards', icon: 'camera', onClick: () => setSheet({ kind: 'scan', mode: 'add' }) },
            { label: `Re-scan ${meta.noun}`, icon: 'refresh', onClick: () => setSheet({ kind: 'scan', mode: 'rescan' }) },
            { label: 'Import list', icon: 'import', onClick: () => setImporting((v) => (v ? null : { text: null })) },
            { label: 'Export', icon: 'export', onClick: exportDeck },
            ...(isDeck && account.enabled && account.session
              ? [{ label: 'Share deck', icon: 'share' as const, onClick: () => void shareDeck() }]
              : []),
            {
              label: deck.emblem ? 'Change emblem' : 'Choose an emblem',
              icon: 'emblem',
              onClick: () => setSheet({ kind: 'emblem' }),
            },
            // The panel lives at the very bottom, under however many cards are
            // filed here, so the menu opens it *and* takes you to it.
            { label: 'History', icon: 'history', onClick: showHistory },
            // Only a brewed deck has cards you don't have yet; a binder or box is
            // a record of what's already on your shelf.
            ...(isDeck
              ? [{ label: 'Add missing cards to wishlist', icon: 'wishlist' as const, divider: true, onClick: wishlistMissing }]
              : []),
            // Whether it's a box you're emptying or a deck you're breaking up,
            // "everything in here is up for grabs" is one tap — it only ever
            // touches copies you actually own.
            { label: 'Add all owned cards to tradelist', icon: 'tradelist', divider: !isDeck, onClick: () => void markAllForTrade(true) },
            { label: 'Remove all owned cards from tradelist', icon: 'close', onClick: () => void markAllForTrade(false) },
            // Deck-only, and deliberately right above Delete: the two answers to
            // "I'm done with this deck", one of which keeps the list.
            ...(isDeck
              ? [
                  deck.archivedAt
                    ? {
                        label: 'Restore from archive',
                        icon: 'refresh' as const,
                        divider: true,
                        onClick: async () => {
                          await setDeckArchived(id, false);
                          toast('Restored to the deck list');
                        },
                      }
                    : { label: 'Archive deck', icon: 'archive' as const, divider: true, onClick: () => setSheet({ kind: 'archive' }) },
                ]
              : []),
            {
              label: `Delete ${meta.noun}`,
              icon: 'trash',
              danger: true,
              onClick: async () => {
                const ok = await confirm(deleteContainerConfirm(deck));
                if (!ok) return;
                await deleteDeck(id);
                toast(`Deleted “${deck.name}”`);
                navigate(meta.path);
              },
            },
          ]}
          />
        </div>
      </div>

      <div className="deck-name-row">
        {/* The emblem doubles as the way in to changing it — the same tap target
            the deck list gives, without hunting through the options menu. */}
        <button
          className="deck-emblem-btn"
          onClick={() => setSheet({ kind: 'emblem' })}
          title={deck.emblem ? 'Change emblem' : 'Choose an emblem'}
          aria-label={deck.emblem ? 'Change emblem' : 'Choose an emblem'}
        >
          <Emblem emblem={deck.emblem} kind={kind} size={32} />
        </button>
        <input
          ref={nameInputRef}
          className="deck-name-input"
          maxLength={MAX_DECK_NAME_LENGTH}
          value={nameDraft ?? deck.name}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft !== null && nameDraft !== deck.name) void renameDeck(id, nameDraft);
            setNameDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur(); // commits via onBlur
            else if (e.key === 'Escape') setNameDraft(null); // discard edits
          }}
          aria-label={`${meta.Noun} name`}
        />
        {/* Otherwise an archived deck looks exactly like a live one from in here,
            and you'd wonder why it isn't in the deck list. */}
        {deck.archivedAt && <span className="badge deck-archived-badge">Archived</span>}
      </div>

      {isDeck ? (
        <DeckSummary
          format={deck.format ?? 'casual'}
          onFormat={(f) => void setDeckFormat(id, f)}
          legality={legality}
          counts={summary}
          missingWorth={missingWorth}
          stats={stats}
          onOpenMana={() => navigate(`/decks/${id}/analysis?tab=mana`)}
        />
      ) : (
        <StorageSummary counts={summary} missingWorth={missingWorth} />
      )}

      <div className="list-toolbar">
        {/* Search adds to whatever page it's opened on, so this is the header
            search box with a name on it: the only way in used to be a hint. */}
        <button className="select-toggle add-cards-btn" onClick={openSearch}>
          <Icon name="plus" size={15} /> Add cards
        </button>
        {/* Nothing to select, sort or lay out until the first card lands. */}
        {rows.length > 0 && (
          <>
            {!sel.active && <SelectToggle onEnter={sel.enter} />}
            <SortControls prefs={sort} onChange={setSort} groups tagGroups withRelease />
            <StackToggle on={stacking} onChange={setStacking} />
            <ViewToggle mode={view} onChange={setView} />
          </>
        )}
      </div>

      <CursorCardKeys keys={cardKeys} />

      {importing && (
        <ContainerImport
          key={importing.text ?? 'manual'}
          deckId={id}
          slots={rows}
          noun={meta.noun}
          basicsAnyPrinting={isDeck}
          {...(importing.text ? { initialText: importing.text } : {})}
          onDone={(added) => {
            setImporting(null);
            if (added > 0) toast(`Added ${added} cards to the ${meta.noun}`);
          }}
        />
      )}

      {isDeck ? (
        <>
          {(isCommander || commander.length > 0) && (
            <ContainerBoard
              {...boardProps}
              title="Commander"
              rows={commander}
              stacks={stacksFor(commander)}
              group="none"
              emptyHint="No commander yet. Tap a card below and set its zone, or use the +Cmdr button in search."
              colorChoice={isCommander}
              footer={pairFooter}
            />
          )}
          {companion.length > 0 && (
            <ContainerBoard {...boardProps} title="Companion" rows={companion} stacks={stacksFor(companion)} group="none" />
          )}
          <ContainerBoard {...boardProps} title="Mainboard" rows={main} stacks={stacksFor(main)} group={sort.group} />
          <ContainerBoard {...boardProps} title="Sideboard" rows={side} stacks={stacksFor(side)} group={sort.group} />
          {/* Not part of the deck: no count, no legality, nothing it "needs". */}
          <ContainerBoard
            {...boardProps}
            title="Considering"
            rows={maybe}
            stacks={stacksFor(maybe)}
            group={sort.group}
            issues={EMPTY_ISSUES}
            emptyHint="Cards you might play. They don't count toward the deck. Use +Maybe in search, or move cards here from their zone."
          />
          {tokens.length > 0 && (
            <ContainerBoard {...boardProps} title="Tokens" rows={tokens} stacks={stacksFor(tokens)} group="none" />
          )}
          {data.suggestedTokens.length > 0 && (
            <TokenSuggestions deckId={id} view={view} tokens={data.suggestedTokens} />
          )}
        </>
      ) : (
        <ContainerBoard
          {...boardProps}
          title="Cards"
          rows={boards.storage}
          stacks={stacksFor(boards.storage)}
          group={sort.group}
          commanderDeck={false}
          emptyHint={`Nothing filed here yet. Tap Add cards, scan a stack, or select cards in your collection and file them into this ${meta.noun}.`}
        />
      )}

      <SelectionBar sel={sel} keys={allKeys} count={selectedRows.length} actions={bulkActions} />
      {bulkSheets}
      {filingSheet}
      {confirmSheet}

      <DeckHistory deckId={id} kind={kind} open={historyOpen} onToggle={() => setHistoryOpen((v) => !v)} />

      {sheet?.kind === 'emblem' && (
        <EmblemPickerSheet
          emblem={deck.emblem}
          kind={kind}
          name={deck.name}
          onSave={(next) => void setDeckEmblem(id, next)}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'archive' && (
        <ArchiveDeckSheet
          deckName={deck.name}
          filedCopies={sumQty(rows.filter(holdsCopy))}
          onArchive={(unfile) => void archiveDeck(unfile)}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'assemble' && <AssembleSheet containerId={id} kind={kind} items={sheet.items} onClose={closeSheet} />}
      {sheet?.kind === 'valueChart' && (
        <ContainerValueChartSheet deckId={id} name={deck.name} kind={kind} onClose={closeSheet} />
      )}
      {sheet?.kind === 'card' && (
        <CardSheet
          mode="deck"
          oracleCard={sheet.target.card}
          deckCard={{ ...sheet.target.deckCard, containerKind: kind }}
          slots={sheet.target.slots?.map((s) => ({ ...s, containerKind: kind }))}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'scan' && (
        <ScanSheet
          target={{
            kind: 'deck',
            deckId: id,
            deckName: deck.name,
            containerKind: kind,
            format: deck.format,
            rescan: sheet.mode === 'rescan',
          }}
          onClose={closeSheet}
        />
      )}
      <CardDropZone
        target={
          sheet?.kind === 'scan'
            ? null
            : { kind: 'deck', deckId: id, deckName: deck.name, containerKind: kind, format: deck.format }
        }
      />
      {sheet?.kind === 'wish' && (
        <MissingWishSheet
          cards={sheet.cards}
          deckName={deck.name}
          leaving={sheet.leaving}
          onDone={() => (sheet.leaving ? navigate(meta.path) : setSheet(null))}
        />
      )}
    </section>
  );
}
