import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  DECK_FORMATS,
  type Color,
  type Condition,
  type ContainerKind,
  type DeckBoard,
  type DeckFormat,
  type Finish,
  type OracleCard,
  type Priced,
  type Printing,
} from '@mtg/shared';
import { db } from '../db/schema.js';
import {
  getOracleCardsByIds,
  getOwnedCountsFor,
  getPrintingsByIds,
  computeDeckWishlistCandidates,
  type MissingCard,
} from '../db/queries.js';
import {
  addDeckCard,
  addDeckCardsBulk,
  deleteDeck,
  removeDeckCardsBulk,
  removeDeckCardsMatching,
  renameDeck,
  setContainerForTrade,
  setDeckCardsForTrade,
  setDeckFormat,
} from '../db/dataAccess.js';
import { addToWishlistBulk, applyImport } from '../db/dataAccess.js';
import { checkDeckLegality, formatLabel, isBasicLand, type LegalityReport } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { useFiling } from '../deck/useFiling.js';
import { buildDeckText } from '../deck/deckText.js';
import { shareDeckLink } from '../deck/share.js';
import { getUserProfile } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { downloadText } from '../import/export.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import { ImportDefaultsRow, IMPORT_DEFAULTS, OverlapChoice, applyOverlap, type OverlapMode } from '../import/ImportExtras.js';
import { UnownedPromptSheet, type UnownedCard } from '../components/UnownedPromptSheet.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import type { ImportDefaults, ResolvedLine, UnmatchedLine } from '../import/types.js';
import { useToast } from '../components/Toast.js';
import { CardSheet, FINISH_LABELS } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem, type ViewMode } from '../components/CardViews.js';
import { ownedBadge } from '../components/OwnedBadge.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { containerValue, missingValue, valueText } from '../components/ValueSummary.js';
import {
  SortControls,
  groupCards,
  priceValue,
  pricedForFinish,
  sortCards,
  useCardSort,
  type CardSortPrefs,
  type GroupKey,
} from '../components/CardSorting.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { AssembleSheet, type AssembleItem } from '../components/AssembleSheet.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { Sheet } from '../components/Sheet.js';
import { DeckHistory, HISTORY_ANCHOR } from '../components/DeckHistory.js';
import { BulkActionBar, type BulkAction } from '../components/BulkActionBar.js';
import { ContainerPickerSheet } from '../components/ContainerPickerSheet.js';
import { TagSheet } from '../components/TagSheet.js';
import { useMultiSelect, type MultiSelect } from '../components/useMultiSelect.js';
import { usePlacementIndex, type PlacementIndex } from '../db/usePlacements.js';
import { Icon } from '../components/icons.js';

interface Row {
  id: string;
  oracleId: string;
  scryfallId?: string;
  quantity: number;
  board: DeckBoard;
  /** "Any printing" basic land: no edition, no money, always counted as had. */
  anyBasic?: boolean;
  /** What the slot wants of the copy filling it; undefined = any. */
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  /** The user's own labels on this slot, for group-by-tag and the row chips. */
  tags?: string[];
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
  owned: number;
}

/** What a card row hands the CardSheet to edit a deck slot (incl. commander context). */
interface DeckCardEdit {
  id: string;
  quantity: number;
  scryfallId?: string;
  anyBasic?: boolean;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  tags?: string[];
  board: DeckBoard;
  deckId: string;
  commanderDeck: boolean;
}

/** A slot's wants, spelled out for the row's sub-line ('' = it wants nothing special). */
function wantsDetail(r: Row): string {
  const bits: string[] = [];
  if (r.finish) bits.push(FINISH_LABELS[r.finish]);
  if (r.condition) bits.push(`min ${r.condition}`);
  if (r.lang) bits.push(r.lang);
  return bits.join(' · ');
}

const COLOR_WORDS: Record<Color, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/**
 * Tokens are named tersely by Scryfall ("Plant", "Zombie") — this rebuilds the
 * fuller description players actually use ("0/1 Green Plant Creature Token"),
 * out of fields every card already carries. Non-creature tokens (Treasure,
 * Clue, an emblem…) already have a self-describing name, so they just get
 * " Token" appended.
 */
