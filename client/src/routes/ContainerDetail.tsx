import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  COLOR_NAME,
  holdsCopy,
  namesCopy,
  COLORS,
  MAX_DECK_NAME_LENGTH,
  isMarkerCard,
  type Color,
  type ContainerKind,
  type DeckBoard,
  type OracleCard,
  type Priced,
  type Printing,
  type SetTypeMap,
  type SlotShape,
} from '@mtg/shared';
import { db } from '../db/schema.js';
import {
  getOracleCardsByIds,
  getPrintingsByIds,
  deckWishlistCandidates,
  type MissingCard,
} from '../db/queries.js';
import {
  addDeckCard,
  addDeckCardsBulk,
  deleteDeck,
  moveDeckCardsBulk,
  moveDeckCardsToContainer,
  removeDeckCard,
  removeDeckCardsBulk,
  removeDeckCardsMatching,
  renameDeck,
  setContainerForTrade,
  setDeckCardChosenColor,
  setDeckCardQuantity,
  setDeckCardsForTrade,
  setDeckArchived,
  setDeckCardsUnfiled,
  setDeckEmblem,
  setDeckFormat,
  slotKey,
  tidyDeckBoards,
  unfileWholeContainer,
} from '../db/dataAccess.js';
import { addToWishlistBulk, applyImport } from '../db/dataAccess.js';
import {
  checkDeckLegality,
  isBasicLand,
  isNonDeckCard,
  needsColorChoice,
  pairButtonLabel,
  type LegalityReport,
} from '../deck/legality.js';
import { useOpenPairSearch, useOpenSearch } from '../search/searchContext.js';
import { DeckSummary, StorageSummary } from '../components/ContainerSummary.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { useFiling } from '../deck/useFiling.js';
import { buildDeckText } from '../deck/deckText.js';
import { shareDeckLink } from '../deck/share.js';
import { isFavoriteDeck } from '../account/ownProfile.js';
import { useAccount } from '../account/useAccount.js';
import { downloadText } from '../import/export.js';
import { ImportPanel } from '../import/ImportPanel.js';
import { OverlapChoice, applyOverlap, type OverlapMode } from '../import/ImportExtras.js';
import { UnownedPromptSheet, type UnownedCard } from '../components/UnownedPromptSheet.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import type { ResolvedLine } from '../import/types.js';
import { useToast } from '../components/Toast.js';
import { CardSheet } from '../components/CardSheet.js';
import { FINISH_LABELS } from '../components/copyTraits.js';
import { CardItems, StackToggle, ViewToggle, useStackPrintings, useViewMode, type CardItem, type ViewMode } from '../components/CardViews.js';
import { pickOwnedPrinting } from '../cardDb/preferredPrinting.js';
import { useDisplayPrintings } from '../cardDb/useDisplayPrintings.js';
import { useSetTypes } from '../cardDb/useSetTypes.js';
import { usePrefs } from '../usePrefs.js';
import type { Prefs } from '../prefs.js';
import { ownedBadge } from '../components/OwnedBadge.js';
import { langMark } from '../components/LangFlag.js';
import { yearMark } from '../components/cardRows.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { containerValue, HeaderValue, missingValue, valueText } from '../components/ValueSummary.js';
import { ContainerValueChartSheet } from '../components/ChartSheetsLazy.js';
import { deckManaStats } from '../deck/manaStats.js';
import {
  SortControls,
  groupCards,
  GroupCountBadge,
  extraLands,
  cardSortFields,
  pricedForFinish,
  sortCards,
  useCardSort,
  type CardSortPrefs,
  type GroupKey,
} from '../components/CardSorting.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { Emblem } from '../components/Emblem.js';
import { EmblemPickerSheet } from '../components/EmblemPickerSheet.js';
import { AssembleSheet, type AssembleItem } from '../components/AssembleSheet.js';
import { ScanSheet } from '../components/ScanSheetLazy.js';
import { CardDropZone } from '../components/CardDropZone.js';
import { Sheet } from '../components/Sheet.js';
import { DeckHistory, HISTORY_ANCHOR } from '../components/DeckHistory.js';
import { SelectionBar, type BulkAction } from '../components/BulkActionBar.js';
import { BOARD_LABEL, boardOptions, type BoardOption } from '../deck/boards.js';
import { ContainerPickerSheet } from '../components/ContainerPickerSheet.js';
import { ArchiveDeckSheet } from '../components/ArchiveDeckSheet.js';
import { TagSheet } from '../components/TagSheet.js';
import { useMultiSelect, type MultiSelect } from '../components/useMultiSelect.js';
import { useKeySet } from '../components/useKeySet.js';
import { SelectToggle } from '../components/SelectToggle.js';
import { usePlacementIndex, type PlacementIndex } from '../db/usePlacements.js';
import { Icon } from '../components/icons.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import { useUndoShortcut } from '../history/useUndoShortcut.js';
import { clearCut, type ClipboardPayload, type ClipboardSlot } from '../deck/cardClipboard.js';
import { useCardClipboard, useCutSlots, type ClipboardHandlers } from '../deck/useCardClipboard.js';
import { useShortcuts } from '../components/useShortcuts.js';
import { CardCursorProvider, useCardCursorCtx } from '../components/useCardCursor.js';
import { BackLink } from '../components/BackLink.js';
import { plural } from '../util/format.js';
import { groupBy, sumQty } from '../util/groupBy.js';

/** One slot of this container, joined to its card and what the collection holds.
 *  Everything the slot itself says comes from SlotShape. */
interface Row extends SlotShape {
  id: string;
  oracleId: string;
  quantity: number;
  board: DeckBoard;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
  owned: number;
}
/** A Row before the ownership index has counted its copies. */
type SlotRow = Omit<Row, 'owned'>;

/** What a card row hands the CardSheet to edit a deck slot (incl. commander context). */
interface DeckCardEdit extends SlotShape {
  id: string;
  quantity: number;
  board: DeckBoard;
  deckId: string;
  commanderDeck: boolean;
}

/** What a tile hands the sheet: the slot, and (stacked) the other slots of the same card. */
interface EditTarget {
  card: Priced<OracleCard>;
  deckCard: DeckCardEdit;
  slots?: DeckCardEdit[];
}

/**
 * Stack printings, deck edition: the slots of one card in one board folded
 * into one tile. The lead is the slot whose edition the tile wears (the
 * preferred one among the slots' printings), so the tile's key is a real slot
 * id and the cursor, the selection and the card keys keep working on it.
 */
interface SlotStack {
  lead: Row;
  rows: Row[];
  quantity: number;
}

/** Grouping context, or null when the list isn't stacking. */
type StackCtx = { prefs: Pick<Prefs, 'printing' | 'baseCurrency'>; setTypes: SetTypeMap | null } | null;

function groupSlots(rows: Row[], stack: StackCtx): SlotStack[] {
  if (!stack) return rows.map((r) => ({ lead: r, rows: [r], quantity: r.quantity }));
  const byOracle = groupBy(rows, (r) => r.oracleId);
  const out: SlotStack[] = [];
  byOracle.forEach((group) => {
    if (group.length === 1) {
      out.push({ lead: group[0]!, rows: group, quantity: group[0]!.quantity });
      return;
    }
    const printings = new Map<string, Priced<Printing>>();
    for (const r of group) if (r.printing) printings.set(r.printing.scryfallId, r.printing);
    const shown = pickOwnedPrinting([...printings.values()], stack.prefs, stack.setTypes);
    const lead = (shown && group.find((r) => r.scryfallId === shown.scryfallId)) ?? group[0]!;
    out.push({
      lead,
      rows: [lead, ...group.filter((r) => r !== lead)],
      quantity: sumQty(group),
    });
  });
  return out;
}

/** A slot's wants, spelled out for the row's sub-line ('' = it wants nothing special). */
function wantsDetail(r: Row): string {
  const bits: string[] = [];
  if (r.finish) bits.push(FINISH_LABELS[r.finish] ?? r.finish);
  if (r.condition) bits.push(`min ${r.condition}`);
  if (r.lang) bits.push(r.lang);
  return bits.join(' · ');
}


