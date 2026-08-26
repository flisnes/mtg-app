import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from './Page.js';
import { APP_VERSION } from '../version.js';
import { getSetting } from '../db/settings.js';
import { CHANGELOG_RECENT, loadChangelog, type ChangelogEntry } from '../changelog.js';
import { ChangelogList } from '../components/WhatsNewModal.js';
import { Sheet } from '../components/Sheet.js';

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function About() {
  const [cardDbVersion, setCardDbVersion] = useState<string>();
  const [pricesUpdatedAt, setPricesUpdatedAt] = useState<string>();
  const [counts, setCounts] = useState<{ oracle: number; printings: number }>();
  const [showChangelog, setShowChangelog] = useState(false);
  // The full history lives in its own chunk (changelogArchive.ts). Fetch it
  // when the sheet is asked for; until it lands the recent slice stands in.
  const [fullChangelog, setFullChangelog] = useState<ChangelogEntry[]>();

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
        <dd>
          {/* The version box doubles as the way into the bundled release notes:
              the same list the after-update popup shows, all of it. */}
          <button
            className="version-box"
            onClick={() => {
              setShowChangelog(true);
              void loadChangelog().then(setFullChangelog);
            }}
          >
            {APP_VERSION}
            <span className="fine-print">What’s changed</span>
          </button>
        </dd>
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
          Sealed product contents come from <a href="https://mtgjson.com">MTGJSON</a>, used under{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Sealed prices come from the TCGplayer
          catalogue via <a href="https://tcgcsv.com">TCGCSV</a> and from{' '}
          <a href="https://www.cardmarket.com">Cardmarket</a>’s published price guide. Exchange rates are European
          Central Bank reference rates via{' '}
          <a href="https://frankfurter.dev">Frankfurter</a>.
        </p>
        <p className="fine-print">
          Set and mana symbols are the Keyrune and Mana fonts by Andrew Gioia, used under the SIL Open Font License 1.1.
        </p>
        <p className="fine-print">
          Portions of the materials are property of Wizards of the Coast. This is unofficial Fan Content permitted under
          the{' '}
          <a href="https://company.wizards.com/en/legal/fancontentpolicy">Wizards of the Coast Fan Content Policy</a>.
          Not approved or endorsed by Wizards. © Wizards of the Coast LLC.
        </p>
        <p className="fine-print">
          <Link to="/licenses">Open source licenses</Link>
        </p>
      </section>

      {showChangelog && (
        <Sheet onClose={() => setShowChangelog(false)} title="What’s changed">
          <ChangelogList entries={fullChangelog ?? CHANGELOG_RECENT} />
          <div className="sheet-actions">
            <button className="primary" onClick={() => setShowChangelog(false)}>
              Close
            </button>
          </div>
        </Sheet>
      )}
    </Page>
  );
}
