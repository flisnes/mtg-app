import { useEffect, useState } from 'react';
import { Page } from './Page.js';
import { APP_VERSION } from '../version.js';
import { DataTransfer } from '../components/DataTransfer.js';
import { deleteAllUserData } from '../db/dataAccess.js';
import { getSetting } from '../db/settings.js';
import { setGoblinMode, useGoblinMode } from '../components/useGoblinMode.js';
import { formatDiagnostics } from '../errorLog.js';

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function About() {
  const goblinMode = useGoblinMode();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [cardDbVersion, setCardDbVersion] = useState<string>();
  const [pricesUpdatedAt, setPricesUpdatedAt] = useState<string>();
  const [counts, setCounts] = useState<{ oracle: number; printings: number }>();

  useEffect(() => {
    void (async () => {
      // cardDbUpdatedAt is the human-readable bulk timestamp; older installs
      // only have the (formerly timestamp-shaped) cardDbVersion.
      setCardDbVersion((await getSetting<string>('cardDbUpdatedAt')) ?? (await getSetting<string>('cardDbVersion')));
      setPricesUpdatedAt(await getSetting<string>('pricesUpdatedAt'));
      setCounts(await getSetting<{ oracle: number; printings: number }>('cardDbCounts'));
    })();
  }, []);

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
        <dd>{cardDbVersion ? formatDate(cardDbVersion) : 'not loaded'}</dd>
        <dt>Cards</dt>
        <dd>{counts ? `${counts.oracle.toLocaleString()} cards · ${counts.printings.toLocaleString()} printings` : '—'}</dd>
        <dt>Prices updated</dt>
        <dd>{formatDate(pricesUpdatedAt)}</dd>
      </dl>

      <section className="about-section">
        <h2>Goblin mode</h2>
        <p className="fine-print">
          Adds a third way to view your collection: one big, unsorted pile. Shove cards around with your finger to dig
          through it, double-tap a card to flip it over, and press and hold one for its details. Sorting and filtering
          are for humans.
        </p>
        <label className="agree-row">
          <input type="checkbox" checked={goblinMode} onChange={(e) => void setGoblinMode(e.target.checked)} />
          <span>Enable goblin mode</span>
        </label>
      </section>

      <section className="about-section">
        <h2>Your data</h2>
        <p className="fine-print">
          Everything is stored on this device. The server only keeps a copy if you create an account and back up
          (More → Account &amp; sync). Trades themselves always live on your device. Clearing your browser data will
          erase your collection, so export regularly or keep a backup.
        </p>
        <p className="fine-print">
          Moving to a new phone or browser? Transfer your collection, lists and decks with a one-time code. The data
          goes straight to the other device and is never stored on the server.
        </p>
        <DataTransfer />
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
        <h2>Having trouble?</h2>
        <p className="fine-print">
          If something breaks, copy the diagnostic log and send it along — it includes recent errors and your app/device
          version, but no card data.
        </p>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(formatDiagnostics());
          }}
        >
          Copy diagnostic log
        </button>
      </section>

      <section className="about-section">
        <h2>Attribution</h2>
        <p className="fine-print">
          Card data and images are provided by <a href="https://scryfall.com">Scryfall</a>. Prices are sourced from
          Scryfall bulk data and may be up to 24 hours stale. Your collection’s price history is recorded
          automatically each time you open the app — tap any card to see its trend.
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
