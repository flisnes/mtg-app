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
    version: '0.143.2',
    changes: [
      {
        kind: 'fixed',
        text: '"Filed: Nowhere" hid cards you own two of when one copy was filed away. A line with copies still loose now shows up under it, so selecting them all catches everything left in the shoebox.',
      },
    ],
  },
  {
    version: '0.143.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Sorting by "Last edited" threw the card you just changed to the top and then dropped it back down. It now reads each copy’s own timestamp, so the card stays where it belongs — and only the copy you touched moves. Edit one edition of a Forest and the rest stay put; change the Italian copy and the English one does not budge. Filing a card into a deck, binder or box, or taking it out, counts as an edit too.',
      },
    ],
  },
  {
    version: '0.143.0',
    changes: [
      {
        kind: 'added',
        text: 'Mark a copy you own as altered, signed, misprint, miscut or crimped — any combination of them — from the new Special dropdown on a collection card. Those copies wear an amber A, and they sit on their own line, so your altered copy no longer shares a row with the plain one. Matching is untouched: a signed card still fills a deck slot and still answers a wish.',
      },
    ],
  },
  {
    version: '0.142.0',
    changes: [
      {
        kind: 'added',
        text: 'Decks can be archived. An Archived folder sits under the deck list, greyed out until you use it. Archiving keeps the whole list but takes the deck out of the list of decks you play, and asks whether to unfile its cards so your other decks can have the copies back. Restore it any time from the options menu.',
      },
    ],
  },
  {
    version: '0.141.9',
    changes: [
      {
        kind: 'changed',
        text: 'Cards start higher up on the collection, wishlist and tradelist. The blurb under the title is gone and the count moved up next to it. Another user’s full list lost its own search box, since the header search already reaches their lists.',
      },
    ],
  },
  {
    version: '0.141.8',
    changes: [
      {
        kind: 'changed',
        text: 'The search bar in the header now searches every card, instead of starting on the list you were standing on. Each list keeps a magnifying glass next to Select for searching just that list, and the scope pills still switch either way.',
      },
    ],
  },
  {
    version: '0.141.7',
    changes: [
      {
        kind: 'fixed',
        text: 'The Bloomburrow paw print renders as a paw again. Cards that spend paw prints on their modes were showing the Phyrexian mana pip instead.',
      },
    ],
  },
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
