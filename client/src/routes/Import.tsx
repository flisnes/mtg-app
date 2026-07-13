import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { applyImport, type ImportLine } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';
import { resolveOracleByName } from '../cardDb/search.js';
import { useCardSearch } from '../cardDb/useCardSearch.js';
import type { ResolveResponse, ResolveResult, ResolvedLine, TradelistMode, UnmatchedLine } from '../import/types.js';

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; fraction: number }
  | { kind: 'review'; result: ResolveResult }
  | { kind: 'error'; message: string };

export function Import() {
  const [text, setText] = useState('');
  const [tradelistMode, setTradelistMode] = useState<TradelistMode>('none');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const workerRef = useRef<Worker | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  // Kill any in-flight analysis when leaving the screen (or re-analyzing).
  useEffect(() => () => workerRef.current?.terminate(), []);

  function analyze(input: string) {
    if (!input.trim()) return;
    setStatus({ kind: 'working', label: 'Starting…', fraction: 0 });
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../import/resolve.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<ResolveResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') setStatus({ kind: 'working', label: msg.label, fraction: msg.fraction });
      else if (msg.type === 'done') {
        setStatus({ kind: 'review', result: msg.result });
        worker.terminate();
      } else {
        setStatus({ kind: 'error', message: msg.message });
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      setStatus({ kind: 'error', message: e.message || 'import worker crashed' });
      worker.terminate();
    };
    worker.postMessage({ text: input, tradelistMode });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content);
  }

  async function confirmImport(lines: ImportLine[]) {
    const res = await applyImport(lines);
    toast(`Imported ${res.cards} cards (${res.entries} entries)`);
    navigate('/collection');
  }

  return (
    <Page title="Import" subtitle="Paste a list or upload a CSV, Moxfield, Archidekt, or plain text.">
      {status.kind === 'idle' || status.kind === 'error' ? (
        <>
          {status.kind === 'error' && <p className="gate-error">Error: {status.message}</p>}
          <textarea
            className="search-input"
            style={{ minHeight: 160, fontFamily: 'ui-monospace, monospace' }}
            placeholder={'4 Lightning Bolt\n1 Sol Ring (C21) 263\n…or paste a Moxfield/Archidekt CSV'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="chip" style={{ alignSelf: 'flex-start' }}>
            Tradelist:{' '}
            <select value={tradelistMode} onChange={(e) => setTradelistMode(e.target.value as TradelistMode)}>
              <option value="none">don’t mark anything for trade</option>
              <option value="file">use tradelist counts from the file</option>
              <option value="all">mark all imported cards for trade</option>
            </select>
          </label>
          <div className="list-toolbar">
            <button className="primary" onClick={() => analyze(text)} disabled={!text.trim()}>
              Analyze
            </button>
            <input type="file" accept=".csv,.txt,text/*" onChange={onFile} />
          </div>
        </>
      ) : status.kind === 'working' ? (
        <>
          <p className="gate-msg">{status.label}</p>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round(status.fraction * 100)}%` }} />
          </div>
        </>
      ) : (
        <ReviewScreen
          result={status.result}
          tradelistMode={tradelistMode}
          onConfirm={confirmImport}
          onCancel={() => setStatus({ kind: 'idle' })}
        />
      )}
    </Page>
  );
}

function toResolved(u: UnmatchedLine, card: OracleCard, tradelistMode: TradelistMode): ResolvedLine {
  return {
    oracleId: card.oracleId,
    scryfallId: card.defaultScryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: tradelistMode === 'all' ? u.quantity : 0,
    condition: 'NM',
    finish: u.finish ?? 'nonfoil',
    lang: 'en',
  };
}

function ReviewScreen({
  result,
  tradelistMode,
  onConfirm,
  onCancel,
}: {
  result: ResolveResult;
  tradelistMode: TradelistMode;
  onConfirm: (lines: ImportLine[]) => void;
  onCancel: () => void;
}) {
  // Manually-resolved unmatched lines, keyed by their index.
  const [fixed, setFixed] = useState<Map<number, ResolvedLine>>(new Map());
  const [picking, setPicking] = useState<number | null>(null);

  const resolve = (index: number, card: OracleCard) => {
    setFixed((m) => new Map(m).set(index, toResolved(result.unmatched[index]!, card, tradelistMode)));
    setPicking(null);
  };
  const unfix = (index: number) =>
    setFixed((m) => {
      const next = new Map(m);
      next.delete(index);
      return next;
    });

  const allLines = [...result.resolved, ...fixed.values()];
  const stillUnmatched = result.unmatched.length - fixed.size;
  const forTrade = allLines.reduce((s, l) => s + l.quantityForTrade, 0);

  return (
    <>
      <dl className="kv">
        <dt>Detected format</dt>
        <dd>{result.format}</dd>
        <dt>Matched</dt>
        <dd>
          {allLines.length} entries{fixed.size > 0 ? ` (${fixed.size} fixed by hand)` : ''}
        </dd>
        <dt>Unmatched</dt>
        <dd>{stillUnmatched}</dd>
        <dt>For trade</dt>
        <dd>{forTrade === 0 ? 'nothing' : `${forTrade} cards`}</dd>
      </dl>

      {result.unmatched.length > 0 && (
        <div className="about-section">
          <h2>Unmatched lines</h2>
          <p className="fine-print">Tap a suggestion or search to fix a line so it imports with the rest.</p>
          <ul className="result-list">
            {result.unmatched.map((u, i) => {
              const chosen = fixed.get(i);
              return (
                <li key={i} className="result-row" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '0.6rem', gap: '0.4rem' }}>
                  <div className="result-main">
                    <div className="result-name">
                      {u.quantity}× {u.name}
                      {chosen && <span className="badge badge-trade">→ {chosen.name}</span>}
                    </div>
                    <div className="result-sub" style={{ whiteSpace: 'normal' }}>{u.raw}</div>
                  </div>

                  {chosen ? (
                    <button onClick={() => unfix(i)} style={{ alignSelf: 'flex-start' }}>
                      Undo fix
                    </button>
                  ) : (
                    <div className="chips">
                      {u.suggestions.map((s) => (
                        <button
                          key={s}
                          className="chip"
                          onClick={async () => {
                            const card = await resolveOracleByName(s);
                            if (card) resolve(i, card);
                          }}
                        >
                          {s}
                        </button>
                      ))}
                      <button className="chip" onClick={() => setPicking(picking === i ? null : i)}>
                        🔍 Search…
                      </button>
                    </div>
                  )}

                  {picking === i && !chosen && <CardPicker onPick={(card) => resolve(i, card)} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="sheet-actions">
        <button onClick={onCancel}>Back</button>
        <button className="primary" onClick={() => onConfirm(allLines)} disabled={allLines.length === 0}>
          Import {allLines.length} entries
        </button>
      </div>
    </>
  );
}

function CardPicker({ onPick }: { onPick: (card: OracleCard) => void }) {
  const [q, setQ] = useState('');
  const { results } = useCardSearch(q, { limit: 12 });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <input
        className="search-input"
        placeholder="Search for the right card…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        // Enter picks the top match — usually the right one after a few letters.
        onKeyDown={(e) => e.key === 'Enter' && results[0] && onPick(results[0])}
        enterKeyHint="done"
        autoFocus
      />
      {results.length > 0 && (
        <ul className="result-list">
          {results.map((c) => (
            <li key={c.oracleId} className="result-row" style={{ padding: '0.4rem 0.6rem' }}>
              <button className="result-open" style={{ cursor: 'pointer' }} onClick={() => onPick(c)}>
                {c.imageSmall && <img className="result-thumb" src={c.imageSmall} alt="" loading="lazy" width={40} height={56} />}
                <div className="result-main">
                  <div className="result-name">{c.name}</div>
                  <div className="result-sub">{c.typeLine}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
