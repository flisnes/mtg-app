import { useEffect, useState } from 'react';
import { CHANGELOG, type ChangeKind, type ChangelogEntry } from '../changelog.js';
import { APP_VERSION } from '../version.js';
import { isNewer } from '../appUpdate.js';
import { getSetting, setSetting } from '../db/settings.js';
import { Sheet } from './Sheet.js';

const KIND_LABEL: Record<ChangeKind, string> = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  removed: 'Removed',
};

/**
 * "What's changed" popup, shown once after an update. Compares the last
 * version this device has caught up on (settings.lastSeenAppVersion) against
 * the running build and returns every changelog entry in between.
 *
 * A device with nothing stored yet — a fresh install, or an existing install
 * updating to the first build that tracks this — has no known baseline to
 * catch up from, so it quietly adopts the current version instead of showing
 * a popup. The stored version only advances past a non-empty list once
 * `dismiss` is called, so leaving mid-session (closing the tab, say) means
 * the popup is still waiting next launch.
 */
export function useWhatsNew(): { entries: ChangelogEntry[]; dismiss: () => void } | null {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);

  useEffect(() => {
    void (async () => {
      const seen = await getSetting<string>('lastSeenAppVersion');
      if (seen !== undefined && isNewer(APP_VERSION, seen)) {
        const missed = CHANGELOG.filter((e) => isNewer(e.version, seen) && !isNewer(e.version, APP_VERSION));
        if (missed.length > 0) {
          setEntries(missed);
          return;
        }
      }
      await setSetting('lastSeenAppVersion', APP_VERSION);
    })();
  }, []);

  function dismiss() {
    setEntries(null);
    void setSetting('lastSeenAppVersion', APP_VERSION);
  }

  return entries ? { entries, dismiss } : null;
}

export function WhatsNewModal({ entries, onClose }: { entries: ChangelogEntry[]; onClose: () => void }) {
  return (
    <Sheet onClose={onClose} title="What’s changed">
      <ul className="whats-new-list">
        {entries.map((entry) => (
          <li key={entry.version}>
            <div className="whats-new-version">{entry.version}</div>
            <ul className="whats-new-changes">
              {entry.changes.map((change, i) => (
                <li key={i}>
                  <strong>{KIND_LABEL[change.kind]}:</strong> {change.text}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </Sheet>
  );
}
