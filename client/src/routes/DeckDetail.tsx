import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router-dom';
import { DECK_FORMATS, type DeckBoard, type DeckFormat, type OracleCard } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getOwnedCountsFor, computeDeckWishlistCandidates, type MissingCard } from '../db/queries.js';
import {
  addDeckCard,
  addDeckCardsBulk,
  deleteDeck,
  removeDeckCard,
  renameDeck,
  setDeckCardQuantity,
  setDeckFormat,
} from '../db/dataAccess.js';
import { addToWishlist } from '../db/dataAccess.js';
import { checkDeckLegality, formatLabel, type LegalityReport } from '../deck/legality.js';
import { searchCards } from '../cardDb/search.js';
import { resolveDeckText, buildDeckText } from '../deck/deckText.js';
import { downloadText } from '../import/export.js';
import { useToast } from '../components/Toast.js';
import { CardGrid, ViewToggle, useViewMode, type GridItem, type ViewMode } from '../components/CardGrid.js';

interface Row {
  id: string;
  oracleId: string;
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
  owned: number;
}

export function DeckDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [panel, setPanel] = useState<'none' | 'add' | 'import'>('none');
  const [exit, setExit] = useState<MissingCard[] | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [view, setView] = useViewMode();

  const data = useLiveQuery(async () => {
    const deck = await db.decks.get(id);
    if (!deck) return { deck: null, rows: [] as Row[] };
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    const [oracleMap, owned] = await Promise.all([
      getOracleCardsByIds(cards.map((c) => c.oracleId)),
      getOwnedCountsFor(cards.map((c) => c.oracleId)),
    ]);
    const rows: Row[] = cards.map((c) => ({
      id: c.id,
      oracleId: c.oracleId,
      quantity: c.quantity,
      board: c.board,
      oracle: oracleMap.get(c.oracleId),
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
  const main = data.rows.filter((r) => r.board === 'main').sort(byName);
  const side = data.rows.filter((r) => r.board === 'side').sort(byName);

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
        <button className="danger-outline" onClick={async () => { await deleteDeck(id); navigate('/decks'); }}>
          Delete
        </button>
      </div>

      <input
        className="deck-name-input"
        value={nameDraft ?? deck.name}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => {
          if (nameDraft !== null && nameDraft !== deck.name) void renameDeck(id, nameDraft);
          setNameDraft(null);
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
        <button className={panel === 'add' ? 'primary' : ''} onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>
          ＋ Add cards
        </button>
        <button className={panel === 'import' ? 'primary' : ''} onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}>
          ⬆ Import list
        </button>
        <button onClick={exportDeck}>⬇ Export</button>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {panel === 'add' && <AddPanel deckId={id} onAdded={(n) => toast(`Added ${n}`)} />}
      {panel === 'import' && (
        <ImportPanel
          deckId={id}
          onDone={(added, unmatched) => {
            setPanel('none');
            toast(`Imported ${added} cards${unmatched ? `, ${unmatched} unmatched` : ''}`);
          }}
        />
      )}

      <Board title="Mainboard" rows={main} view={view} issues={legality.issues} />
      <Board title="Sideboard" rows={side} view={view} issues={legality.issues} />

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
                      {c.name} <span className="badge">×{c.addQty}</span>
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

function byName(a: Row, b: Row): number {
  return (a.oracle?.name ?? '').localeCompare(b.oracle?.name ?? '');
}

function LegalityPanel({ report, format }: { report: LegalityReport; format: DeckFormat }) {
  if (!report.checked) return <p className="fine-print">Casual — no legality checks.</p>;
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
  view,
  issues,
}: {
  title: string;
  rows: Row[];
  view: ViewMode;
  issues: Map<string, string>;
}) {
  if (rows.length === 0 && title === 'Sideboard') return null;
  const count = rows.reduce((s, r) => s + r.quantity, 0);
  return (
    <div className="about-section">
      <h2>
        {title} <span className="badge">{count}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="fine-print">Empty.</p>
      ) : view === 'grid' ? (
        <CardGrid
          items={rows.map((r): GridItem => {
            const owned = r.owned >= r.quantity;
            const issue = issues.get(r.oracleId);
            return {
              key: r.id,
              name: r.oracle?.name ?? '(unknown card)',
              image: r.oracle?.imageSmall ?? null,
              count: r.quantity,
              badge: issue ? '⚠' : owned ? '✓' : undefined,
              badgeClass: issue ? 'badge-illegal' : 'badge-owned',
              dim: !owned,
              footer: (
                <>
                  <button onClick={() => setDeckCardQuantity(r.id, r.quantity - 1)} aria-label="One fewer">−</button>
                  <button onClick={() => setDeckCardQuantity(r.id, r.quantity + 1)} aria-label="One more">＋</button>
                  <button onClick={() => removeDeckCard(r.id)} aria-label="Remove">✕</button>
                </>
              ),
            };
          })}
        />
      ) : (
        <ul className="result-list">
          {rows.map((r) => {
            const owned = r.owned >= r.quantity;
            return (
              <li key={r.id} className="result-row">
                <div className="result-open" style={{ cursor: 'default' }}>
                  <span className={`owned-check ${owned ? 'owned-yes' : 'owned-no'}`} aria-hidden>
                    {owned ? '✓' : '○'}
                  </span>
                  {r.oracle?.imageSmall ? (
                    <img className="result-thumb" src={r.oracle.imageSmall} alt="" loading="lazy" width={46} height={64} />
                  ) : (
                    <div className="result-thumb" aria-hidden />
                  )}
                  <div className="result-main">
                    <div className="result-name">
                      {r.oracle?.name ?? '(unknown card)'}
                      {issues.get(r.oracleId) && <span className="badge badge-illegal-chip">{issues.get(r.oracleId)}</span>}
                    </div>
                    <div className="result-sub">owned {r.owned}</div>
                  </div>
                </div>
                <div className="quick-actions">
                  <button onClick={() => setDeckCardQuantity(r.id, r.quantity - 1)} aria-label="One fewer">
                    −
                  </button>
                  <span className="qty-pill" style={{ padding: '0 0.4rem', alignSelf: 'center' }}>
                    {r.quantity}
                  </span>
                  <button onClick={() => setDeckCardQuantity(r.id, r.quantity + 1)} aria-label="One more">
                    ＋
                  </button>
                  <button onClick={() => removeDeckCard(r.id)} aria-label="Remove">
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddPanel({ deckId, onAdded }: { deckId: string; onAdded: (name: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<OracleCard[]>([]);
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const h = setTimeout(async () => setResults((await searchCards(q, {}, 20)).cards), 120);
    return () => clearTimeout(h);
  }, [q]);

  async function add(card: OracleCard, board: DeckBoard) {
    await addDeckCard({ deckId, oracleId: card.oracleId, board });
    onAdded(`${card.name}${board === 'side' ? ' (SB)' : ''}`);
  }

  return (
    <div className="about-section">
      <input className="search-input" placeholder="Search cards to add…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="result-list">
        {results.map((card) => (
          <li key={card.oracleId} className="result-row">
            <div className="result-open" style={{ cursor: 'default' }}>
              {card.imageSmall && <img className="result-thumb" src={card.imageSmall} alt="" loading="lazy" width={46} height={64} />}
              <div className="result-main">
                <div className="result-name">{card.name}</div>
                <div className="result-sub">{card.typeLine}</div>
              </div>
            </div>
            <div className="quick-actions">
              <button onClick={() => add(card, 'main')}>+Main</button>
              <button onClick={() => add(card, 'side')}>+SB</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImportPanel({ deckId, onDone }: { deckId: string; onDone: (added: number, unmatched: number) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const { resolved, unmatched } = await resolveDeckText(text);
    await addDeckCardsBulk(deckId, resolved);
    setBusy(false);
    onDone(resolved.reduce((s, r) => s + r.quantity, 0), unmatched.length);
  }

  return (
    <div className="about-section">
      <textarea
        className="search-input"
        style={{ minHeight: 140, fontFamily: 'ui-monospace, monospace' }}
        placeholder={'4 Lightning Bolt\n2 Counterspell\n\nSideboard\n3 Duress'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="primary" onClick={run} disabled={busy || !text.trim()}>
        {busy ? 'Importing…' : 'Import into deck'}
      </button>
    </div>
  );
}
