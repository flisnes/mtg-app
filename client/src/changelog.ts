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

export interface ChangelogChange {
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
    version: '0.140.4',
    changes: [
      {
        kind: 'added',
        text: 'Scanning into a deck, binder or box now asks what your collection should do with every card, not just the ones you own no copy of. Per card: Skip, Add a second copy, or Update to the printing you scanned.',
      },
    ],
  },
  {
    version: '0.140.3',
    changes: [
      {
        kind: 'added',
        text: 'Escape leaves select mode, so the ✕ on the bulk bar is no longer the only way out.',
      },
    ],
  },
  {
    version: '0.140.2',
    changes: [
      {
        kind: 'fixed',
        text: 'In grid view the keyboard cursor was a thin line drawn on the card’s own black border, and it faded out on cards you do not own. It is a proper ring around the tile now, and the card you are pointing at is no longer greyed out.',
      },
    ],
  },
  {
    version: '0.140.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Arrowing through a deck kept scrolling the card you were pointing at underneath the tab bar, so its purple outline was invisible. The cursor now stops where you can see it.',
      },
    ],
  },
  {
    version: '0.140.0',
    changes: [
      {
        kind: 'changed',
        text: 'The scanner’s set pin is a dropdown of the card’s editions instead of a checkbox that guessed from the card in frame. Set symbols, years, and a search box, so a card with twenty reprints pins the set you are actually holding.',
      },
      {
        kind: 'changed',
        text: 'A pinned set also pinpoints editions faster. When the pin leaves one printing standing, the reader does not have to run: the green check lands as the card locks, and auto-add drops the copy straight in.',
      },
    ],
  },
  {
    version: '0.139.1',
    changes: [
      {
        kind: 'added',
        text: 'Press ? for the full list of keyboard shortcuts, which were all invisible until now. Also new: + adds the search result you are pointing at, / jumps to the search box, v switches list and grid, and x ticks a card for a bulk action.',
      },
    ],
  },
  {
    version: '0.139.0',
    changes: [
      {
        kind: 'added',
        text: 'Deck building from the keyboard. Point at a card and press + or - to change its copies, Enter to open it, Delete to remove it, and the arrow keys to walk between cards. Ctrl+K jumps to the search box. A run of + presses now folds into one line in the edit history.',
      },
    ],
  },
  {
    version: '0.138.0',
    changes: [
      {
        kind: 'added',
        text: 'Copy, cut and paste cards on a deck, binder or box. Ctrl+C gives you a decklist anywhere else and the exact printings back in the app, Ctrl+X moves cards between decks in one undoable step, and Ctrl+V on a list from any website opens the import review already filled in. Ctrl+A selects the lot.',
      },
    ],
  },
  {
    version: '0.137.0',
    changes: [
      {
        kind: 'added',
        text: "Ctrl+Z undoes your last change on the page you're looking at, Ctrl+Y puts it back (Cmd on a Mac). Neither reaches into a deck you've navigated away from, and both leave your typing alone.",
      },
    ],
  },
  {
    version: '0.136.0',
    changes: [
      {
        kind: 'changed',
        text: 'Undo in the edit history is no longer limited to the newest entry. Any change can be reversed as long as nothing newer has touched the same copies, filters and all.',
      },
    ],
  },
  {
    version: '0.135.8',
    changes: [
      {
        kind: 'fixed',
        text: "Buttons whose work fails now tell you, instead of looking like they did nothing. Fifteen of them were silent before, from editing a price in a card's history to changing how many sealed boxes you own.",
      },
    ],
  },
  {
    version: '0.135.5',
    changes: [
      {
        kind: 'fixed',
        text: "A device running an older version no longer strips fields off your own synced data, and no longer skips rows it doesn't understand yet. Both used to need a full re-download of the account to repair.",
      },
    ],
  },
  {
    version: '0.135.4',
    changes: [
      {
        kind: 'fixed',
        text: 'Back no longer skips a page when you close the search overlay or a card sheet. Each one parks its own history entry now instead of guessing which entry was its own, so back peels off exactly one layer at a time.',
      },
    ],
  },
  {
    version: '0.135.3',
    changes: [
      {
        kind: 'added',
        text: 'Unfile now offers the deck, binder or box you are standing in. The card stays on the list, still asking for the same copy, but stops holding one: the green filed badge drops to the double checkmark and the copy is free for another deck. "File back here" puts it back.',
      },
    ],
  },
  {
    version: '0.135.2',
    changes: [
      {
        kind: 'fixed',
        text: 'Pulling down to refresh works again. A fix in 0.134.5 pinned the gesture to the page and disabled the browser refresh along with it; the problem it was aimed at turned out to be already handled elsewhere.',
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
