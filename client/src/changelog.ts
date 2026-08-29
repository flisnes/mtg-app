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
    version: '0.141.6',
    changes: [
      {
        kind: 'fixed',
        text: 'Cards now load in whole rows. A batch that ended mid-row looked like the end of the list and stopped people scrolling for the rest.',
      },
    ],
  },
  {
    version: '0.141.5',
    changes: [
      {
        kind: 'changed',
        text: 'Deck, binder and box rows keep their value and options button at the right edge, so they line up down the list instead of drifting with the badges.',
      },
    ],
  },
  {
    version: '0.141.4',
    changes: [
      {
        kind: 'changed',
        text: 'Visual stacks are now the default view on the trade board and in the scanned card list, and the card at the bottom of a stack always shows in full. Tiles and rows are still one tap away on the toggle.',
      },
    ],
  },
  {
    version: '0.141.3',
    changes: [
      {
        kind: 'added',
        text: 'The scanned-cards list shows a price on both card layouts now, and a total value for everything you scanned above the Add button.',
      },
    ],
  },
  {
    version: '0.141.2',
    changes: [
      {
        kind: 'changed',
        text: 'Finish, condition and language in the scanner are now buttons that cycle through the options instead of dropdowns. One tap per step, and they are bigger to hit.',
      },
    ],
  },
  {
    version: '0.141.1',
    changes: [
      {
        kind: 'changed',
        text: 'In the scanner, the set symbol now sits above each card in the row and is bigger. The plus and minus buttons have rings around them so they stay visible on light card borders and busy art.',
      },
    ],
  },
  {
    version: '0.141.0',
    changes: [
      {
        kind: 'added',
        text: 'Visual stacks: a view where cards overlap down the column with only their names showing, and the set, quantity and price beside them. Tap a card to open it fully. Toggle it on the trade board or in the scanned cards list.',
      },
    ],
  },
  {
    version: '0.140.6',
    changes: [
      {
        kind: 'fixed',
        text: 'The scanner card row now scrolls back to the start for every new card, including the next copy of the card you just scanned.',
      },
    ],
  },
  {
    version: '0.140.5',
    changes: [
      {
        kind: 'changed',
        text: 'The card row in the scanner holds still while you pick a printing. Scrolling or tapping it freezes the row (the bar on top shows for how long), and a new card in frame waits instead of shifting the printings under your finger.',
      },
      {
        kind: 'fixed',
        text: 'A confirmed edition no longer jumps to the front of a row you have started scrolling through. It still gets the green check.',
      },
    ],
  },
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
