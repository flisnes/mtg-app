import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from './Page.js';
import { applyImport } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';
import type { ResolveResponse, ResolveResult } from '../import/types.js';

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; fraction: number }
  | { kind: 'review'; result: ResolveResult }
  | { kind: 'error'; message: string };

export function Import() {
  const [text, setText] = useState('');
  const [asTradelist, setAsTradelist] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const workerRef = useRef<Worker | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  function analyze(input: string) {
    if (!input.trim()) return;
    setStatus({ kind: 'working', label: 'Starting…', fraction: 0 });
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
    worker.postMessage({ text: input, asTradelist });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content);
  }

  async function confirmImport(result: ResolveResult) {
    const res = await applyImport(result.resolved);
    toast(`Imported ${res.cards} cards (${res.entries} entries)`);
    navigate('/collection');
  }

  return (
    <Page title="Import" subtitle="Paste a list or upload a CSV — Moxfield, Archidekt, or plain text.">
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
            <input type="checkbox" checked={asTradelist} onChange={(e) => setAsTradelist(e.target.checked)} /> Also add to tradelist
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
        <ReviewScreen result={status.result} onConfirm={confirmImport} onCancel={() => setStatus({ kind: 'idle' })} />
      )}
    </Page>
  );
}

function ReviewScreen({
  result,
  onConfirm,
  onCancel,
}: {
  result: ResolveResult;
  onConfirm: (r: ResolveResult) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <dl className="kv">
        <dt>Detected format</dt>
        <dd>{result.format}</dd>
        <dt>Matched</dt>
        <dd>
          {result.resolved.length} entries · {result.resolvedQuantity} cards
        </dd>
        <dt>Unmatched</dt>
        <dd>{result.unmatched.length}</dd>
      </dl>

      {result.unmatched.length > 0 && (
        <div className="about-section">
          <h2>Unmatched lines</h2>
          <p className="fine-print">These won’t be imported. Check spelling or set codes and re-import them.</p>
          <ul className="result-list">
            {result.unmatched.slice(0, 100).map((u, i) => (
              <li key={i} className="result-row" style={{ padding: '0.5rem' }}>
                <div className="result-main">
                  <div className="result-name">{u.name}</div>
                  {u.suggestions.length > 0 && <div className="result-sub">Did you mean: {u.suggestions.join(', ')}?</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="sheet-actions">
        <button onClick={onCancel}>Back</button>
        <button className="primary" onClick={() => onConfirm(result)} disabled={result.resolved.length === 0}>
          Import {result.resolved.length} entries
        </button>
      </div>
    </>
  );
}
