import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DECK_FORMATS,
  type ContainerKind,
  type DeckBoard,
  type DeckFormat,
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
  renameDeck,
  setContainerForTrade,
  setDeckFormat,
} from '../db/dataAccess.js';
import { addToWishlistBulk } from '../db/dataAccess.js';
import { checkDeckLegality, formatLabel, type LegalityReport } from '../deck/legality.js';
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
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem, type ViewMode } from '../components/CardViews.js';
import { ownedBadge } from '../components/OwnedBadge.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { containerValue, missingValue, valueText } from '../components/ValueSummary.js';
import {
  SortControls,
  groupCards,
  priceValue,
  sortCards,
  useCardSort,
  type CardSortPrefs,
  type GroupKey,
} from '../components/CardSorting.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { Sheet } from '../components/Sheet.js';
import { DeckHistory, HISTORY_ANCHOR } from '../components/DeckHistory.js';

interface Row {
  id: string;
  oracleId: string;
  scryfallId?: string;
  quantity: number;
  board: DeckBoard;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
  owned: number;
}

/** What a card row hands the CardSheet to edit a deck slot (incl. commander context). */
interface DeckCardEdit {
  id: string;
  quantity: number;
  scryfallId?: string;
  board: DeckBoard;
  commanderDeck: boolean;
  hasCommander: boolean;
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
  const [exit, setExit] = useState<MissingCard[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [view, setView] = useViewMode();
  const [sort, setSort] = useCardSort('deck', { group: 'type' });
  const [info, setInfo] = useState<{ card: Priced<OracleCard>; deckCard: DeckCardEdit } | null>(null);

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
    for (const r of rows) {
      const cur = byOracle.get(r.oracleId) ?? { need: 0, owned: r.owned };
      cur.need += r.quantity;
      byOracle.set(r.oracleId, cur);
    }
    let need = 0;
    let have = 0;
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
    return containerValue(rows);
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
    if (candidates.length) {
      setExit(candidates);
      setPicked(new Set(candidates.map((c) => c.oracleId))); // all ticked by default
    } else navigate(meta.path);
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

  async function addMissingToWishlist(candidates: MissingCard[]) {
    const chosen = candidates.filter((c) => picked.has(c.oracleId));
    if (chosen.length) {
      // One batch so the whole add is a single (undoable) edit-history entry.
      await addToWishlistBulk(
        chosen.map((c) => ({ oracleId: c.oracleId, scryfallId: null, quantity: c.addQty })),
        { source: 'manual', label: deck.name },
      );
      toast(`Added ${chosen.length} card${chosen.length === 1 ? '' : 's'} to wishlist`);
    }
    navigate(meta.path);
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
            // Storage mirrors real shelves, so "everything in this box is up for
            // grabs" is the action that earns its place here; a deck you're
            // brewing isn't offered for trade wholesale.
            ...(isDeck
              ? []
              : [
                  { label: 'Mark all for trade', icon: 'tradelist' as const, onClick: () => void markAllForTrade(true) },
                  { label: 'Remove all from trade', icon: 'close' as const, onClick: () => void markAllForTrade(false) },
                ]),
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
        <SortControls prefs={sort} onChange={setSort} groups />
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {showImport && (
        <ImportPanel
          deckId={id}
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
              group="none"
              view={view}
              issues={legality.issues}
              onEdit={setInfo}
              commanderDeck={isCommander}
              emptyHint="No commander yet. Use ♛ on a card below, or the +Cmdr button in search."
            />
          )}
          <Board title="Mainboard" rows={main} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} commanderDeck={isCommander} hasCommander={commander.length > 0} />
          <Board title="Sideboard" rows={side} group={sort.group} view={view} issues={legality.issues} onEdit={setInfo} commanderDeck={isCommander} hasCommander={commander.length > 0} />
        </>
      ) : (
        // Storage has one pile — no boards to split it into. Slots written before
        // (or by an import that guessed a sideboard) still show up here.
        <Board
          title="Cards"
          rows={sortRows([...commander, ...main, ...side], sort)}
          group={sort.group}
          view={view}
          issues={legality.issues}
          onEdit={setInfo}
          emptyHint={`Nothing filed here yet. Search above, scan a stack, or select cards in your collection and file them into this ${meta.noun}.`}
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

      {exit &&
        (() => {
          const allPicked = exit.every((c) => picked.has(c.oracleId));
          const chosen = exit.filter((c) => picked.has(c.oracleId));
          const toggle = (oracleId: string) =>
            setPicked((prev) => {
              const next = new Set(prev);
              if (next.has(oracleId)) next.delete(oracleId);
              else next.add(oracleId);
              return next;
            });
          const toggleAll = () => setPicked(allPicked ? new Set() : new Set(exit.map((c) => c.oracleId)));
          return (
            <Sheet onClose={() => navigate(meta.path)} label="Add missing cards to wishlist">
              <h2 style={{ margin: 0 }}>Add missing cards to wishlist?</h2>
              <p className="fine-print">
                This deck needs {exit.reduce((s, c) => s + c.addQty, 0)} card{exit.length === 1 ? '' : 's'} you don’t own
                and haven’t wishlisted. Pick which to add:
              </p>
              <div className="list-toolbar">
                <label className="chip" style={{ alignSelf: 'flex-start' }}>
                  <input type="checkbox" checked={allPicked} onChange={toggleAll} />{' '}
                  {allPicked ? 'Unselect all' : 'Select all'}
                </label>
                <span className="search-meta grow">
                  {chosen.length} of {exit.length} selected
                </span>
              </div>
              <ul className="result-list" style={{ maxHeight: '40dvh', overflowY: 'auto' }}>
                {exit.map((c) => (
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
                <button onClick={() => navigate(meta.path)}>Skip</button>
                <button className="primary" disabled={chosen.length === 0} onClick={() => addMissingToWishlist(exit)}>
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
    (r) => ({ name: r.oracle?.name, cmc: r.oracle?.cmc, price: priceValue(r.printing, r.oracle) }),
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
  group,
  view,
  issues,
  onEdit,
  commanderDeck = false,
  hasCommander = false,
  emptyHint,
}: {
  title: string;
  rows: Row[];
  group: GroupKey;
  view: ViewMode;
  issues: Map<string, string>;
  onEdit: (target: { card: Priced<OracleCard>; deckCard: DeckCardEdit }) => void;
  /** Commander-format deck: show move-to/from-command-zone actions. */
  commanderDeck?: boolean;
  /** A commander is already in the command zone: hide "make commander" actions. */
  hasCommander?: boolean;
  emptyHint?: string;
}) {
  const ownership = useOwnershipIndex();
  if (rows.length === 0 && title === 'Sideboard') return null;
  const count = rows.reduce((s, r) => s + r.quantity, 0);
  const toItem = (r: Row): CardItem => {
    const enough = r.owned >= r.quantity;
    const issue = issues.get(r.oracleId);
    // Ownership checkmark (own this exact printing / another / for trade), same
    // as everywhere else. A legality problem still wins the badge slot (⚠).
    const own = ownedBadge(ownership?.lookup(r.oracleId, r.scryfallId ?? r.oracle?.defaultScryfallId));
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
          owned {r.owned}
          {issue && <span className="badge badge-illegal-chip">{issue}</span>}
        </>
      ),
      onClick: r.oracle
        ? () =>
            onEdit({
              card: r.oracle!,
              deckCard: { id: r.id, quantity: r.quantity, scryfallId: r.scryfallId, board: r.board, commanderDeck, hasCommander },
            })
        : undefined,
    };
  };
  const groups = group === 'none' ? null : groupCards(rows, (r) => r.oracle, group);
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
            <CardItems view={view} items={g.items.map(toItem)} />
          </div>
        ))
      ) : (
        <CardItems view={view} items={rows.map(toItem)} />
      )}
    </div>
  );
}

function ImportPanel({ deckId, onDone }: { deckId: string; onDone: (added: number) => void }) {
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
    await addDeckCardsBulk(
      deckId,
      lines.map((l) => ({ oracleId: l.oracleId, quantity: l.quantity, board: l.board ?? 'main', scryfallId: l.scryfallId })),
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
