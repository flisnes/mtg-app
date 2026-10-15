import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OracleCard } from '@mtg/shared';
import { Icon } from '../components/icons.js';
import { useImportAnalysis } from './useImportAnalysis.js';
import { ImportReview } from './ImportReview.js';
import { ImportDefaultsRow, IMPORT_DEFAULTS } from './ImportExtras.js';
import type { ImportDefaults, ResolvedLine, TradelistMode, UnmatchedLine } from './types.js';

const DEFAULT_PLACEHOLDER = '4 Lightning Bolt\n1 Sol Ring (C21) 263\n…or paste a Moxfield/Archidekt list';

/**
 * Paste or upload a list, analyze it, review the matches. One panel for every
 * place a list comes in (collection Import, Tradelist, Wishlist, a deck); each
 * caller only says what confirming means.
 */
export function ImportPanel({
  intro,
  placeholder = DEFAULT_PLACEHOLDER,
  showCondition = true,
  tradelistMode = 'none',
  board = false,
  initialText,
  aboveReview,
  confirmLabel,
  extraSummary,
  onConfirm,
}: {
  intro?: ReactNode;
  placeholder?: string;
  /** Wishes are for a printing, not a graded copy, so the wishlist hides condition. */
  showCondition?: boolean;
  /** A fixed mode, or 'choose' to let the user pick (the collection Import). */
  tradelistMode?: TradelistMode | 'choose';
  /** Keep each line's board (main/side/...): a deck cares, a collection doesn't. */
  board?: boolean;
  /** A list that arrived on the clipboard: filled in and analyzed on sight.
   *  Key the panel on this text upstream so a second paste remounts and runs again. */
  initialText?: string;
  /** Shown over the review, e.g. "already in this deck". */
  aboveReview?: (resolved: ResolvedLine[]) => ReactNode;
  confirmLabel?: (count: number) => string;
  extraSummary?: (lines: ResolvedLine[]) => ReactNode;
  onConfirm: (lines: ResolvedLine[]) => void | Promise<void>;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [chosenMode, setChosenMode] = useState<TradelistMode>('none');
  // What lines that don't say for themselves are taken to be: the scanner's
  // pile pins, for a pasted list.
  const [defaults, setDefaults] = useState<ImportDefaults>(IMPORT_DEFAULTS);
  const { status, analyze, reset } = useImportAnalysis();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const mode = tradelistMode === 'choose' ? chosenMode : tradelistMode;

  const run = (content: string) => analyze(content, { tradelistMode: mode, defaults });

  // Mounted with pasted text: straight to the review.
  //
  // Deliberately not guarded by a "did this already" ref. StrictMode mounts,
  // unmounts and remounts in development, and useImportAnalysis kills its
  // worker on unmount: a guard would let the first run be terminated and stop
  // the second from ever starting, leaving the panel stuck on "Starting…".
  // Running again is harmless: analyze() terminates the previous worker itself.
  useEffect(() => {
    if (!initialText?.trim()) return;
    run(initialText);
    // `defaults` is read once, at the moment the paste lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again should still fire
    if (!file) return;
    const content = await file.text();
    setText(content);
    run(content);
  }

  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: mode === 'all' ? u.quantity : 0,
    condition: defaults.condition,
    finish: u.finish ?? defaults.finish,
    lang: defaults.lang,
    ...(board ? { board: u.board ?? 'main' } : {}),
  });

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

  if (status.kind === 'review') {
    return (
      <div className="about-section">
        {aboveReview?.(status.result.resolved)}
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={onConfirm}
          onCancel={reset}
          {...(confirmLabel ? { confirmLabel } : {})}
          {...(extraSummary ? { extraSummary } : {})}
        />
      </div>
    );
  }

  return (
    <div className="about-section import-panel">
      {status.kind === 'error' && <p className="gate-error">Error: {status.message}</p>}
      {intro && <p className="fine-print">{intro}</p>}
      <textarea
        className="search-input import-text"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="List to import"
      />
      <ImportDefaultsRow
        value={defaults}
        onChange={setDefaults}
        showCondition={showCondition}
        before={
          tradelistMode === 'choose' && (
            <label className="import-field import-field-wide">
              <span>Tradelist</span>
              <select value={chosenMode} onChange={(e) => setChosenMode(e.target.value as TradelistMode)}>
                <option value="none">Don't mark anything for trade</option>
                <option value="file">Use tradelist counts from the file</option>
                <option value="all">Mark every imported card for trade</option>
              </select>
            </label>
          )
        }
      />
      <div className="import-actions">
        <input ref={fileRef} type="file" accept=".csv,.txt,text/*" onChange={onFile} hidden />
        <button onClick={() => fileRef.current?.click()}>
          <Icon name="import" size={16} /> Upload file
        </button>
        <button className="primary" onClick={() => run(text)} disabled={!text.trim()}>
          Analyze
        </button>
      </div>
    </div>
  );
}
