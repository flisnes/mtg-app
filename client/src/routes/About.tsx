import { useState } from 'react';
import { Page } from './Page.js';
import { APP_VERSION } from '../version.js';
import { deleteAllUserData } from '../db/dataAccess.js';

export function About() {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  async function handleDelete() {
    await deleteAllUserData();
    setConfirming(false);
    setDone(true);
  }

  return (
    <Page title="About & settings">
      <dl className="kv">
        <dt>App version</dt>
        <dd>{APP_VERSION}</dd>
        <dt>Card database</dt>
        <dd>not loaded yet (Phase 1)</dd>
      </dl>

      <section className="about-section">
        <h2>Your data</h2>
        <p className="fine-print">
          Everything is stored only on this device. The trade server never stores your data — trades live on your
          device. Clearing your browser data will erase your collection, so export regularly (Phase 2).
        </p>
        {done ? (
          <p role="status">All local data deleted.</p>
        ) : confirming ? (
          <div className="confirm-row">
            <button className="danger" onClick={handleDelete}>
              Yes, delete everything
            </button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <button className="danger-outline" onClick={() => setConfirming(true)}>
            Delete all my data
          </button>
        )}
      </section>

      <section className="about-section">
        <h2>Attribution</h2>
        <p className="fine-print">
          Card data and images are provided by <a href="https://scryfall.com">Scryfall</a>. Prices are sourced from
          Scryfall bulk data and may be up to 24 hours stale.
        </p>
        <p className="fine-print">
          Portions of the materials are property of Wizards of the Coast. This is unofficial Fan Content permitted under
          the{' '}
          <a href="https://company.wizards.com/en/legal/fancontentpolicy">Wizards of the Coast Fan Content Policy</a>.
          Not approved or endorsed by Wizards. © Wizards of the Coast LLC.
        </p>
      </section>
    </Page>
  );
}
