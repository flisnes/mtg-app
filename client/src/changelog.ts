// User-facing changelog for the "What's changed" popup (WhatsNewModal.tsx).
// Short, plain-spoken entries — not the fuller writeups in CHANGELOG.md at the
// repo root. Only versions from 0.98.0 onward are listed: every install still
// in the wild is already past that point, so nothing older needs a place here.
//
// Add an entry here on every version bump, same as CHANGELOG.md (see
// CLAUDE.md's Conventions section) — otherwise the popup silently has nothing
// to say about that release. Always at the top of CHANGELOG_RECENT; when that
// list grows past about fifteen, move the tail into changelogArchive.ts.
import { isNewer } from './appUpdate.js';

export type ChangeKind = 'added' | 'changed' | 'fixed' | 'removed';

interface ChangelogChange {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  changes: ChangelogChange[];
}

/**
 * The newest releases, bundled with the app. This is all the popup ever needs
 * from a device that updates normally: it only has to cover the gap between
 * the version a phone last saw and this one.
 *
 * Everything older lives in changelogArchive.ts and is fetched on demand, so
 * a changelog that grows every week stops growing the chunk every phone
 * downloads on first load.
 */
export const CHANGELOG_RECENT: ChangelogEntry[] = [
  {
    version: '0.202.0',
    changes: [
      {
        kind: 'added',
        text: 'A server admin panel behind Settings, visible to the operator account only: accounts as metadata, live trade sessions, and the health of the price archive.',
      },
    ],
  },
  {
    version: '0.201.5',
    changes: [
      {
        kind: 'changed',
        text: 'The app now looks up the trade and sync server address when it starts instead of carrying it inside the app, so a server move no longer needs an app update.',
      },
    ],
  },
  {
    version: '0.201.4',
    changes: [
      {
        kind: 'added',
        text: 'Settings → Prices → "Show prices on grid tiles" puts a small price chip on every tile, next to the copy count. Off by default.',
      },
    ],
  },
  {
    version: '0.201.3',
    changes: [
      {
        kind: 'changed',
        text: "A copy's traits read the same way everywhere now (condition, Foil, language, Signed), deck search results name the zone like the deck page does, deleting a container asks the same question from its page and its list, and the goblin-mode card back and history event sheets have a close button.",
      },
    ],
  },
  {
    version: '0.201.2',
    changes: [
      {
        kind: 'fixed',
        text: 'Tapping + on a search result no longer re-runs the search under your finger, the Commander zone stops redrawing on every keystroke, and undoing a deck import writes the deck once instead of once per card.',
      },
    ],
  },
  {
    version: '0.201.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Purchase import: a price of a thousand euros or more was read as 1% of its value, unticked lines now stay untouched on a re-import, non-euro CardTrader slips are refused, and the review shows each card with its picture and prices in your display currency.',
      },
    ],
  },
  {
    version: '0.201.0',
    changes: [
      {
        kind: 'added',
        text: 'Import an old Cardmarket or CardTrader order (CSV, XLS or PDF) under Import to set when you bought each card and what you paid, even for cards you have since traded away.',
      },
    ],
  },
  {
    version: '0.200.14',
    changes: [
      { kind: 'fixed', text: 'Searching "bolt" ranks Lightning Bolt with the other Bolts, and cards you own first among equals.' },
      { kind: 'fixed', text: 'Find a partner shows the legal partners again.' },
      { kind: 'changed', text: 'The empty search screen lists your recent searches. One close button in the search bar, not two.' },
    ],
  },
  {
    version: '0.200.13',
    changes: [
      { kind: 'changed', text: 'With Stack printings on, the trade pickers show one row per card. Trade history shows each card\'s set.' },
    ],
  },
  {
    version: '0.200.12',
    changes: [
      { kind: 'changed', text: "The deck list's format and color filters light up while they hide decks, like every other filter." },
    ],
  },
  {
    version: '0.200.11',
    changes: [
      {
        kind: 'changed',
        text: 'Settings has jump links at the top, and deleting your account or all your data asks in a proper confirm sheet. Agent connections are hidden on phones.',
      },
    ],
  },
  {
    version: '0.200.10',
    changes: [
      {
        kind: 'changed',
        text: 'The scan list loads lighter thumbnails, and the import search results look like every other card list.',
      },
    ],
  },
  {
    version: '0.200.9',
    changes: [
      {
        kind: 'changed',
        text: 'Every sheet has its ✕ top-right and its main button bottom-right, the plus/minus counters all match, and Escape closes a ⋯ menu without closing the card behind it.',
      },
    ],
  },
  {
    version: '0.200.8',
    changes: [
      {
        kind: 'changed',
        text: 'Importing a list looks the same everywhere: labelled condition, finish and language pickers, an Upload file button, and Analyze on the right.',
      },
    ],
  },
];

/**
 * Can the bundled slice alone answer "what changed since `seen`"? False for a
 * device that skipped back past its oldest entry, and for one with no baseline
 * at all — both need the archive.
 */
export function recentCovers(seen: string | undefined): boolean {
  const oldest = CHANGELOG_RECENT.at(-1);
  return seen !== undefined && oldest !== undefined && !isNewer(oldest.version, seen);
}

/**
 * Every entry, newest first, pulling the archive chunk in. Only worth calling
 * for the full history (the About page) or for a device that skipped so many
 * releases that CHANGELOG_RECENT can't cover the gap.
 */
export async function loadChangelog(): Promise<ChangelogEntry[]> {
  const { CHANGELOG_ARCHIVE } = await import('./changelogArchive.js');
  return [...CHANGELOG_RECENT, ...CHANGELOG_ARCHIVE];
}