function tokenLabel(o: {
  name: string;
  colors: Color[];
  typeLine: string;
  power?: string | null;
  toughness?: string | null;
}): string {
  if (!/\bCreature\b/i.test(o.typeLine)) return `${o.name} Token`;
  const pt = o.power != null && o.toughness != null ? `${o.power}/${o.toughness} ` : '';
  const colorWord = o.colors.length ? `${o.colors.map((c) => COLOR_WORDS[c]).join('/')} ` : '';
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
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const account = useAccount();
  const [favDeckIds, setFavDeckIds] = useState<Set<string> | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [scanning, setScanning] = useState<'add' | 'rescan' | null>(null);
  // The "add what's missing to your wishlist" sheet. It shows up on the way out
  // of a deck (`leaving`), and on demand from the ⋯ menu — same sheet, but asking
  // for it deliberately shouldn't also walk you off the page.
  const [wishSheet, setWishSheet] = useState<{ cards: MissingCard[]; leaving: boolean } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [view, setView] = useViewMode();
  const [sort, setSort] = useCardSort('deck', { group: 'type' });
  const [info, setInfo] = useState<{ card: Priced<OracleCard>; deckCard: DeckCardEdit } | null>(null);
  const sel = useMultiSelect();
  // 'file' picks somewhere to *also* put the selection, 'unfile' picks somewhere
  // to take it out of — the two halves of sorting out a card promised twice.
  const [picking, setPicking] = useState<'file' | 'unfile' | null>(null);
  // The multi-select "Tag…" sheet, frozen on the slots that were selected.
  const [tagging, setTagging] = useState<string[] | null>(null);
  // The "assemble from my collection" walkthrough, frozen at the moment it opens.
  const [assembling, setAssembling] = useState<AssembleItem[] | null>(null);
  const placements = usePlacementIndex();
  const { file, sheet: filingSheet } = useFiling();
  const { confirm, sheet: confirmSheet } = useConfirm();

  const data = useLiveQuery(async () => {
    const deck = await db.decks.get(id);
    if (!deck) return { deck: null, rows: [] as Row[], suggestedTokens: [] as Priced<OracleCard>[] };
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    const [oracleMap, printMap, owned] = await Promise.all([
      getOracleCardsByIds(cards.map((c) => c.oracleId)),
      getPrintingsByIds(cards.map((c) => c.scryfallId).filter((s): s is string => !!s)),
      getOwnedCountsFor(cards.map((c) => c.oracleId)),
    ]);
    const rows: Row[] = cards.map((c) => ({
      id: c.id,
      oracleId: c.oracleId,
      scryfallId: c.scryfallId,
      quantity: c.quantity,
      board: c.board,
      anyBasic: c.anyBasic,
      condition: c.condition,
      finish: c.finish,
      lang: c.lang,
      tags: c.tags,
      oracle: oracleMap.get(c.oracleId),
      printing: c.scryfallId ? printMap.get(c.scryfallId) : undefined,
      owned: owned.get(c.oracleId) ?? 0,
    }));
    // Tokens the deck's own cards create, minus whatever's already sitting in
    // the token board — the "you'll need these" suggestions.
    const haveToken = new Set(rows.filter((r) => r.board === 'token').map((r) => r.oracleId));
    const neededTokenIds = new Set<string>();
    for (const r of rows) {
      if (r.board === 'token') continue;
      for (const t of r.oracle?.tokenOracleIds ?? []) {
        if (!haveToken.has(t)) neededTokenIds.add(t);
      }
    }
    const suggestedMap = neededTokenIds.size ? await getOracleCardsByIds(neededTokenIds) : new Map<string, Priced<OracleCard>>();
    const suggestedTokens = [...suggestedMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { deck, rows, suggestedTokens };
  }, [id]);

  // Fetch our own favorited-deck ids so the share action knows whether this
  // deck is actually browsable — only favorited decks resolve at a share link.
  useEffect(() => {
    const session = account.session;
    if (!account.enabled || !session) {
      setFavDeckIds(null);
      return;
    }
    let cancelled = false;
    getUserProfile(session.token, session.username)
      .then((res) => {
        if (cancelled) return;
        const ids = (res.profile?.favoriteDecks ?? [])
          .map((f) => f.deckId)
          .filter((x): x is string => typeof x === 'string');
        setFavDeckIds(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setFavDeckIds(new Set()); // offline/error — treat as "none known"
      });
    return () => {
      cancelled = true;
    };
  }, [account.enabled, account.session?.token, account.session?.username]);

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

  const summary = useMemo(() => {
    // Tokens never count toward "cards" — they're a separate, uncounted list.
    const rows = (data?.rows ?? []).filter((r) => r.board !== 'token');
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
    const rows = (data?.rows ?? []).filter((r) => r.board !== 'token');
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
        (data?.rows ?? []).map((r) => ({ oracleId: r.oracleId, quantity: r.quantity, board: r.board, oracle: r.oracle })),
      ),
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
  const tokens = sortRows(data.rows.filter((r) => r.board === 'token'), sort);

  async function goBack() {
    // Only a brewed deck has "cards I still need" — a binder or box holds what
    // you already own, so there's nothing to wishlist on the way out.
    const candidates = isDeck ? await computeDeckWishlistCandidates(id) : [];
    if (candidates.length) openWishSheet(candidates, true);
    else navigate(meta.path);
  }

  function openWishSheet(candidates: MissingCard[], leaving: boolean) {
    setWishSheet({ cards: candidates, leaving });
    setPicked(new Set(candidates.map((c) => c.oracleId))); // all ticked by default
  }

  /** ⋯ menu: wishlist whatever this deck still needs, without leaving the page. */
  async function wishlistMissing() {
    const candidates = await computeDeckWishlistCandidates(id);
    if (candidates.length) openWishSheet(candidates, false);
    else toast(`Nothing missing — this ${meta.noun} is covered by your collection and wishlist`);
  }

  /** Storage action: put every card filed here on the tradelist, or take it off. */
  async function markAllForTrade(forTrade: boolean) {
    const n = await setContainerForTrade(id, forTrade);
    if (n === 0) {
      toast(forTrade ? 'Nothing here is in your collection to mark' : `Nothing in this ${meta.noun} was for trade`);
    } else {
      toast(`${forTrade ? 'Marked' : 'Unmarked'} ${n} card${n === 1 ? '' : 's'} for trade`);
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
    const todo: AssembleItem[] = [...commander, ...main, ...side, ...tokens]
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
  const selectedRows = data.rows.filter((r) => sel.selected.has(r.id));
  const allKeys = data.rows.map((r) => r.id);
  const selectedCopies = selectedRows.reduce((s, r) => s + r.quantity, 0);
  const plural = (n: number) => (n === 1 ? '' : 's');

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

  async function bulkRemove() {
    const n = selectedRows.length;
    const ok = await confirm({
      title: `Remove ${n} card${plural(n)}?`,
      body: `${n === 1 ? 'It leaves' : 'They leave'} “${deck.name}”. Copies you own stay in your collection.`,
      confirmLabel: `Remove from ${meta.noun}`,
      danger: true,
    });
    if (!ok) return;
    const copies = await removeDeckCardsBulk(selectedRows.map((r) => r.id));
    toast(`Removed ${copies} card${plural(copies)} from the ${meta.noun}`);
    sel.exit();
  }

  /** Mark the selected cards' owned copies for trade (or take them back off). */
  async function bulkTrade(forTrade: boolean) {
    const n = await setDeckCardsForTrade(selectedRows.map((r) => r.id), forTrade);
    if (n === 0) {
      toast(forTrade ? 'None of those are in your collection to mark' : 'None of those were for trade');
    } else {
      toast(`${forTrade ? 'Marked' : 'Unmarked'} ${n} card${plural(n)} for trade`);
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
    const mode = await file(
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
    if (mode === null) return;
    const noun = CONTAINER_META[targetKind].noun.toLowerCase();
    toast(
      mode === 'move'
        ? `Moved ${selectedCopies} card${plural(selectedCopies)} to ${noun}`
        : `Added ${selectedCopies} card${plural(selectedCopies)} to ${noun}`,
    );
    sel.exit();
  }

  /** Take the selection back out of another container (the conflict fix). */
  async function bulkUnfile(containerId: string, targetKind: ContainerKind) {
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
        : `Removed ${removed} card${plural(removed)} from that ${CONTAINER_META[targetKind].noun.toLowerCase()}`,
    );
    sel.exit();
  }

  const bulkActions: BulkAction[] = [
    { label: 'Tag…', icon: 'tags', onClick: () => setTagging(selectedRows.map((r) => r.id)) },
    { label: 'Add to tradelist', icon: 'tradelist', onClick: () => void bulkTrade(true) },
    { label: 'Remove from tradelist', icon: 'close', onClick: () => void bulkTrade(false) },
    { label: 'File away…', icon: 'decks', onClick: () => setPicking('file') },
    // Nothing to unfile from unless the selection is filed somewhere else too.
    { label: 'Unfile…', icon: 'minus', disabled: elsewhere.size === 0, onClick: () => setPicking('unfile') },
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
      toast(`Added ${chosen.length} card${chosen.length === 1 ? '' : 's'} to wishlist`);
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

  async function shareDeck() {
    const session = account.session;
    if (!session) return;
    if (!favDeckIds?.has(deck.id)) {
      toast('Favorite this deck on your profile to share it');
      return;
    }
    const result = await shareDeckLink({ username: session.username, deckId: deck.id, name: deck.name, format: deck.format });
    if (result === 'copied') toast('Share link copied');
    else if (result === 'failed') toast('Could not copy the link');
  }

  return (
    <section className="page">
      <div className="deck-head">
        <button className="linklike" onClick={goBack}>
          ‹ {meta.Plural}
        </button>
        <OptionsMenu
          label={`${meta.Noun} options`}
          actions={[
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
            // The panel lives at the very bottom, under however many cards are
            // filed here, so the menu opens it *and* takes you to it.
            { label: 'History', icon: 'history', onClick: showHistory },
            // Only a brewed deck has cards you don't have yet; a binder or box is
            // a record of what's already on your shelf.
            ...(isDeck
              ? [{ label: 'Add missing cards to wishlist', icon: 'wishlist' as const, onClick: () => void wishlistMissing() }]
              : []),
            // Whether it's a box you're emptying or a deck you're breaking up,
            // "everything in here is up for grabs" is one tap — it only ever
            // touches copies you actually own.
            { label: 'Add all owned cards to tradelist', icon: 'tradelist', onClick: () => void markAllForTrade(true) },
            { label: 'Remove all owned cards from tradelist', icon: 'close', onClick: () => void markAllForTrade(false) },
            ...(isDeck && account.enabled && account.session
              ? [{ label: 'Share deck', icon: 'share' as const, onClick: () => void shareDeck() }]
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

      <input
        ref={nameInputRef}
        className="deck-name-input"
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

      <div className="deck-meta">
        {isDeck && (
          <label className="field" style={{ maxWidth: 160 }}>
            <span>Format</span>
            <select value={deck.format ?? 'casual'} onChange={(e) => void setDeckFormat(id, e.target.value as DeckFormat)}>
              {DECK_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {formatLabel(f)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="search-meta">
          {isDeck ? (
            <>
              You own <strong>{summary.have}</strong> of <strong>{summary.need}</strong> cards
            </>
          ) : (
            <>
              <strong>{summary.need}</strong> card{summary.need === 1 ? '' : 's'} filed here
              {/* Filed but not in the collection: the app's records and the real
                  shelf disagree, which is worth saying out loud. */}
              {summary.need > summary.have && (
                <> · <strong>{summary.need - summary.have}</strong> not in your collection</>
              )}
            </>
          )}
          {ownedWorth && <> · <strong>{ownedWorth}</strong> owned</>}
          {missingWorth && <> · <strong>{missingWorth}</strong> missing</>}
        </p>
      </div>

      {isDeck && <LegalityPanel report={legality} format={deck.format ?? 'casual'} />}

      <div className="list-toolbar">
        <p className="search-meta grow">Search above to add cards to this {meta.noun}.</p>
        {!sel.active && data.rows.length > 0 && (
          <button className="select-toggle" onClick={sel.enter} title="Select multiple cards">
            <Icon name="check" size={15} /> Select
          </button>
        )}
        <SortControls prefs={sort} onChange={setSort} groups tagGroups />
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {showImport && (
        <ImportPanel
          deckId={id}
          noun={meta.noun}
          basicsAnyPrinting={isDeck}
          onDone={(added) => {
            setShowImport(false);
            if (added > 0) toast(`Added ${added} cards to the ${meta.noun}`);
          }}
        />
      )}

      {isDeck ? (
        <>
          {(isCommander || commander.length > 0) && (
            <Board
              title="Commander"
              rows={commander}
              deckId={id}
              group="none"
              view={view}
              issues={legality.issues}
              onEdit={setInfo}
              placements={placements}
              sel={sel}
              commanderDeck={isCommander}
              emptyHint="No commander yet. Use ♛ on a card below, or the +Cmdr button in search."
            />
          )}
          <Board title="Mainboard" rows={main} deckId={id} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} />
          <Board title="Sideboard" rows={side} deckId={id} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} />
          {tokens.length > 0 && (
            <Board title="Tokens" rows={tokens} deckId={id} group="none" view={view} issues={legality.issues} onEdit={setInfo} placements={placements} sel={sel} commanderDeck={isCommander} />
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
          rows={sortRows([...commander, ...main, ...side], sort)}
          deckId={id}
          group={sort.group}
          view={view}
          issues={legality.issues}
          onEdit={setInfo}
          placements={placements}
          sel={sel}
          emptyHint={`Nothing filed here yet. Search above, scan a stack, or select cards in your collection and file them into this ${meta.noun}.`}
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
          label="Choose where to remove these from"
          only={new Set(elsewhere.keys())}
          noteFor={(cid) => {
            const n = elsewhere.get(cid) ?? 0;
            return `holds ${n} of these`;
          }}
          emptyText="None of the selected cards are filed anywhere else."
          onPick={bulkUnfile}
          onClose={() => setPicking(null)}
        />
      )}
      {filingSheet}
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

      {info && <CardSheet oracleCard={info.card} deckCard={info.deckCard} onClose={() => setInfo(null)} />}

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

      {wishSheet &&
        (() => {
          const { cards, leaving } = wishSheet;
          const dismiss = () => (leaving ? navigate(meta.path) : setWishSheet(null));
          const allPicked = cards.every((c) => picked.has(c.oracleId));
          const chosen = cards.filter((c) => picked.has(c.oracleId));
          const toggle = (oracleId: string) =>
            setPicked((prev) => {
              const next = new Set(prev);
              if (next.has(oracleId)) next.delete(oracleId);
              else next.add(oracleId);
              return next;
            });
          const toggleAll = () => setPicked(allPicked ? new Set() : new Set(cards.map((c) => c.oracleId)));
          return (
            <Sheet onClose={dismiss} label="Add missing cards to wishlist">
              <h2 style={{ margin: 0 }}>Add missing cards to wishlist?</h2>
              <p className="fine-print">
                This deck needs {cards.reduce((s, c) => s + c.addQty, 0)} card{cards.length === 1 ? '' : 's'} you don’t
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
                      <input type="checkbox" checked={picked.has(c.oracleId)} onChange={() => toggle(c.oracleId)} />
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
  );
}

function sortRows(rows: Row[], prefs: CardSortPrefs): Row[] {
  return sortCards(
    rows,
    (r) => ({
      name: r.oracle?.name,
      cmc: r.oracle?.cmc,
      // A lands-box basic costs the deck nothing, so it sorts by nothing.
      price: r.anyBasic ? 0 : priceValue(r.printing, r.oracle),
    }),
    prefs,
  );
}

function LegalityPanel({ report, format }: { report: LegalityReport; format: DeckFormat }) {
  if (!report.checked) return <p className="fine-print">Casual (no legality checks).</p>;
  if (report.legal) return <div className="legality legality-ok">✓ Legal in {formatLabel(format)}</div>;
  return (
    <div className="legality legality-bad">
      <strong>⚠ Not legal in {formatLabel(format)}</strong>
      <ul>
        {report.problems.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

function Board({
  title,
  rows,
  deckId,
  group,
  view,
  issues,
  onEdit,
  placements,
  sel,
  commanderDeck = false,
  emptyHint,
}: {
  title: string;
  rows: Row[];
  /** The container these rows live in, so the card sheet can read its command zone. */
  deckId: string;
  group: GroupKey;
  view: ViewMode;
  issues: Map<string, string>;
  onEdit: (target: { card: Priced<OracleCard>; deckCard: DeckCardEdit }) => void;
  /** Passed down (not re-queried) so every board reads the same allocation. */
  placements?: PlacementIndex;
  /** Multi-select state, shared across every board so one bar covers them all. */
  sel?: MultiSelect;
  /** Commander-format deck: show move-to/from-command-zone actions. */
  commanderDeck?: boolean;
  emptyHint?: string;
}) {
  const ownership = useOwnershipIndex();
  if (rows.length === 0 && title === 'Sideboard') return null;
  const count = rows.reduce((s, r) => s + r.quantity, 0);
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
    // filing keeps the double check and shows up in the filing conflicts.
    const pinned = !!r.scryfallId && !!r.finish && !!r.condition && !!r.lang;
    const filedHere = !r.anyBasic && (placements?.allocated(r.id) ?? 0) >= r.quantity;
    const own = r.anyBasic
      ? { icon: <Icon name="check" size={13} />, cls: 'own-yes', title: 'Any printing — from your lands box' }
      : ownedBadge(
          ownership?.lookupWanted(r.oracleId, {
            scryfallId: r.scryfallId,
            condition: r.condition,
            finish: r.finish,
            lang: r.lang,
          }),
          13,
          pinned
            ? { yes: 'including the copy this slot names', no: 'but nothing matching this slot' }
            : { yes: 'including the copy this slot names', no: 'this slot hasn’t picked a copy yet' },
          filedHere,
        );
    return {
      key: r.id,
      name: r.oracle ? (r.board === 'token' ? tokenLabel(r.oracle) : r.oracle.name) : '(unknown card)',
      image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
      mana: r.oracle?.manaCost,
      // A slot asking for a foil or etched copy gets the sheen; one still on
      // "any finish" hasn't picked a shiny card yet, so it stays matte.
      foil: !!r.finish && r.finish !== 'nonfoil',
      count: r.quantity,
      badge: issue ? '⚠' : own?.icon,
      badgeClass: issue ? 'badge-illegal' : own?.cls,
      badgeTitle: issue ?? own?.title,
      dim: !enough,
      sub: (
        <>
          {r.anyBasic ? 'any printing' : `owned ${r.owned}`}
          {wants && ` · ${wants}`}
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
              deckCard: {
                id: r.id,
                quantity: r.quantity,
                scryfallId: r.scryfallId,
                anyBasic: r.anyBasic,
                condition: r.condition,
                finish: r.finish,
                lang: r.lang,
                tags: r.tags,
                board: r.board,
                deckId,
                commanderDeck,
              },
            })
        : undefined,
    };
  };
  const groups = group === 'none' ? null : groupCards(rows, (r) => r.oracle, group, (r) => r.tags);
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
          {multiTagged} card{multiTagged === 1 ? '' : 's'} carr{multiTagged === 1 ? 'ies' : 'y'} more than one tag, so
          {multiTagged === 1 ? ' it shows' : ' they show'} up under each of them.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="fine-print">{emptyHint ?? 'Empty.'}</p>
      ) : groups ? (
        groups.map((g) => (
          <div key={g.label} className="card-group">
            <h3 className="card-group-title">
              {g.label} <span className="badge">{g.items.reduce((s, r) => s + r.quantity, 0)}</span>
            </h3>
            <CardItems view={view} items={g.items.map(toItem)} {...selProps} />
          </div>
        ))
      ) : (
        <CardItems view={view} items={rows.map(toItem)} {...selProps} />
      )}
    </div>
  );
}

/**
 * Tokens the deck's own cards make (Scryfall's `all_parts`) that aren't in the
 * token board yet — e.g. The Necrobloom suggesting its Plant and Zombie. One
 * tap files it into the token board at quantity 1; the badge shows whether a
 * copy is already sitting in the collection, same as any other card.
 */
function TokenSuggestions({ deckId, view, tokens }: { deckId: string; view: ViewMode; tokens: Priced<OracleCard>[] }) {
  const ownership = useOwnershipIndex();
  const [adding, setAdding] = useState<Set<string>>(new Set());

  async function add(oracleId: string) {
    setAdding((s) => new Set(s).add(oracleId));
    await addDeckCard({ deckId, oracleId, board: 'token', quantity: 1 });
  }

  const items: CardItem[] = tokens.map((o) => {
    const own = ownedBadge(ownership?.lookup(o.oracleId), 13, {
      yes: 'you own a copy of this token',
      no: "you don't own this token yet",
    });
    return {
      key: o.oracleId,
      name: tokenLabel(o),
      image: o.imageSmall,
      badge: own?.icon,
      badgeClass: own?.cls,
      badgeTitle: own?.title,
      sub: 'made by a card in this deck',
      actions: (
        <button
          className="ghost icon-only"
          disabled={adding.has(o.oracleId)}
          onClick={() => void add(o.oracleId)}
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
      <p className="fine-print">Made by cards in this deck. Doesn’t count toward your deck size.</p>
      <CardItems view={view} items={items} />
    </div>
  );
}

function ImportPanel({
  deckId,
  noun,
  basicsAnyPrinting,
  onDone,
}: {
  deckId: string;
  /** "deck" / "binder" / "box", for the wording. */
  noun: string;
  /** Decks pull their basics from the lands box; a binder or box holds real cards. */
  basicsAnyPrinting: boolean;
  onDone: (added: number) => void;
}) {
  const [text, setText] = useState('');
  const [defaults, setDefaults] = useState<ImportDefaults>(IMPORT_DEFAULTS);
  const [overlap, setOverlap] = useState<OverlapMode>('add');
  const { status, analyze, reset } = useImportAnalysis();
  // The written lines, waiting on the "you don't own these" tick-list.
  const [unowned, setUnowned] = useState<{ cards: UnownedCard[]; lines: ResolvedLine[]; added: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // What's already filed here, so a second paste of the same list can say so
  // instead of quietly doubling the deck.
  const slots = useLiveQuery(async () => db.deckCards.where('deckId').equals(deckId).toArray(), [deckId]);
  const slotKey = (l: { oracleId: string; board?: DeckBoard }) => `${l.oracleId}|${l.board ?? 'main'}`;
  const have = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of slots ?? []) map.set(slotKey(s), (map.get(slotKey(s)) ?? 0) + s.quantity);
    return map;
  }, [slots]);

  // A deck slot keys on oracle + board; keep the resolved printing so the deck
  // remembers which edition the list used (like a hand-picked printing).
  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: 0,
    condition: defaults.condition,
    finish: u.finish ?? defaults.finish,
    lang: defaults.lang,
    board: u.board ?? 'main',
  });

  async function confirm(lines: ResolvedLine[]) {
    const wanted = applyOverlap(lines, overlap, have, slotKey);
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
    const added = wanted.reduce((s, l) => s + l.quantity, 0);

    // Scanning a pile into a container has always offered to also register it
    // as owned; pasting the same list left the collection none the wiser and
    // the container full of "you don't own this" badges. Same question now.
    const real = wanted.filter((l) => !isAny(l));
    const owned = await db.collection.where('scryfallId').anyOf(real.map((l) => l.scryfallId)).toArray();
    const ownedIds = new Set(owned.filter((e) => e.quantity > 0).map((e) => e.scryfallId));
    const missing = real.filter((l) => !ownedIds.has(l.scryfallId));
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
    setPicked(new Set(cards.map((c) => c.key)));
    setUnowned({ cards, lines: missing, added });
  }

  async function applyUnowned() {
    if (!unowned) return;
    setBusy(true);
    try {
      const chosen = unowned.lines.filter((l) => picked.has(`${l.scryfallId}|${l.board ?? 'main'}`));
      if (chosen.length) {
        await applyImport(chosen, { source: 'import', label: `Filled ${noun}` });
        const n = chosen.reduce((s, l) => s + l.quantity, 0);
        toast(`Added ${n} card${n === 1 ? '' : 's'} to your collection`);
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
          picked={picked}
          busy={busy}
          intro={
            <>
              {unowned.cards.length} card{unowned.cards.length === 1 ? '' : 's'} in this list {' '}
              {unowned.cards.length === 1 ? "isn't" : "aren't"} in your collection. If the {noun} is real cardboard on
              your shelf, add {unowned.cards.length === 1 ? 'it' : 'them'} too:
            </>
          }
          confirmLabel={(q) => (q > 0 ? `Add ${q} to collection` : 'Not now')}
          backLabel="Skip"
          onToggle={(key) =>
            setPicked((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onToggleAll={() =>
            setPicked((prev) =>
              prev.size === unowned.cards.length ? new Set() : new Set(unowned.cards.map((c) => c.key)),
            )
          }
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

  if (status.kind === 'review') {
    const already = status.result.resolved.filter((l) => (have.get(slotKey(l)) ?? 0) > 0).length;
    return (
      <div className="about-section">
        {already > 0 && <OverlapChoice count={already} where={`in this ${noun}`} value={overlap} onChange={setOverlap} />}
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={confirm}
          onCancel={reset}
          confirmLabel={(n) => `Add ${n} entries to ${noun}`}
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
      <textarea
        className="search-input"
        style={{ minHeight: 140, fontFamily: 'ui-monospace, monospace' }}
        placeholder={'4 Lightning Bolt\n2 Counterspell\n\nSideboard\n3 Duress'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ImportDefaultsRow value={defaults} onChange={setDefaults} />
      <button className="primary" onClick={() => analyze(text, { defaults })} disabled={!text.trim()}>
        Analyze
      </button>
    </div>
  );
}