/**
 * Tokens are named tersely by Scryfall ("Plant", "Zombie") — this rebuilds the
 * fuller description players actually use ("0/1 Green Plant Creature Token"),
 * out of fields every card already carries. Non-creature tokens (Treasure,
 * Clue…) already have a self-describing name, so they just get " Token"
 * appended. Marker cards (Poison Counter, an emblem, Day // Night, Morph) are
 * not tokens at all and keep their printed name verbatim.
 */
function tokenLabel(o: {
  name: string;
  colors: Color[];
  typeLine: string;
  power?: string | null;
  toughness?: string | null;
}): string {
  if (isMarkerCard(o.name, o.typeLine)) return o.name;
  if (!/\bCreature\b/i.test(o.typeLine)) return `${o.name} Token`;
  const pt = o.power != null && o.toughness != null ? `${o.power}/${o.toughness} ` : '';
  const colorWord = o.colors.length ? `${o.colors.map((c) => COLOR_NAME[c]).join('/')} ` : '';
  return `${pt}${colorWord}${o.name} Creature Token`;
}

/**
 * One deck, binder or box. The same screen for all three (they're the same
 * stored row — see deck/containers.ts): a binder or box simply has no format, no
 * legality panel, no sideboard or command zone, and swaps deck-brewing actions
 * for storage ones ("mark everything in here for trade").
 */
