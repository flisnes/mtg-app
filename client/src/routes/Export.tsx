import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { buildCollectionCsv, downloadText } from '../import/export.js';
import { useToast } from '../components/Toast.js';

export function Export() {
  const count = useLiveQuery(() => db.collection.count(), []);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function exportCsv() {
    setBusy(true);
    const csv = await buildCollectionCsv();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`mtg-collection-${stamp}.csv`, csv);
    setBusy(false);
    toast('Exported collection');
  }

  return (
    <Page title="Export" subtitle="Download your collection so you always have your data.">
      <p className="fine-print">
        Exports a lossless CSV (set, collector number, condition, finish, language, quantities, Scryfall id). It
        re-imports here and is compatible with Moxfield-style tools.
      </p>
      <button className="primary" onClick={exportCsv} disabled={busy || !count}>
        {busy ? 'Preparing…' : `Download collection (${count ?? 0} entries)`}
      </button>
    </Page>
  );
}
