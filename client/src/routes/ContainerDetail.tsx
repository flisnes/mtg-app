import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DECK_FORMATS,
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
  addDeckCardsBulk,
  deleteDeck,
  removeDeckCardsBulk,
  removeDeckCardsMatching,
  renameDeck,
  setContainerForTrade,
  setDeckCardsForTrade,
  setDeckFormat,
} from '../db/dataAccess.js';
import { addToWishlistBulk } from '../db/dataAccess.js';
import { checkDeckLegality, formatLabel, isBasicLand, type LegalityReport } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { buildDeckText } from '../deck/deckText.js';
import { shareDeckLink } from '../deck/share.js';
import { getUserProfile } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { downloadText } from '../import/export.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import type { ResolvedLine, UnmatchedLine } from '../import/types.js';
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
import { ScanSheet } from '../components/ScanSheet.js';
import { Sheet } from '../components/Sheet.js';
import { DeckHistory, HISTORY_ANCHOR } from '../components/DeckHistory.js';
import { BulkActionBar, type BulkAction } from '../components/BulkActionBar.js';
import { ContainerPickerSheet } from '../components/ContainerPickerSheet.js';
import { useMultiSelect, type MultiSelect } from '../components/useMultiSelect.js';
import { usePlacementIndex } from '../db/usePlacements.js';
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

/**
 * One deck, binder or box. The same screen for all three (they're the same
 * stored row — see deck/containers.ts): a binder or box simply has no format, no
 * legality panel, no sideboard or command zone, and swaps deck-brewing actions
 * for storage ones ("mark everything in here for trade").
 */
export function ContainerDetail({ kind }: { kind: ContainerKind }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
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
  const placements = usePlacementIndex();

  const data = useLiveQuery(async () => {
    const deck = await db.decks.get(id);
    if (!deck) return { deck: null, rows: [] as Row[] };
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
      oracle: oracleMap.get(c.oracleId),
      printing: c.scryfallId ? printMap.get(c.scryfallId) : undefined,
      owned: owned.get(c.oracleId) ?? 0,
    }));
    return { deck, rows };
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

  const summary = useMemo(() => {
    const rows = data?.rows ?? [];
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
    const rows = data?.rows ?? [];
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
  const elsewhere = new Map<string, number>();
  for (const r of selectedRows) {
    for (const p of placements?.lookup(r.oracleId, r.scryfallId).places ?? []) {
      if (p.containerId === id) continue;
      elsewhere.set(p.containerId, (elsewhere.get(p.containerId) ?? 0) + 1);
    }
  }

  async function bulkRemove() {
    const n = selectedRows.length;
    if (!window.confirm(`Remove ${n} card${plural(n)} from “${deck.name}”?`)) return;
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

  /** Also file the selection into another deck, binder or box. */
  async function bulkFile(containerId: string, targetKind: ContainerKind) {
    setPicking(null);
    await addDeckCardsBulk(
      containerId,
      selectedRows.map((r) => ({
        oracleId: r.oracleId,
        quantity: r.quantity,
        board: 'main' as const,
        scryfallId: r.scryfallId,
        anyBasic: r.anyBasic,
        wants: { condition: r.condition, finish: r.finish, lang: r.lang },
      })),
    );
    toast(`Added ${selectedCopies} card${plural(selectedCopies)} to ${CONTAINER_META[targetKind].noun.toLowerCase()}`);
    sel.exit();
  }

  /** Take the selection back out of another container (the conflict fix). */
  async function bulkUnfile(containerId: string, targetKind: ContainerKind) {
    setPicking(null);
    const removed = await removeDeckCardsMatching(
      containerId,
      selectedRows.map((r) => ({ oracleId: r.oracleId, scryfallId: r.scryfallId, quantity: r.quantity })),
    );
    toast(
      removed === 0
        ? `Nothing matched in that ${CONTAINER_META[targetKind].noun.toLowerCase()}`
        : `Removed ${removed} card${plural(removed)} from that ${CONTAINER_META[targetKind].noun.toLowerCase()}`,
    );
    sel.exit();
  }

  const bulkActions: BulkAction[] = [
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
                if (!window.confirm(`Delete “${deck.name}”? This can’t be undone.`)) return;
                await deleteDeck(id);
                navigate(meta.path);
              },
            },
          ]}
        />
      </div>

      <input
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
        <SortControls prefs={sort} onChange={setSort} groups />
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {showImport && (
        <ImportPanel
          deckId={id}
          basicsAnyPrinting={isDeck}
          onDone={(added) => {
            setShowImport(false);
            toast(`Added ${added} cards to the ${meta.noun}`);
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
              sel={sel}
              commanderDeck={isCommander}
              emptyHint="No commander yet. Use ♛ on a card below, or the +Cmdr button in search."
            />
          )}
          <Board title="Mainboard" rows={main} deckId={id} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} sel={sel} commanderDeck={isCommander} />
          <Board title="Sideboard" rows={side} deckId={id} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} sel={sel} commanderDeck={isCommander} />
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
    const pinned = !!r.scryfallId && !!r.finish && !!r.condition && !!r.lang;
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
        );
    return {
      key: r.id,
      name: r.oracle?.name ?? '(unknown card)',
      image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
      mana: r.oracle?.manaCost,
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
                board: r.board,
                deckId,
                commanderDeck,
              },
            })
        : undefined,
    };
  };
  const groups = group === 'none' ? null : groupCards(rows, (r) => r.oracle, group);
  const selProps = { selectable: sel?.active, selectedKeys: sel?.selected, onToggleSelect: sel?.toggle };
  return (
    <div className="about-section">
      <h2>
        {title} <span className="badge">{count}</span>
      </h2>
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

function ImportPanel({
  deckId,
  basicsAnyPrinting,
  onDone,
}: {
  deckId: string;
  /** Decks pull their basics from the lands box; a binder or box holds real cards. */
  basicsAnyPrinting: boolean;
  onDone: (added: number) => void;
}) {
  const [text, setText] = useState('');
  const { status, analyze, reset } = useImportAnalysis();

  // A deck slot keys on oracle + board; keep the resolved printing so the deck
  // remembers which edition the list used (like a hand-picked printing).
  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: 0,
    condition: 'NM',
    finish: 'nonfoil',
    lang: 'en',
    board: u.board ?? 'main',
  });

  async function confirm(lines: ResolvedLine[]) {
    // A pasted list's basics are the ones you'd fetch from the lands box, not
    // copies the list expects you to own — same default as adding them by hand.
    const oracles = basicsAnyPrinting ? await getOracleCardsByIds(lines.map((l) => l.oracleId)) : null;
    const isAny = (l: ResolvedLine) => {
      const oracle = oracles?.get(l.oracleId);
      return !!oracle && isBasicLand(oracle);
    };
    await addDeckCardsBulk(
      deckId,
      lines.map((l) => ({
        oracleId: l.oracleId,
        quantity: l.quantity,
        board: l.board ?? 'main',
        ...(isAny(l) ? { anyBasic: true } : { scryfallId: l.scryfallId }),
      })),
    );
    onDone(lines.reduce((s, l) => s + l.quantity, 0));
  }

  if (status.kind === 'review') {
    return (
      <div className="about-section">
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={confirm}
          onCancel={reset}
          confirmLabel={(n) => `Add ${n} entries to deck`}
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
      <button className="primary" onClick={() => analyze(text)} disabled={!text.trim()}>
        Analyze
      </button>
    </div>
  );
}
