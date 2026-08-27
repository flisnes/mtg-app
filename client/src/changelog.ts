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
  {
    version: '0.135.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The small print under a deck, binder or box in a list is small and dim again, instead of full-size text spread across the row.',
      },
      {
        kind: 'changed',
        text: 'The app downloads a little less on first open. Older release notes now load only when you go looking for them.',
      },
    ],
  },
  {
    version: '0.135.0',
    changes: [
      {
        kind: 'added',
        text: 'Card search now sorts: best match, name, mana value or price, either direction. Sorting by price ranks every hit, not just the page on screen.',
      },
      {
        kind: 'added',
        text: "Search scoped into your collection, tradelist, wishlist or a deck offers that list's own sort options, and reordering there reorders the list itself.",
      },
    ],
  },
  {
    version: '0.134.9',
    changes: [
      {
        kind: 'changed',
        text: 'Recent searches now drop down from the search bar as a small see-through panel instead of filling the screen. Arrow keys walk the list, Enter picks one.',
      },
      {
        kind: 'changed',
        text: 'The search bar remembers 500 past searches, up from 10, and narrows them to whatever you are typing.',
      },
    ],
  },
  {
    version: '0.134.8',
    changes: [
      {
        kind: 'added',
        text: 'About now has an "Open source licenses" page listing the 28 components the app is built on, each with its copyright and licence in full. The licences ask to be shipped with the app, and now they are.',
      },
      {
        kind: 'added',
        text: 'MTGJSON is now credited for sealed product data, as its licence requires, along with TCGCSV and Cardmarket for sealed prices and Andrew Gioia for the set and mana symbol fonts.',
      },
    ],
  },
  {
    version: '0.134.7',
    changes: [
      {
        kind: 'fixed',
        text: 'Deck, binder and box emblems that went missing on another device are back. A device still on an older build when emblems shipped dropped them on the way in and never asked again; it now re-reads your account once and restores them.',
      },
    ],
  },
  {
    version: '0.134.6',
    changes: [
      {
        kind: 'added',
        text: '"Pick one from my collection" now has a "Not here? Add a copy" line under the grid, for when the edition you are holding never made it into the collection. Add it there and that copy fills the slot you were on.',
      },
    ],
  },
  {
    version: '0.134.5',
    changes: [
      {
        kind: 'fixed',
        text: 'Swiping down at the top of a page no longer slides the bottom nav bar half off the screen. The gesture was reaching the browser instead of stopping at the page.',
      },
    ],
  },
  {
    version: '0.134.4',
    changes: [
      {
        kind: 'changed',
        text: 'The trade tag and wishlist star now fill in solid when the printing on screen is the one on your list, and stay tinted when it is some other edition. A wish on "any printing" always counts as a match.',
      },
    ],
  },
  {
    version: '0.134.3',
    changes: [
      {
        kind: 'added',
        text: 'Cards on your wishlist now show a gold star in search results and on deck slots, so you can see what you are already hunting. Your own wishlist stays unstarred.',
      },
      {
        kind: 'changed',
        text: 'Adding a card to your collection, tradelist or wishlist from its sheet now says which list it went to before the sheet closes.',
      },
    ],
  },
  {
    version: '0.134.2',
    changes: [
      {
        kind: 'added',
        text: 'Tap the app version in About to read the full release notes, all versions, scrollable. No more catching them once and losing them.',
      },
    ],
  },
  {
    version: '0.134.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Two different printings of one card filed into a binder or box no longer collapse into a single line with the second printing thrown away. Same printing twice, or "any printing", still pools onto one line.',
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