export function ContainerDetail({ kind }: { kind: ContainerKind }) {
  const { id = '' } = useParams();
  useUndoShortcut({ kind: 'container', id });
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const account = useAccount();
  const [showImport, setShowImport] = useState(false);
  // A pasted decklist: hands ContainerImport its text so it can go straight to the
  // review rather than making you paste again into its own box.
  const [pastedText, setPastedText] = useState<string | null>(null);
  const [scanning, setScanning] = useState<'add' | 'rescan' | null>(null);
  // The "add what's missing to your wishlist" sheet. It shows up on the way out
  // of a deck (`leaving`), and on demand from the ⋯ menu — same sheet, but asking
  // for it deliberately shouldn't also walk you off the page.
  const [wishSheet, setWishSheet] = useState<{ cards: MissingCard[]; leaving: boolean } | null>(null);
  const picked = useKeySet();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [emblemOpen, setEmblemOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [valueChartOpen, setValueChartOpen] = useState(false);
  const [view, setView] = useViewMode();
  // Stack printings: two slots of one card (a Beta Bolt and an M10 one) read
  // as one tile. Same switch the collection reads.
  const [stacking, setStacking] = useStackPrintings();
  const prefs = usePrefs();
  const setTypes = useSetTypes(stacking);
  const stackCtx: StackCtx = stacking ? { prefs, setTypes } : null;
  const [sort, setSort] = useCardSort('deck', { group: 'type' });
  const [info, setInfo] = useState<EditTarget | null>(null);
  const sel = useMultiSelect();
  // 'file' picks somewhere to *also* put the selection, 'unfile' picks somewhere
  // to take it out of — the two halves of sorting out a card promised twice.
  const [picking, setPicking] = useState<'file' | 'unfile' | null>(null);
  // Open the archive prompt; null when closed. See ArchiveDeckSheet for why
  // "and take the cards out?" is a question rather than part of the action.
  const [archiveOpen, setArchiveOpen] = useState(false);
  // The multi-select "Move to…" zone picker.
  const [moving, setMoving] = useState(false);
  // The multi-select "Tag…" sheet, frozen on the slots that were selected.
  const [tagging, setTagging] = useState<string[] | null>(null);
  // The "assemble from my collection" walkthrough, frozen at the moment it opens.
  const [assembling, setAssembling] = useState<AssembleItem[] | null>(null);
  const placements = usePlacementIndex();
  const { file, sheet: filingSheet } = useFiling();
  const { confirm, sheet: confirmSheet } = useConfirm();
  const action = useAsyncAction();
  const openPairSearch = useOpenPairSearch();
  const openSearch = useOpenSearch();

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
  const strayBoards = !!data?.rows.some((r) => r.board === (deckFormat === 'commander' ? 'side' : 'companion'));
  useEffect(() => {
    if (strayBoards) void tidyDeckBoards(id);
  }, [id, deckFormat, strayBoards]);

  const summary = useMemo(() => {
    // Tokens never count toward "cards" — they're a separate, uncounted list —
    // and neither do the cards you're only considering.
    const rows = (data?.rows ?? []).filter((r) => r.board !== 'token' && r.board !== 'maybe');
    const byOracle = new Map<string, { need: number; owned: number }>();
    let need = 0;
    let have = 0;
    for (const r of rows) {
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
  }, [data]);

  // Worth leads with the copies you own — the money actually sitting here — and
  // names the gap separately, rather than quoting a total you don't hold.
  const value = useMemo(() => {
    const rows = (data?.rows ?? []).filter((r) => r.board !== 'token' && r.board !== 'maybe');
    if (rows.length === 0) return undefined;
    // A slot that asks for a foil is worth the foil price.
    return containerValue(rows.map((r) => ({ ...r, printing: pricedForFinish(r.printing, r.finish ?? 'nonfoil') })));
  }, [data]);
  const ownedWorth = valueText(value?.owned);
  const missingWorth = value && valueText(missingValue(value));

  const legality = useMemo<LegalityReport>(
    () =>
      checkDeckLegality(
        data?.deck?.format,
        (data?.rows ?? []).map((r) => ({ oracleId: r.oracleId, quantity: r.quantity, board: r.board, oracle: r.oracle, chosenColor: r.chosenColor })),
      ),
    [data],
  );

  // The mana arithmetic behind the stats line and its sheet. Deck-only: a binder
  // or box is a shelf, not a curve.
  const stats = useMemo(
    () => deckManaStats((data?.rows ?? []).map((r) => ({ quantity: r.quantity, board: r.board, oracle: r.oracle })), data?.deck?.format),
    [data],
  );

  const meta = CONTAINER_META[kind];
  const isDeck = kind === 'deck';

  if (data === undefined) return <div className="page">Loading…</div>;
  // A row is only reachable under its own kind's route, so a mismatch (an old
  // bookmark, a hand-typed hash) is a miss rather than the wrong screen.
  if (!data.deck || containerKind(data.deck) !== kind) {
    return <div className="page">{meta.Noun} not found.</div>;
  }
  const deck = data.deck;
  const isCommander = isDeck && (deck.format ?? 'casual') === 'commander';
  const commander = sortRows(data.rows.filter((r) => r.board === 'commander'), sort);
  const main = sortRows(data.rows.filter((r) => r.board === 'main'), sort);
  const side = sortRows(data.rows.filter((r) => r.board === 'side'), sort);
  const companion = sortRows(data.rows.filter((r) => r.board === 'companion'), sort);
  const maybe = sortRows(data.rows.filter((r) => r.board === 'maybe'), sort);
  const tokens = sortRows(data.rows.filter((r) => r.board === 'token'), sort);

  async function goBack() {
    // Only a brewed deck has "cards I still need" — a binder or box holds what
    // you already own, so there's nothing to wishlist on the way out.
    const candidates = isDeck && ownership ? deckWishlistCandidates(data!.rows, ownership) : [];
    if (candidates.length) openWishSheet(candidates, true);
    else navigate(meta.path);
  }

  function openWishSheet(candidates: MissingCard[], leaving: boolean) {
    setWishSheet({ cards: candidates, leaving });
    picked.reset(candidates.map((c) => c.oracleId)); // all ticked by default
  }

  /** ⋯ menu: wishlist whatever this deck still needs, without leaving the page. */
  async function wishlistMissing() {
    const candidates = ownership ? deckWishlistCandidates(data!.rows, ownership) : [];
    if (candidates.length) openWishSheet(candidates, false);
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
    setAssembling(todo);
  }

  // ---- Multi-select ----------------------------------------------------
  // Selection is keyed by slot id, so it spans every board: pick a commander
  // and three sideboard cards and one action covers the lot.
  // Stacked, a tile's key is its lead slot's id and ticking it means every
  // slot under it, so each slot answers to its lead. (Storage stacks across the
  // whole pile; a deck stacks within each board, same as the tiles are drawn.)
  // Storage has one pile, sorted as a whole.
  const storagePile = isDeck ? [] : sortRows([...commander, ...companion, ...main, ...side, ...maybe], sort);
  // Each pile is grouped once per render and the same stacks feed both the
  // selection keys here and the tiles each Board draws.
  const stackCache = new Map<Row[], SlotStack[]>();
  const stacksFor = (pile: Row[]) => {
    let out = stackCache.get(pile);
    if (!out) stackCache.set(pile, (out = groupSlots(pile, stackCtx)));
    return out;
  };
  const leadIdOf = new Map<string, string>();
  if (stackCtx) {
    const piles = isDeck ? [commander, companion, main, side, maybe, tokens] : [storagePile];
    for (const pile of piles) for (const g of stacksFor(pile)) for (const r of g.rows) leadIdOf.set(r.id, g.lead.id);
  }
  const selectedRows = data.rows.filter((r) => sel.selected.has(leadIdOf.get(r.id) ?? r.id));
  const allKeys = data.rows.filter((r) => (leadIdOf.get(r.id) ?? r.id) === r.id).map((r) => r.id);
  const selectedCopies = sumQty(selectedRows);

  // ---- Clipboard -------------------------------------------------------
  // Copy takes the selection, or the whole container when nothing is picked —
  // "Ctrl+C on a deck" meaning "give me the decklist" is the reading everyone
  // arrives with. Cut insists on a selection: cutting an entire deck by
  // reflex is not a thing anyone meant to do.
  const clipSlot = (r: Row): ClipboardSlot => ({
    oracleId: r.oracleId,
    name: r.oracle?.name ?? '(unknown card)',
    quantity: r.quantity,
    board: r.board,
    ...(r.scryfallId ? { scryfallId: r.scryfallId } : {}),
    ...(r.anyBasic ? { anyBasic: true } : {}),
    ...(r.finish ? { finish: r.finish } : {}),
    ...(r.condition ? { condition: r.condition } : {}),
    ...(r.lang ? { lang: r.lang } : {}),
    ...(r.tags?.length ? { tags: r.tags } : {}),
  });

  /** Where a pasted card lands. The zone it came from is kept when this
   *  container has one to offer, and quietly corrected when it doesn't. */
  const pasteBoard = (board: DeckBoard, oracle: OracleCard | undefined): DeckBoard => {
    if (!isDeck) return 'main';
    if (oracle && isNonDeckCard(oracle)) return 'token';
    if (board === 'commander' && !isCommander) return 'main';
    return board;
  };

  async function pastePayload(payload: ClipboardPayload) {
    const oracles = await getOracleCardsByIds(payload.slots.map((s) => s.oracleId));
    const boardOf = new Map(payload.slots.map((s) => [s.oracleId, pasteBoard(s.board, oracles.get(s.oracleId))]));
    const cut = payload.cut;
    if (cut) {
      // The removal the cut deferred, happening now. One batch across both
      // containers, so it reads as a move and undoes from either end.
      const moved = await moveDeckCardsToContainer(cut.slotIds, id, (slot) => boardOf.get(slot.oracleId) ?? 'main');
      clearCut();
      if (moved === 0) {
        toast('Those cards have already moved on');
        return;
      }
      toast(`Moved ${moved} ${plural(moved, 'card')} into this ${meta.noun}`);
      return;
    }
    // A copied slot that names a real copy of yours is that copy being filed
    // here too, so it takes the same road as "File away": capped at what you
    // own, and asked about when the copy is already promised elsewhere. Brew
    // lines and lands-box basics pass straight through, as they do everywhere.
    const filing = await file(
      id,
      payload.slots.map((s) => ({
        oracleId: s.oracleId,
        quantity: s.quantity,
        board: boardOf.get(s.oracleId) ?? 'main',
        ...(s.anyBasic ? { anyBasic: true } : { ...(s.scryfallId ? { scryfallId: s.scryfallId } : {}) }),
        ...(s.finish || s.condition || s.lang
          ? { wants: { ...(s.finish ? { finish: s.finish } : {}), ...(s.condition ? { condition: s.condition } : {}), ...(s.lang ? { lang: s.lang } : {}) } }
          : {}),
        label: oracles.get(s.oracleId)?.name,
      })),
      { source: 'manual' },
    );
    if (filing === null) return;
    const n = sumQty(payload.slots);
    toast(`Pasted ${n} ${plural(n, 'card')} into this ${meta.noun}`);
  }

  // These live in a child because ContainerDetail returns early while the
  // container is still loading, and hooks can't sit behind a return.
  const clipboard = {
    onCopy: () => {
      const rows = selectedRows.length > 0 ? selectedRows : data.rows;
      if (rows.length === 0) return null;
      const n = sumQty(rows);
      toast(`Copied ${n} ${plural(n, 'card')}`);
      return rows.map(clipSlot);
    },
    onCut: () => {
      if (selectedRows.length === 0) {
        toast('Select some cards first, then cut.');
        return null;
      }
      toast(`Cut ${selectedCopies} ${plural(selectedCopies, 'card')}. Paste them where they belong.`);
      sel.exit();
      return { slots: selectedRows.map(clipSlot), slotIds: selectedRows.map((r) => r.id), containerId: id };
    },
    onPastePayload: (payload: ClipboardPayload) => void action.run('paste the cards', () => pastePayload(payload)),
    onPasteText: (text: string) => {
      setPastedText(text);
      setShowImport(true);
    },
  };

  // What the card keys act on: whichever slot the cursor is pointing at.
  const cardAt = (key: string | null) => (key ? (data.rows.find((r) => r.id === key) ?? null) : null);

  const cardKeys = {
    /** Step a slot's copies. Down from one takes the slot out; Ctrl+Z is right
     *  there, which is what makes that safe to do on a keystroke. */
    step: (key: string | null, by: 1 | -1) => {
      const row = cardAt(key);
      if (!row) return;
      const next = row.quantity + by;
      void action.run('change the count', async () => {
        await setDeckCardQuantity(row.id, next);
        if (next <= 0) toast(`Removed ${row.oracle?.name ?? 'the card'}`);
      });
    },
    remove: (key: string | null) => {
      const row = cardAt(key);
      if (!row) return;
      void action.run('remove the card', async () => {
        await removeDeckCard(row.id);
        toast(`Removed ${row.oracle?.name ?? 'the card'}`);
      });
    },
    open: (key: string | null) => {
      const row = cardAt(key);
      if (row?.oracle) setInfo({ card: row.oracle, deckCard: { ...row, deckId: id, commanderDeck: isCommander } });
    },
    /** Tick the card for a bulk action, turning select mode on if it's off, so
     *  a selection can be built by pointing rather than by clicking sixty rows. */
    pick: (key: string | null) => {
      if (!cardAt(key) || !key) return;
      if (!sel.active) sel.enter();
      sel.toggle(key);
    },
  };

  // Ctrl+A means select all, every time. The bulk bar's own button is the
  // toggle; a key that silently deselects everything on the second press is how
  // you lose a selection you spent a minute building.
  const selectAll = allKeys.length
    ? () => {
        if (!sel.active) sel.enter();
        if (!sel.allSelected(allKeys)) sel.toggleAll(allKeys);
      }
    : null;

  // Which *other* containers hold the selection, and how much of it — the list
  // the "Unfile" picker offers, so resolving a double-promised card is two taps
  // rather than a hunt through every deck you own.
  // A slot's own wants narrow the list the same way they narrow the badges: the
  // deck holding your English copy isn't holding the Spanish one.
  const elsewhere = new Map<string, number>();
  for (const r of selectedRows) {
    const wants = { condition: r.condition, finish: r.finish, lang: r.lang };
    for (const p of placements?.lookup(r.oracleId, r.scryfallId, wants).places ?? []) {
      if (p.containerId === id) continue;
      elsewhere.set(p.containerId, (elsewhere.get(p.containerId) ?? 0) + 1);
    }
  }

  // Selected slots this container is holding cardboard for, and the ones it has
  // been emptied of — the two directions of "the card is (not) in the box".
  // Only a slot that names one physical copy can go either way; a brew line and
  // a lands-box basic never held anything (see DeckCard.unfiled).
  const filedHereRows = selectedRows.filter(holdsCopy);
  const unfiledRows = selectedRows.filter((r) => r.unfiled);

  async function bulkRemove() {
    const n = selectedRows.length;
    const ok = await confirm({
      title: `Remove ${n} ${plural(n, 'card')}?`,
      body: `${n === 1 ? 'It leaves' : 'They leave'} “${deck.name}”. Copies you own stay in your collection.`,
      confirmLabel: `Remove from ${meta.noun}`,
      danger: true,
    });
    if (!ok) return;
    const copies = await removeDeckCardsBulk(selectedRows.map((r) => r.id));
    toast(`Removed ${copies} ${plural(copies, 'card')} from the ${meta.noun}`);
    sel.exit();
  }

  /** Mark the selected cards' owned copies for trade (or take them back off). */
  async function bulkTrade(forTrade: boolean) {
    const n = await setDeckCardsForTrade(selectedRows.map((r) => r.id), forTrade);
    if (n === 0) {
      toast(forTrade ? 'None of those are in your collection to mark' : 'None of those were for trade');
    } else {
      toast(`${forTrade ? 'Marked' : 'Unmarked'} ${n} ${plural(n, 'card')} for trade`);
    }
    sel.exit();
  }

  /**
   * File the selection into another deck, binder or box. Same cardboard, new
   * home: the printing and traits travel with it rather than merging the foil
   * into the slot that happens to hold the nonfoil — and a copy that's already
   * filed elsewhere gets the move-or-both question.
   */
  async function bulkFile(containerId: string, targetKind: ContainerKind) {
    setPicking(null);
    const filing = await file(
      containerId,
      selectedRows.map((r) => ({
        oracleId: r.oracleId,
        quantity: r.quantity,
        board: 'main' as const,
        scryfallId: r.scryfallId,
        anyBasic: r.anyBasic,
        wants: { condition: r.condition, finish: r.finish, lang: r.lang },
        label: r.oracle?.name,
        sub: [r.printing?.setName, r.condition, r.finish, r.lang && r.lang !== 'en' ? r.lang : null]
          .filter(Boolean)
          .join(' · '),
      })),
    );
    if (filing === null) return;
    const noun = CONTAINER_META[targetKind].noun.toLowerCase();
    // What actually went in: the target never takes more of a copy than you own,
    // so a card it already holds adds nothing.
    const n = filing.filed;
    toast(
      n === 0
        ? `Already in that ${noun}`
        : filing.mode === 'move'
          ? `Moved ${n} ${plural(n, 'card')} to ${noun}`
          : `Added ${n} ${plural(n, 'card')} to ${noun}`,
    );
    sel.exit();
  }

  /**
   * Take the cards out of this container without editing the list: the slots
   * stay, still naming the copies they want, and hand the cardboard back — the
   * deck box you emptied into a trade binder. The green collection badge drops to
   * the double checkmark, and the copies are free for another deck.
   */
  async function unfileHere() {
    setPicking(null);
    const copies = await setDeckCardsUnfiled(filedHereRows.map((r) => r.id), true);
    toast(
      copies === 0
        ? `Nothing in this selection is filed here`
        : `Took ${copies} ${plural(copies, 'card')} out of the ${meta.noun} · the list is unchanged`,
    );
    sel.exit();
  }

  /** Put the cardboard back in — the other half of `unfileHere`. */
  async function refileHere() {
    const copies = await setDeckCardsUnfiled(unfiledRows.map((r) => r.id), false);
    toast(copies === 0 ? `Those are already filed here` : `Filed ${copies} ${plural(copies, 'card')} back here`);
    sel.exit();
  }

  /** Take the selection back out of another container (the conflict fix). */
  async function bulkUnfile(containerId: string, targetKind: ContainerKind) {
    if (containerId === id) return void unfileHere();
    setPicking(null);
    const removed = await removeDeckCardsMatching(
      containerId,
      selectedRows.map((r) => ({
        oracleId: r.oracleId,
        scryfallId: r.scryfallId,
        quantity: r.quantity,
        wants: { condition: r.condition, finish: r.finish, lang: r.lang },
      })),
    );
    toast(
      removed === 0
        ? `Nothing matched in that ${CONTAINER_META[targetKind].noun.toLowerCase()}`
        : `Removed ${removed} ${plural(removed, 'card')} from that ${CONTAINER_META[targetKind].noun.toLowerCase()}`,
    );
    sel.exit();
  }

  /**
   * Move the selection into another zone of this deck. A slot already in the
   * target zone is left alone, and one that meets its card there merges with it,
   * so moving the same cards twice is not a way to duplicate them.
   */
  async function bulkMove(board: DeckBoard) {
    setMoving(false);
    const copies = await moveDeckCardsBulk(selectedRows.map((r) => r.id), board);
    toast(
      copies === 0
        ? `Already in the ${BOARD_LABEL[board].toLowerCase()}`
        : `Moved ${copies} ${plural(copies, 'card')} to the ${BOARD_LABEL[board].toLowerCase()}`,
    );
    sel.exit();
  }

  // Which zones the selection may move to. Storage has no zones; the
  // command-zone check mustn't count a selected commander as its own partner;
  // and a selection that's all in one zone isn't offered that zone back.
  const sharedBoard = selectedRows.length > 0 && selectedRows.every((r) => r.board === selectedRows[0]!.board)
    ? selectedRows[0]!.board
    : undefined;
  const moveZones = isDeck
    ? boardOptions({
        cards: selectedRows.map((r) => r.oracle),
        commanderDeck: isCommander,
        commandZone: commander
          .filter((r) => !!r.oracle && !selectedRows.some((sr) => sr.oracleId === r.oracleId))
          .map((r) => r.oracle!),
      }).filter((z) => z.board !== sharedBoard)
    : [];

  // Most-used first: the bar shows the first two inline (BulkActionBar).
  const bulkActions: BulkAction[] = [
    ...(isDeck ? [{ label: 'Move to…', icon: 'moveTo' as const, onClick: () => setMoving(true) }] : []),
    { label: 'File away…', icon: 'decks', onClick: () => setPicking('file') },
    { label: 'Tag…', icon: 'tags', onClick: () => setTagging(selectedRows.map((r) => r.id)) },
    { label: 'Add to tradelist', icon: 'tradelist', onClick: () => void bulkTrade(true) },
    { label: 'Remove from tradelist', icon: 'close', onClick: () => void bulkTrade(false) },
    // Somewhere to take these out of: here (if this container is holding any of
    // them) or another container promised the same copies.
    {
      label: 'Unfile…',
      icon: 'minus',
      disabled: elsewhere.size === 0 && filedHereRows.length === 0,
      onClick: () => setPicking('unfile'),
    },
    // Only worth offering once something in the selection has been taken out.
    ...(unfiledRows.length > 0
      ? [{ label: 'File back here', icon: 'collection' as const, onClick: () => void refileHere() }]
      : []),
    { label: `Remove from ${meta.noun}`, icon: 'trash', danger: true, onClick: () => void bulkRemove() },
  ];

  async function addMissingToWishlist(candidates: MissingCard[], leaving: boolean) {
    const chosen = candidates.filter((c) => picked.has(c.oracleId));
    if (chosen.length) {
      // One batch so the whole add is a single (undoable) edit-history entry. The
      // wish inherits what the deck's slots asked for, so a deck wanting a foil
      // doesn't go shopping for a nonfoil.
      await addToWishlistBulk(
        chosen.map((c) => ({
          oracleId: c.oracleId,
          scryfallId: null,
          quantity: c.addQty,
          ...(c.condition ? { condition: c.condition } : {}),
          ...(c.finish ? { finish: c.finish } : {}),
          ...(c.lang ? { lang: c.lang } : {}),
        })),
        { source: 'manual', label: deck.name },
      );
      toast(`Added ${chosen.length} ${plural(chosen.length, 'card')} to wishlist`);
    }
    if (leaving) navigate(meta.path);
    else setWishSheet(null);
  }

  function exportDeck() {
    const text = buildDeckText(
      main.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      side.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      commander.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      tokens.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      companion.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      maybe.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
    );
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
    setArchiveOpen(false);
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

  return (
    <CardCursorProvider>
    <section className="page">
      <div className="deck-head">
        <BackLink label={meta.Plural} onClick={() => void goBack()} />
        {/* The same readout the collection header carries, in the same empty
            space beside the options menu — and the same way in to the chart. */}
        <div className="deck-head-aside">
          {ownedWorth && (
            <HeaderValue
              label={missingWorth ? 'Owned value' : 'Value'}
              value={ownedWorth}
              onClick={() => setValueChartOpen(true)}
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
            { label: 'Scan cards', icon: 'camera', onClick: () => setScanning('add') },
            { label: `Re-scan ${meta.noun}`, icon: 'refresh', onClick: () => setScanning('rescan') },
            { label: 'Import list', icon: 'import', onClick: () => setShowImport((v) => !v) },
            { label: 'Export', icon: 'export', onClick: exportDeck },
            ...(isDeck && account.enabled && account.session
              ? [{ label: 'Share deck', icon: 'share' as const, onClick: () => void shareDeck() }]
              : []),
            {
              label: deck.emblem ? 'Change emblem' : 'Choose an emblem',
              icon: 'emblem',
              onClick: () => setEmblemOpen(true),
            },
            // The panel lives at the very bottom, under however many cards are
            // filed here, so the menu opens it *and* takes you to it.
            { label: 'History', icon: 'history', onClick: showHistory },
            // Only a brewed deck has cards you don't have yet; a binder or box is
            // a record of what's already on your shelf.
            ...(isDeck
              ? [{ label: 'Add missing cards to wishlist', icon: 'wishlist' as const, divider: true, onClick: () => void wishlistMissing() }]
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
                    : { label: 'Archive deck', icon: 'archive' as const, divider: true, onClick: () => setArchiveOpen(true) },
                ]
              : []),
            {
              label: `Delete ${meta.noun}`,
              icon: 'trash',
              danger: true,
              onClick: async () => {
                const ok = await confirm({
                  title: `Delete “${deck.name}”?`,
                  body: `The ${meta.noun} and everything filed in it goes. Cards you own stay in your collection. This can’t be undone.`,
                  confirmLabel: `Delete ${meta.noun}`,
                  danger: true,
                });
                if (!ok) return;
                await deleteDeck(id);
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
          onClick={() => setEmblemOpen(true)}
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
      {emblemOpen && (
        <EmblemPickerSheet
          emblem={deck.emblem}
          kind={kind}
          name={deck.name}
          onSave={(next) => void setDeckEmblem(id, next)}
          onClose={() => setEmblemOpen(false)}
        />
      )}

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
        {data.rows.length > 0 && (
          <>
            {!sel.active && <SelectToggle onEnter={sel.enter} />}
            <SortControls prefs={sort} onChange={setSort} groups tagGroups withRelease />
            <StackToggle on={stacking} onChange={setStacking} />
            <ViewToggle mode={view} onChange={setView} />
          </>
        )}
      </div>

      <ClipboardKeys handlers={clipboard} onSelectAll={selectAll} cardKeys={cardKeys} />

      {showImport && (
        <ContainerImport
          key={pastedText ?? 'manual'}
          deckId={id}
          slots={data.rows}
          noun={meta.noun}
          basicsAnyPrinting={isDeck}
          {...(pastedText ? { initialText: pastedText } : {})}
          onDone={(added) => {
            setShowImport(false);
            setPastedText(null);
            if (added > 0) toast(`Added ${added} cards to the ${meta.noun}`);
          }}
        />
      )}

      {isDeck ? (
        <>
          {(isCommander || commander.length > 0) && (
            <Board
              title="Commander"
              rows={commander} stacks={stacksFor(commander)}
              deckId={id}
              group="none"
              view={view}
              issues={legality.issues}
              onEdit={setInfo}
              placements={placements}
              sel={sel}
              commanderDeck={isCommander}
              showYear={sort.key === 'released'}
              emptyHint="No commander yet. Tap a card below and set its zone, or use the +Cmdr button in search."
              colorChoice={isCommander}
              // A solo commander with a pairing ability gets a shortcut to the
              // other half — search narrowed to legal pairs, identity waived.
              footer={(() => {
                if (!isCommander || commander.length !== 1) return undefined;
                const solo = commander[0]!.oracle;
                const label = solo && pairButtonLabel(solo);
                return solo && label ? (
                  <button className="chip pair-find-btn" onClick={() => openPairSearch(solo)}>
                    <Icon name="search" size={14} /> {label}
                  </button>
                ) : undefined;
              })()}
            />
          )}
          {companion.length > 0 && (
            <Board title="Companion" rows={companion} stacks={stacksFor(companion)} deckId={id} group="none" view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} showYear={sort.key === 'released'} />
          )}
          <Board title="Mainboard" rows={main} stacks={stacksFor(main)} deckId={id} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} showYear={sort.key === 'released'} />
          <Board title="Sideboard" rows={side} stacks={stacksFor(side)} deckId={id} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} showYear={sort.key === 'released'} />
          {/* Not part of the deck: no count, no legality, nothing it "needs". */}
          <Board
            title="Considering"
            rows={maybe} stacks={stacksFor(maybe)}
            deckId={id}
            group={sort.group}
            view={view}
            issues={EMPTY_ISSUES}
            onEdit={setInfo}
            placements={placements}
            sel={sel}
            commanderDeck={isCommander}
            showYear={sort.key === 'released'}
            emptyHint="Cards you might play. They don't count toward the deck. Use +Maybe in search, or move cards here from their zone."
          />
          {tokens.length > 0 && (
            <Board title="Tokens" rows={tokens} stacks={stacksFor(tokens)} deckId={id} group="none" view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} showYear={sort.key === 'released'} />
          )}
          {data.suggestedTokens.length > 0 && (
            <TokenSuggestions deckId={id} view={view} tokens={data.suggestedTokens} />
          )}
        </>
      ) : (
        // Storage has one pile — no boards to split it into. Slots written before
        // (or by an import that guessed a sideboard) still show up here.
        <Board
          title="Cards"
          rows={storagePile}
          stacks={stacksFor(storagePile)}
          deckId={id}
          group={sort.group}
          view={view}
          issues={legality.issues}
          onEdit={setInfo}
          placements={placements}
          sel={sel}
          showYear={sort.key === 'released'}
          emptyHint={`Nothing filed here yet. Tap Add cards, scan a stack, or select cards in your collection and file them into this ${meta.noun}.`}
        />
      )}

      <SelectionBar sel={sel} keys={allKeys} count={selectedRows.length} actions={bulkActions} />

      {moving && (
        <MoveZoneSheet
          zones={moveZones}
          count={selectedRows.length}
          onPick={(board) => void bulkMove(board)}
          onClose={() => setMoving(false)}
        />
      )}

      {tagging && (
        <TagSheet
          deckId={id}
          slotIds={tagging}
          onClose={() => {
            setTagging(null);
            sel.exit();
          }}
        />
      )}

      {picking === 'file' && (
        <ContainerPickerSheet
          title="File away"
          label="Choose a deck, binder or box"
          excludeId={id}
          onPick={bulkFile}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'unfile' && (
        <ContainerPickerSheet
          title="Take out of"
          label="Choose where to take these out of"
          only={new Set([...(filedHereRows.length > 0 ? [id] : []), ...elsewhere.keys()])}
          noteFor={(cid) =>
            cid === id
              ? `holds ${filedHereRows.length} of these · the list stays as it is`
              : `holds ${elsewhere.get(cid) ?? 0} of these · they leave that list`
          }
          emptyText="None of the selected cards are filed anywhere."
          onPick={bulkUnfile}
          onClose={() => setPicking(null)}
        />
      )}
      {filingSheet}
      {archiveOpen && (
        <ArchiveDeckSheet
          deckName={deck.name}
          filedCopies={sumQty((data?.rows ?? []).filter(holdsCopy))}
          onArchive={(unfile) => void archiveDeck(unfile)}
          onClose={() => setArchiveOpen(false)}
        />
      )}
      {confirmSheet}

      {assembling && (
        <AssembleSheet
          containerId={id}
          kind={kind}
          items={assembling}
          onClose={() => setAssembling(null)}
        />
      )}

      <DeckHistory deckId={id} kind={kind} open={historyOpen} onToggle={() => setHistoryOpen((v) => !v)} />
      {valueChartOpen && (
        <ContainerValueChartSheet deckId={id} name={deck.name} kind={kind} onClose={() => setValueChartOpen(false)} />
      )}

      {info && (
        <CardSheet
          mode="deck"
          oracleCard={info.card}
          deckCard={{ ...info.deckCard, containerKind: kind }}
          slots={info.slots?.map((s) => ({ ...s, containerKind: kind }))}
          onClose={() => setInfo(null)}
        />
      )}

      {scanning && (
        <ScanSheet
          target={{
            kind: 'deck',
            deckId: id,
            deckName: deck.name,
            containerKind: kind,
            format: deck.format,
            rescan: scanning === 'rescan',
          }}
          onClose={() => setScanning(null)}
        />
      )}
      <CardDropZone
        target={
          scanning
            ? null
            : { kind: 'deck', deckId: id, deckName: deck.name, containerKind: kind, format: deck.format }
        }
      />

      {wishSheet &&
        (() => {
          const { cards, leaving } = wishSheet;
          const dismiss = () => (leaving ? navigate(meta.path) : setWishSheet(null));
          const keys = cards.map((c) => c.oracleId);
          const allPicked = picked.all(keys);
          const chosen = cards.filter((c) => picked.has(c.oracleId));
          const toggleAll = () => picked.toggleAll(keys);
          return (
            <Sheet onClose={dismiss} label="Add missing cards to wishlist" title="Add missing cards to wishlist?">
              <p className="fine-print">
                This deck needs {cards.reduce((s, c) => s + c.addQty, 0)} {plural(cards.length, 'card')} you don’t
                own and haven’t wishlisted. Pick which to add:
              </p>
              <div className="list-toolbar">
                <label className="chip" style={{ alignSelf: 'flex-start' }}>
                  <input type="checkbox" checked={allPicked} onChange={toggleAll} />{' '}
                  {allPicked ? 'Unselect all' : 'Select all'}
                </label>
                <span className="search-meta grow">
                  {chosen.length} of {cards.length} selected
                </span>
              </div>
              <ul className="result-list" style={{ maxHeight: '40dvh', overflowY: 'auto' }}>
                {cards.map((c) => (
                  <li key={c.oracleId} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
                    <label
                      className="result-main"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                    >
                      <input type="checkbox" checked={picked.has(c.oracleId)} onChange={() => picked.toggle(c.oracleId)} />
                      <span className="result-name">
                        {c.name} {c.addQty !== 1 && <span className="badge">×{c.addQty}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="sheet-actions">
                <button onClick={dismiss}>{leaving ? 'Skip' : 'Cancel'}</button>
                <button
                  className="primary"
                  disabled={chosen.length === 0}
                  onClick={() => addMissingToWishlist(cards, leaving)}
                >
                  Add {chosen.length} to wishlist
                </button>
              </div>
            </Sheet>
          );
        })()}
    </section>
    </CardCursorProvider>
  );
}

/** Considering is outside the deck, so legality has nothing to say about it. */
const EMPTY_ISSUES = new Map<string, string>();

function sortRows(rows: Row[], prefs: CardSortPrefs): Row[] {
  return sortCards(
    rows,
    // A lands-box basic costs the deck nothing, so it sorts by nothing.
    (r) => ({ ...cardSortFields(r.oracle, r.printing), ...(r.anyBasic ? { price: 0 } : {}) }),
    prefs,
  );
}

/**
 * Ctrl+C / X / V and select-all for a container page. A component rather than a
 * few lines in ContainerDetail because that page returns early while its
 * container loads, and hooks may not sit behind a return. Renders nothing.
 */
function ClipboardKeys({
  handlers,
  onSelectAll,
  cardKeys,
}: {
  handlers: ClipboardHandlers;
  /** Null when there's nothing to select, which lets the key fall through. */
  onSelectAll: (() => void) | null;
  cardKeys: {
    step: (key: string | null, by: 1 | -1) => void;
    remove: (key: string | null) => void;
    open: (key: string | null) => void;
    pick: (key: string | null) => void;
  };
}) {
  const cursor = useCardCursorCtx();
  const at = cursor?.activeKey ?? null;
  useCardClipboard(handlers);
  useShortcuts({ 'mod+a': onSelectAll });
  // Only live while a card is actually under the cursor, so a stray `-` on an
  // empty page falls through instead of being swallowed.
  useShortcuts(
    at
      ? {
          // '+' is Shift+= on a US keyboard and a key of its own on a Nordic
          // one; '=' catches the people who don't reach for Shift.
          '+': () => cardKeys.step(at, 1),
          '=': () => cardKeys.step(at, 1),
          '-': () => cardKeys.step(at, -1),
          Enter: () => cardKeys.open(at),
          Delete: () => cardKeys.remove(at),
          Backspace: () => cardKeys.remove(at),
          x: () => cardKeys.pick(at),
        }
      : {},
    { allowRepeat: true },
  );
  return null;
}

function Board({
  title,
  rows,
  stacks,
  deckId,
  group,
  view,
  issues,
  onEdit,
  placements,
  sel,
  commanderDeck = false,
  showYear = false,
  emptyHint,
  colorChoice = false,
  footer,
}: {
  title: string;
  rows: Row[];
  /** The rows grouped into tiles, by the page (it needs the same stacks for selection). */
  stacks: SlotStack[];
  /** The container these rows live in, so the card sheet can read its command zone. */
  deckId: string;
  group: GroupKey;
  view: ViewMode;
  issues: Map<string, string>;
  onEdit: (target: EditTarget) => void;
  /** Passed down (not re-queried) so every board reads the same allocation. */
  placements?: PlacementIndex;
  /** Multi-select state, shared across every board so one bar covers them all. */
  sel?: MultiSelect;
  /** Commander-format deck: show move-to/from-command-zone actions. */
  commanderDeck?: boolean;
  /** Sorted by release date: every slot shows the year it's being ordered on. */
  showYear?: boolean;
  emptyHint?: string;
  /** Command zone only: offer the choose-a-color pips on commanders that ask. */
  colorChoice?: boolean;
  /** Rendered under the cards — the "Find a partner" button. */
  footer?: ReactNode;
}) {
  const ownership = useOwnershipIndex();
  const cutIds = useCutSlots(deckId);
  // A slot on "any printing" wears your preferred printing, as a search result would.
  const anySlots = useMemo(() => rows.filter((r) => !r.scryfallId), [rows]);
  const shownAny = useDisplayPrintings(anySlots);
  const imageOf = (r: Row) =>
    r.printing?.imageSmall ?? (r.scryfallId ? undefined : shownAny.get(r.oracleId)?.imageSmall) ?? r.oracle?.imageSmall ?? null;
  if (rows.length === 0 && title === 'Sideboard') return null;
  const count = sumQty(rows);
  const toEdit = (r: Row): DeckCardEdit => ({ ...r, deckId, commanderDeck });
  /** A stack of several slots as one tile; a stack of one is its slot's own item. */
  const toStackItem = (g: SlotStack): CardItem => {
    if (g.rows.length === 1) return toItem(g.rows[0]!);
    const r = g.lead;
    const issue = issues.get(r.oracleId);
    const enough = g.rows.some((x) => x.anyBasic) || r.owned >= g.quantity;
    // Per card, not per slot: a stack has no single edition, finish or
    // language to be exact about, so the badge says "you own this card".
    const own = ownedBadge(ownership?.lookup(r.oracleId), 13);
    const year = yearMark(r.printing, showYear);
    const editions = new Set(g.rows.map((x) => x.scryfallId ?? '')).size;
    return {
      key: r.id,
      ...(year ? { year } : {}),
      name: r.oracle ? (r.board === 'token' ? tokenLabel(r.oracle) : r.oracle.name) : '(unknown card)',
      image: imageOf(r),
      mana: r.oracle?.manaCost,
      foil: g.rows.some((x) => !!x.finish && x.finish !== 'nonfoil'),
      count: g.quantity,
      badge: issue ? '⚠' : own?.icon,
      badgeClass: issue ? 'badge-illegal' : own?.cls,
      badgeTitle: issue ?? own?.title,
      dim: !enough,
      cut: g.rows.every((x) => cutIds.has(x.id)),
      sub: (
        <>
          {`owned ${r.owned} · ${editions > 1 ? `${editions} editions` : `${g.rows.length} slots`}`}
          {issue && <span className="badge badge-illegal-chip">{issue}</span>}
        </>
      ),
      onClick: r.oracle
        ? () => onEdit({ card: r.oracle!, deckCard: toEdit(r), slots: g.rows.map(toEdit) })
        : undefined,
    };
  };
  const toItem = (r: Row): CardItem => {
    const enough = r.anyBasic || r.owned >= r.quantity;
    const issue = issues.get(r.oracleId);
    const wants = r.anyBasic ? '' : wantsDetail(r);
    // Ownership checkmark (own this exact printing / another / for trade), same
    // as everywhere else. A legality problem still wins the badge slot (⚠). A
    // lands-box basic is had by definition, so it gets the plain check.
    // A slot's double check means "I own exactly this card": it names an edition,
    // finish, condition and language, and a copy in your collection fits. A slot
    // that leaves any of those on "any" hasn't picked a card yet, so it keeps the
    // single check even when you own the thing.
    //
    // Above that sits the green collection badge: this slot doesn't just match a
    // card you own, it *holds* it. A pinned slot that lost the copy to a newer
    // filing keeps the double check and shows up in the filing conflicts — and so
    // does one you emptied out by hand (DeckCard.unfiled), which claims nothing
    // and so can never be filed here.
    const pinned = namesCopy(r);
    const filedHere = !r.anyBasic && (placements?.allocated(r.id) ?? 0) >= r.quantity;
    const own = r.anyBasic
      ? { icon: <Icon name="check" size={13} />, cls: 'own-yes', title: 'Any printing, from your lands box' }
      : ownedBadge(
          ownership?.lookupWanted(r.oracleId, {
            scryfallId: r.scryfallId,
            condition: r.condition,
            finish: r.finish,
            lang: r.lang,
          }),
          13,
          r.unfiled
            ? { yes: 'this copy is out of here right now', no: 'but nothing matching this slot' }
            : pinned
              ? { yes: 'including the copy this slot names', no: 'but nothing matching this slot' }
              : { yes: 'including the copy this slot names', no: 'this slot hasn’t picked a copy yet' },
          filedHere,
        );
    // A slot that pinned a language: the flag says which copy the list wants,
    // so a deck built out of your Japanese cards reads as one at a glance.
    const lang = langMark(r.lang);
    const year = yearMark(r.printing, showYear);
    // Prismatic Piper & co: pick the color the commander is, right on the card.
    const colorPips =
      colorChoice && r.oracle && needsColorChoice(r.oracle) ? (
        <ColorChoicePicker chosen={r.chosenColor} onPick={(c) => void setDeckCardChosenColor(r.id, c)} />
      ) : undefined;
    return {
      key: r.id,
      ...(lang ? { lang } : {}),
      ...(year ? { year } : {}),
      ...(colorPips ? { sideStrip: colorPips } : {}),
      name: r.oracle ? (r.board === 'token' ? tokenLabel(r.oracle) : r.oracle.name) : '(unknown card)',
      image: imageOf(r),
      mana: r.oracle?.manaCost,
      // A slot asking for a foil or etched copy gets the sheen; one still on
      // "any finish" hasn't picked a shiny card yet, so it stays matte.
      foil: !!r.finish && r.finish !== 'nonfoil',
      count: r.quantity,
      badge: issue ? '⚠' : own?.icon,
      badgeClass: issue ? 'badge-illegal' : own?.cls,
      badgeTitle: issue ?? own?.title,
      dim: !enough,
      // Cut but not yet pasted: still here, and still yours if you never paste.
      cut: cutIds.has(r.id),
      sub: (
        <>
          {r.anyBasic ? 'any printing' : `owned ${r.owned}`}
          {wants && ` · ${wants}`}
          {r.unfiled && ' · not filed here'}
          {issue && <span className="badge badge-illegal-chip">{issue}</span>}
          {r.tags?.length ? (
            <span className="tag-chips">
              {r.tags.map((t) => (
                <span key={t} className="tag-chip">
                  {t}
                </span>
              ))}
            </span>
          ) : null}
        </>
      ),
      onClick: r.oracle
        ? () =>
            onEdit({
              card: r.oracle!,
              // Same reason as the row spread above: the slot's own fields come
              // across whole, and only the deck context is added by hand.
              deckCard: { ...r, deckId, commanderDeck },
            })
        : undefined,
    };
  };
  const groups = group === 'none' ? null : groupCards(stacks, (g) => g.lead.oracle, group, (g) => g.lead.tags);
  // Land drops the Land heading would otherwise miss: MDFC backs, Dryad Arbor.
  const landSources = group === 'type' ? extraLands(rows, (r) => r.oracle, (r) => r.quantity) : [];
  // Grouping by tag lists a multi-tagged card under each of its tags, so the
  // headings can add up to more than the board. Say so rather than let the
  // arithmetic look broken.
  const multiTagged = group === 'tag' ? rows.filter((r) => (r.tags?.length ?? 0) > 1).length : 0;
  const selProps = { selectable: sel?.active, selectedKeys: sel?.selected, onToggleSelect: sel?.toggle };
  return (
    <div className="about-section">
      <h2>
        {title} <span className="badge">{count}</span>
      </h2>
      {multiTagged > 0 && (
        <p className="fine-print">
          {multiTagged} {plural(multiTagged, 'card')} carr{multiTagged === 1 ? 'ies' : 'y'} more than one tag, so
          {multiTagged === 1 ? ' it shows' : ' they show'} up under each of them.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="fine-print">{emptyHint ?? 'Empty.'}</p>
      ) : groups ? (
        groups.map((g) => (
          <div key={g.label} className="card-group">
            <h3 className="card-group-title">
              {g.label}{' '}
              <GroupCountBadge
                quantity={sumQty(g.items)}
                extras={g.label === 'Land' && group === 'type' ? landSources : undefined}
              />
            </h3>
            <CardItems view={view} items={g.items.map(toStackItem)} {...selProps} />
          </div>
        ))
      ) : (
        <CardItems view={view} items={stacks.map(toStackItem)} {...selProps} />
      )}
      {footer && <div className="board-footer">{footer}</div>}
    </div>
  );
}

/**
 * The mana pips a choose-a-color commander shows until a color is picked (see
 * DeckCard.chosenColor). Picking collapses the strip to the one chosen pip;
 * tapping that pip reopens the strip to change the choice.
 */
function ColorChoicePicker({ chosen, onPick }: { chosen?: Color; onPick: (c: Color) => void }) {
  const [changing, setChanging] = useState(false);
  if (chosen && !changing) {
    return (
      <button
        className="color-pip color-pip-chosen"
        title={`Chosen color: ${COLOR_NAME[chosen]}. Tap to change.`}
        onClick={() => setChanging(true)}
      >
        <i className={`ms ms-${chosen.toLowerCase()} ms-cost`} aria-hidden />
      </button>
    );
  }
  return (
    <div className="color-pip-strip" role="group" aria-label="Choose this commander's color">
      {COLORS.map((c) => (
        <button
          key={c}
          className={`color-pip${chosen === c ? ' color-pip-chosen' : ''}`}
          title={`Be ${COLOR_NAME[c].toLowerCase()}`}
          onClick={() => {
            setChanging(false);
            onPick(c);
          }}
        >
          <i className={`ms ms-${c.toLowerCase()} ms-cost`} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/**
 * "Move to…" for a multi-selection: the deck's zones, with the ones this
 * selection can't go to greyed out and saying why rather than missing. Deck
 * brewing is mostly moving cards between these four piles, so it's a list of
 * plain rows, not a dropdown you have to open first.
 */
function MoveZoneSheet({
  zones,
  count,
  onPick,
  onClose,
}: {
  zones: BoardOption[];
  count: number;
  onPick: (board: DeckBoard) => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} title={`Move ${count} ${plural(count, 'card')} to`} className="zone-sheet">
      <ul className="zone-list">
        {zones.map((z) => (
          <li key={z.board}>
            <button className="zone-option" onClick={() => onPick(z.board)} disabled={!!z.refusal}>
              <Icon name="moveTo" size={16} />
              <span className="zone-option-label">{z.label}</span>
              {z.refusal && <span className="zone-option-why">{z.refusal}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        <button onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

/**
 * Extra cardboard the deck's own cards call for (Scryfall's `all_parts`) that
 * isn't in the token board yet: tokens they make — The Necrobloom suggesting its
 * Plant and Zombie — plus the marker cards they reference, so a Skithiryx deck
 * gets its Poison Counter and a Sefris deck the three dungeons it can venture
 * into. One tap files it into the token board at quantity 1; the badge shows
 * whether a copy is already sitting in the collection, same as any other card.
 */
function TokenSuggestions({ deckId, view, tokens }: { deckId: string; view: ViewMode; tokens: Priced<OracleCard>[] }) {
  const action = useAsyncAction();
  const ownership = useOwnershipIndex();
  const [adding, setAdding] = useState<Set<string>>(new Set());

  async function add(oracleId: string) {
    setAdding((s) => new Set(s).add(oracleId));
    await addDeckCard({ deckId, oracleId, board: 'token', quantity: 1 });
  }

  const items: CardItem[] = tokens.map((o) => {
    const marker = isMarkerCard(o.name, o.typeLine);
    const noun = marker ? 'card' : 'token';
    const own = ownedBadge(ownership?.lookup(o.oracleId), 13, {
      yes: `you own a copy of this ${noun}`,
      no: `you don't own this ${noun} yet`,
    });
    return {
      key: o.oracleId,
      name: tokenLabel(o),
      image: o.imageSmall,
      badge: own?.icon,
      badgeClass: own?.cls,
      badgeTitle: own?.title,
      sub: marker ? 'needed by a card in this deck' : 'made by a card in this deck',
      actions: (
        <button
          className="ghost icon-only"
          disabled={adding.has(o.oracleId)}
          onClick={() => action.run('add the card', () => add(o.oracleId))}
          aria-label={`Add ${tokenLabel(o)} to tokens`}
          title="Add to tokens"
        >
          <Icon name="plus" size={16} />
        </button>
      ),
    };
  });

  return (
    <div className="about-section">
      <h2>
        Suggested tokens <span className="badge">{tokens.length}</span>
      </h2>
      <p className="fine-print">Made or needed by cards in this deck. Doesn’t count toward your deck size.</p>
      <CardItems view={view} items={items} />
    </div>
  );
}

function ContainerImport({
  deckId,
  slots,
  noun,
  basicsAnyPrinting,
  initialText,
  onDone,
}: {
  deckId: string;
  /** What's already filed here (the page's own rows), so a second paste of the
   *  same list can say so instead of quietly doubling the deck. */
  slots: readonly { oracleId: string; board: DeckBoard; quantity: number }[];
  /** "deck" / "binder" / "box", for the wording. */
  noun: string;
  /** Decks pull their basics from the lands box; a binder or box holds real cards. */
  basicsAnyPrinting: boolean;
  /** A list that arrived on the clipboard: filled in and analyzed on sight,
   *  since pasting a decklist already said what you wanted done with it. */
  initialText?: string;
  onDone: (added: number) => void;
}) {
  const [overlap, setOverlap] = useState<OverlapMode>('add');
  // The written lines, waiting on the "you don't own these" tick-list.
  const [unowned, setUnowned] = useState<{ cards: UnownedCard[]; lines: ResolvedLine[]; added: number } | null>(null);
  const picked = useKeySet();
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const ownership = useOwnershipIndex();
  // Card + board only: a pasted line overlaps any slot of that card on that board.
  const overlapKey = (l: { oracleId: string; board?: DeckBoard }) => slotKey({ oracleId: l.oracleId, board: l.board ?? 'main' });
  const have = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of slots) map.set(overlapKey(s), (map.get(overlapKey(s)) ?? 0) + s.quantity);
    return map;
  }, [slots]);

  async function confirm(lines: ResolvedLine[]) {
    const wanted = applyOverlap(lines, overlap, have, overlapKey);
    if (wanted.length === 0) {
      toast(`Nothing added: every card was already in the ${noun}`);
      onDone(0);
      return;
    }
    // A pasted list's basics are the ones you'd fetch from the lands box, not
    // copies the list expects you to own — same default as adding them by hand.
    const oracles = basicsAnyPrinting ? await getOracleCardsByIds(wanted.map((l) => l.oracleId)) : null;
    const isAny = (l: ResolvedLine) => {
      const oracle = oracles?.get(l.oracleId);
      return !!oracle && isBasicLand(oracle);
    };
    await addDeckCardsBulk(
      deckId,
      wanted.map((l) => ({
        oracleId: l.oracleId,
        quantity: l.quantity,
        board: l.board ?? 'main',
        ...(isAny(l) ? { anyBasic: true } : { scryfallId: l.scryfallId }),
      })),
    );
    const added = sumQty(wanted);

    // Scanning a pile into a container has always offered to also register it
    // as owned; pasting the same list left the collection none the wiser and
    // the container full of "you don't own this" badges. Same question now.
    const real = wanted.filter((l) => !isAny(l));
    const missing = real.filter((l) => !ownership?.lookup(l.oracleId, l.scryfallId).ownsExact);
    if (missing.length === 0) {
      onDone(added);
      return;
    }
    const printings = await getPrintingsByIds(missing.map((l) => l.scryfallId));
    const cards: UnownedCard[] = missing.map((l) => {
      const p = printings.get(l.scryfallId);
      return {
        key: `${l.scryfallId}|${l.board ?? 'main'}`,
        name: l.name,
        ...(p?.imageSmall ? { image: p.imageSmall } : {}),
        sub: [p ? `${p.set.toUpperCase()} #${p.collectorNumber}` : null, l.lang, l.quantity > 1 ? `×${l.quantity}` : null]
          .filter(Boolean)
          .join(' · '),
        qty: l.quantity,
      };
    });
    picked.reset(cards.map((c) => c.key));
    setUnowned({ cards, lines: missing, added });
  }

  async function applyUnowned() {
    if (!unowned) return;
    setBusy(true);
    try {
      const chosen = unowned.lines.filter((l) => picked.has(`${l.scryfallId}|${l.board ?? 'main'}`));
      if (chosen.length) {
        await applyImport(chosen, { source: 'import', label: `Filled ${noun}` });
        const n = sumQty(chosen);
        toast(`Added ${n} ${plural(n, 'card')} to your collection`);
      }
      const added = unowned.added;
      setUnowned(null);
      onDone(added);
    } finally {
      setBusy(false);
    }
  }

  if (unowned) {
    return (
      <div className="about-section">
        <UnownedPromptSheet
          cards={unowned.cards}
          picked={picked.set}
          busy={busy}
          intro={
            <>
              {unowned.cards.length} {plural(unowned.cards.length, 'card')} in this list {' '}
              {unowned.cards.length === 1 ? "isn't" : "aren't"} in your collection. If the {noun} is real cardboard on
              your shelf, add {unowned.cards.length === 1 ? 'it' : 'them'} too:
            </>
          }
          confirmLabel={(q) => (q > 0 ? `Add ${q} to collection` : 'Not now')}
          backLabel="Skip"
          onToggle={picked.toggle}
          onToggleAll={() => picked.toggleAll(unowned.cards.map((c) => c.key))}
          onBack={() => {
            const added = unowned.added;
            setUnowned(null);
            onDone(added);
          }}
          onConfirm={() => void applyUnowned()}
        />
      </div>
    );
  }

  // A deck slot keys on oracle + board; the panel keeps each line's board and
  // resolved printing so the deck remembers which edition the list used.
  return (
    <ImportPanel
      board
      placeholder={'4 Lightning Bolt\n2 Counterspell\n\nSideboard\n3 Duress'}
      {...(initialText ? { initialText } : {})}
      onConfirm={confirm}
      confirmLabel={(n) => `Add ${n} entries to ${noun}`}
      aboveReview={(resolved) => {
        const already = resolved.filter((l) => (have.get(overlapKey(l)) ?? 0) > 0).length;
        return already > 0 && <OverlapChoice count={already} where={`in this ${noun}`} value={overlap} onChange={setOverlap} />;
      }}
    />
  );
}
