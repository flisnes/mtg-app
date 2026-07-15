import { useState, type ReactNode } from 'react';
import type { OracleCard } from '@mtg/shared';
import { resolveOracleByName } from '../cardDb/search.js';
import { useCardSearch } from '../cardDb/useCardSearch.js';
import type { ResolveResult, ResolvedLine, UnmatchedLine } from './types.js';

// Reusable import review screen (beta plan §5). Shows the resolve worker's
// result — matched count plus every unmatched line with typo suggestions and a
// search box to fix it by hand — then hands the final resolved lines back to
// the caller. Callers decide what a resolved line becomes (collection entry vs
// deck slot) via `makeResolved` and `onConfirm`.

export function ImportReview({
  result,
  makeResolved,
  onConfirm,
  onCancel,
  confirmLabel = (n) => `Import ${n} entries`,
  extraSummary,
}: {
  result: ResolveResult;
  /** Turn a hand-picked card for an unmatched line into a resolved line. */
  makeResolved: (u: UnmatchedLine, card: OracleCard) => ResolvedLine;
  onConfirm: (lines: ResolvedLine[]) => void | Promise<void>;
  onCancel: () => void;
  confirmLabel?: (count: number) => string;
  /** Optional target-specific summary rows (e.g. collection's "For trade"). */
  extraSummary?: (lines: ResolvedLine[]) => ReactNode;
}) {
  // Manually-resolved unmatched lines, keyed by their index.
  const [fixed, setFixed] = useState<Map<number, ResolvedLine>>(new Map());
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const resolve = (index: number, card: OracleCard) => {
    setFixed((m) => new Map(m).set(index, makeResolved(result.unmatched[index]!, card)));
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
        {extraSummary?.(allLines)}
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
        <button onClick={onCancel} disabled={busy}>Back</button>
        <button
          className="primary"
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm(allLines);
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy || allLines.length === 0}
        >
          {busy ? 'Importing…' : confirmLabel(allLines.length)}
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
