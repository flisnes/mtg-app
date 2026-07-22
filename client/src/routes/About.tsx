import { useEffect, useState } from 'react';
import { Page } from './Page.js';
import { APP_VERSION } from '../version.js';
import { getSetting } from '../db/settings.js';

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function About() {
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

  return (
    <Page title="About">
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
        <h2>Attribution</h2>
        <p className="fine-print">
          Card data and images are provided by <a href="https://scryfall.com">Scryfall</a>. Prices are sourced from
          Scryfall bulk data and may be up to 24 hours stale. Your collection’s price history is recorded
          automatically each time you open the app. Tap any card to see its trend.
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
