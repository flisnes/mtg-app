import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { useToast } from '../components/Toast.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import { ImportDefaultsRow, IMPORT_DEFAULTS } from '../import/ImportExtras.js';
import { describeFiling, useIntakeReview } from '../import/intake/useIntakeReview.js';
import type { ImportDefaults, ResolvedLine, TradelistMode, UnmatchedLine } from '../import/types.js';

export function Import() {
  const [text, setText] = useState('');
  const [tradelistMode, setTradelistMode] = useState<TradelistMode>('none');
  // What lines that don't say for themselves are taken to be — the scanner's
  // pile pins, for a pasted list.
  const [defaults, setDefaults] = useState<ImportDefaults>(IMPORT_DEFAULTS);
  const { status, analyze, reset } = useImportAnalysis();
  // Cards already in the collection, where they should live, and whether a copy
  // moved: one questionnaire, asked after the review and before anything is written.
  const { open: review, sheet: intakeSheet } = useIntakeReview();
  const toast = useToast();
  const navigate = useNavigate();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content, { tradelistMode, defaults });
  }

  async function confirmImport(lines: ResolvedLine[]) {
    const res = await review({ flow: 'collection', lines, source: 'import', incomingLabel: 'Import' });
    if (!res) return; // backed out — nothing written, the review is still there
    if (res.added === 0) {
      toast('Nothing imported: every card was skipped');
      navigate('/collection');
      return;
    }
    toast(
      `Imported ${res.added} card${res.added === 1 ? '' : 's'} (${res.entries} entries${
        res.skipped > 0 ? `, ${res.skipped} skipped` : ''
      })${describeFiling(res)}`,
    );
    navigate('/collection');
  }

  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: tradelistMode === 'all' ? u.quantity : 0,
    condition: defaults.condition,
    finish: u.finish ?? defaults.finish,
    lang: defaults.lang,
  });

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
          <ImportDefaultsRow value={defaults} onChange={setDefaults} />
          <div className="list-toolbar">
            <button className="primary" onClick={() => analyze(text, { tradelistMode, defaults })} disabled={!text.trim()}>
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
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={confirmImport}
          onCancel={reset}
          extraSummary={(lines) => {
            const forTrade = lines.reduce((s, l) => s + l.quantityForTrade, 0);
            return (
              <>
                <dt>For trade</dt>
                <dd>{forTrade === 0 ? 'nothing' : `${forTrade} cards`}</dd>
              </>
            );
          }}
        />
      )}
      {intakeSheet}
    </Page>
  );
}
