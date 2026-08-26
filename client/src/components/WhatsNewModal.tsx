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
 * A brand-new install stamps its baseline the moment onboarding completes
 * (see App.tsx), before AppShell — and this hook — ever mounts. So if
 * `lastSeenAppVersion` is still unset by the time this runs, that's not a
 * fresh install; it's an existing one updating to the first build that
 * tracks this. Every real install is already past changelog.ts's oldest
 * entry, so the full bundled list is the correct thing to show it (rather
 * than silently skipping, which is what shipped in 0.100.0 and meant nobody
 * saw that release's own entry).
 *
 * The stored version only advances past a non-empty list once `dismiss` is
 * called, so leaving mid-session (closing the tab, say) means the popup is
 * still waiting next launch.
 */
export function useWhatsNew(): { entries: ChangelogEntry[]; dismiss: () => void } | null {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);

  useEffect(() => {
    void (async () => {
      const seen = await getSetting<string>('lastSeenAppVersion');
      const missed =
        seen === undefined
          ? CHANGELOG.filter((e) => !isNewer(e.version, APP_VERSION))
          : isNewer(APP_VERSION, seen)
            ? CHANGELOG.filter((e) => isNewer(e.version, seen) && !isNewer(e.version, APP_VERSION))
            : [];
      if (missed.length > 0) {
        setEntries(missed);
        return;
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

/**
 * The scrollable version-by-version list. Shared by the after-update popup and
 * the full history sheet the About page's version box opens.
 */
export function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  return (
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
  );
}

export function WhatsNewModal({ entries, onClose }: { entries: ChangelogEntry[]; onClose: () => void }) {
  return (
    <Sheet onClose={onClose} title="What’s changed">
      <ChangelogList entries={entries} />
      <div className="sheet-actions">
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </Sheet>
  );
}
