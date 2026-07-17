import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router-dom';
import { DECK_FORMATS, type DeckBoard, type DeckFormat, type OracleCard, type Priced, type Printing } from '@mtg/shared';
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
  moveDeckCard,
  removeDeckCard,
  renameDeck,
  setDeckCardQuantity,
  setDeckFormat,
} from '../db/dataAccess.js';
import { addToWishlist } from '../db/dataAccess.js';
import { canBeCommander, checkDeckLegality, formatLabel, type LegalityReport } from '../deck/legality.js';
import { buildDeckText } from '../deck/deckText.js';
import { downloadText } from '../import/export.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import type { ResolvedLine, UnmatchedLine } from '../import/types.js';
import { useToast } from '../components/Toast.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem, type ViewMode } from '../components/CardViews.js';
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
import { useEscapeToClose } from '../components/useEscapeToClose.js';

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

export function DeckDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [showImport, setShowImport] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [exit, setExit] = useState<MissingCard[] | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [view, setView] = useViewMode();
  const [sort, setSort] = useCardSort('deck', { group: 'type' });
  const [info, setInfo] = useState<{ card: Priced<OracleCard>; deckCard: { id: string; quantity: number; scryfallId?: string } } | null>(null);
  // Escape on the exit sheet = "skip" (same as clicking the backdrop).
  useEscapeToClose(exit ? () => navigate('/decks') : null);

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

  const legality = useMemo<LegalityReport>(
    () =>
      checkDeckLegality(
        data?.deck?.format,
        (data?.rows ?? []).map((r) => ({ oracleId: r.oracleId, quantity: r.quantity, board: r.board, oracle: r.oracle })),
      ),
    [data],
  );

  if (data === undefined) return <div className="page">Loading…</div>;
  if (!data.deck) return <div className="page">Deck not found.</div>;
  const deck = data.deck;
  const isCommander = (deck.format ?? 'casual') === 'commander';
  const commander = sortRows(data.rows.filter((r) => r.board === 'commander'), sort);
  const main = sortRows(data.rows.filter((r) => r.board === 'main'), sort);
  const side = sortRows(data.rows.filter((r) => r.board === 'side'), sort);

  async function goBack() {
    const candidates = await computeDeckWishlistCandidates(id);
    if (candidates.length) setExit(candidates);
    else navigate('/decks');
  }

  async function addMissingToWishlist(candidates: MissingCard[]) {
    for (const c of candidates) await addToWishlist({ oracleId: c.oracleId, scryfallId: null, quantity: c.addQty });
    toast(`Added ${candidates.length} card${candidates.length === 1 ? '' : 's'} to wishlist`);
    navigate('/decks');
  }

  function exportDeck() {
    const text = buildDeckText(
      main.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      side.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
      commander.map((r) => ({ name: r.oracle?.name ?? '', quantity: r.quantity })),
    );
    downloadText(`${deck.name.replace(/[^\w-]+/g, '_')}.txt`, text);
    toast('Exported deck');
  }

  return (
    <section className="page">
      <div className="deck-head">
        <button className="linklike" onClick={goBack}>
          ‹ Decks
        </button>
        <OptionsMenu
          label="Deck options"
          actions={[
            { label: 'Scan cards', icon: '📷', onClick: () => setScanning(true) },
            { label: 'Import list', icon: '⬆', onClick: () => setShowImport((v) => !v) },
            { label: 'Export', icon: '⬇', onClick: exportDeck },
            {
              label: 'Delete deck',
              icon: '🗑',
              danger: true,
              onClick: async () => {
                if (!window.confirm(`Delete “${deck.name}”? This can’t be undone.`)) return;
                await deleteDeck(id);
                navigate('/decks');
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
        aria-label="Deck name"
      />

      <div className="deck-meta">
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
        <p className="search-meta">
          You own <strong>{summary.have}</strong> of <strong>{summary.need}</strong> cards
        </p>
      </div>

      <LegalityPanel report={legality} format={deck.format ?? 'casual'} />

      <div className="list-toolbar">
        <p className="search-meta grow">Search above to add cards to this deck.</p>
        <SortControls prefs={sort} onChange={setSort} groups />
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {showImport && (
        <ImportPanel
          deckId={id}
          onDone={(added) => {
            setShowImport(false);
            toast(`Added ${added} cards to the deck`);
          }}
        />
      )}

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

      {info && <CardSheet oracleCard={info.card} deckCard={info.deckCard} onClose={() => setInfo(null)} />}

      {scanning && (
        <ScanSheet
          target={{ kind: 'deck', deckId: id, deckName: deck.name, format: deck.format }}
          onClose={() => setScanning(false)}
        />
      )}

      {exit && (
        <div className="sheet-backdrop" onClick={() => navigate('/decks')}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add missing cards to wishlist">
            <h2 style={{ margin: 0 }}>Add missing cards to wishlist?</h2>
            <p className="fine-print">
              This deck needs {exit.reduce((s, c) => s + c.addQty, 0)} card{exit.length === 1 ? '' : 's'} you don’t own and
              haven’t wishlisted:
            </p>
            <ul className="result-list" style={{ maxHeight: '40dvh', overflowY: 'auto' }}>
              {exit.map((c) => (
                <li key={c.oracleId} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
                  <div className="result-main">
                    <div className="result-name">
                      {c.name} {c.addQty !== 1 && <span className="badge">×{c.addQty}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="sheet-actions">
              <button onClick={() => navigate('/decks')}>Skip</button>
              <button className="primary" onClick={() => addMissingToWishlist(exit)}>
                Add {exit.length} to wishlist
              </button>
            </div>
          </div>
        </div>
      )}
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
  onEdit: (target: { card: Priced<OracleCard>; deckCard: { id: string; quantity: number; scryfallId?: string } }) => void;
  /** Commander-format deck: show move-to/from-command-zone actions. */
  commanderDeck?: boolean;
  /** A commander is already in the command zone: hide "make commander" actions. */
  hasCommander?: boolean;
  emptyHint?: string;
}) {
  if (rows.length === 0 && title === 'Sideboard') return null;
  const count = rows.reduce((s, r) => s + r.quantity, 0);
  const toItem = (r: Row): CardItem => {
    const owned = r.owned >= r.quantity;
    const issue = issues.get(r.oracleId);
    return {
      key: r.id,
      name: r.oracle?.name ?? '(unknown card)',
      image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
      count: r.quantity,
      badge: issue ? '⚠' : owned ? '✓' : undefined,
      badgeClass: issue ? 'badge-illegal' : 'badge-owned',
      badgeTitle: issue,
      dim: !owned,
      sub: (
        <>
          owned {r.owned}
          {issue && <span className="badge badge-illegal-chip">{issue}</span>}
        </>
      ),
      onClick: r.oracle
        ? () => onEdit({ card: r.oracle!, deckCard: { id: r.id, quantity: r.quantity, scryfallId: r.scryfallId } })
        : undefined,
      actions: (
        <>
          {commanderDeck &&
            (r.board === 'commander' ? (
              <button onClick={() => moveDeckCard(r.id, 'main')} aria-label="Move to mainboard" title="Move to mainboard">↓</button>
            ) : !hasCommander && r.oracle && canBeCommander(r.oracle) ? (
              <button onClick={() => moveDeckCard(r.id, 'commander')} aria-label="Make commander" title="Make commander">♛</button>
            ) : null)}
          <button onClick={() => setDeckCardQuantity(r.id, r.quantity - 1)} aria-label="One fewer">−</button>
          <button onClick={() => setDeckCardQuantity(r.id, r.quantity + 1)} aria-label="One more">＋</button>
          <button onClick={() => removeDeckCard(r.id)} aria-label="Remove">✕</button>
        </>
      ),
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
  const makeResolved = (u: UnmatchedLine, card: OracleCard): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId: card.defaultScryfallId,
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
