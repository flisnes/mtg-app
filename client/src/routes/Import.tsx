import { useNavigate } from 'react-router-dom';
import { Page } from './Page.js';
import { useToast } from '../components/Toast.js';
import { ImportPanel } from '../import/ImportPanel.js';
import { describeFiling, useIntakeReview } from '../import/intake/useIntakeReview.js';
import type { ResolvedLine } from '../import/types.js';
import { plural } from '../util/format.js';

export function Import() {
  // Cards already in the collection, where they should live, and whether a copy
  // moved: one questionnaire, asked after the review and before anything is written.
  const { open: review, sheet: intakeSheet } = useIntakeReview();
  const toast = useToast();
  const navigate = useNavigate();

  async function confirmImport(lines: ResolvedLine[]) {
    const res = await review({ flow: 'collection', lines, source: 'import', incomingLabel: 'Import' });
    if (!res) return; // backed out: nothing written, the review is still there
    if (res.added === 0) {
      toast('Nothing imported: every card was skipped');
      navigate('/collection');
      return;
    }
    toast(
      `Imported ${res.added} ${plural(res.added, 'card')} (${res.entries} entries${
        res.skipped > 0 ? `, ${res.skipped} skipped` : ''
      })${describeFiling(res)}`,
    );
    navigate('/collection');
  }

  return (
    <Page title="Import" subtitle="Paste a list or upload a CSV, Moxfield, Archidekt, or plain text.">
      <ImportPanel
        tradelistMode="choose"
        placeholder={'4 Lightning Bolt\n1 Sol Ring (C21) 263\n…or paste a Moxfield/Archidekt CSV'}
        onConfirm={confirmImport}
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
      {intakeSheet}
    </Page>
  );
}
