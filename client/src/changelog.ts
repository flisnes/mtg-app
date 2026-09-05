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
    version: '0.145.2',
    changes: [
      {
        kind: 'fixed',
        text: 'The collection used to open on "0 entries · 0 cards" for a moment, which looked like it had gone missing. It now shows the real count right away, with placeholder cards until the shelf finishes loading.',
      },
    ],
  },
  {
    version: '0.145.1',
    changes: [
      {
        kind: 'fixed',
        text: '`otag:` searches came back empty after the 0.145.0 update, because the card database being served predated tag search. Accept the card-data update when it is offered and tag search works.',
      },
    ],
  },
  {
    version: '0.145.0',
    changes: [
      {
        kind: 'added',
        text: 'Search cards by what they do with `otag:`. Around 4,500 Scryfall Tagger labels now ship with the card database: `otag:removal`, `otag:ramp`, `otag:tutor`, `otag:shockland`. Tags nest, so a broad one finds everything under it. Type `otag:` in the search bar for the list. Works on your own lists too.',
      },
    ],
  },
  {
    version: '0.144.2',
    changes: [
      {
        kind: 'changed',
        text: '"Assemble from my collection" now puts the copies matching what the slot asked for first. If a line names a printing, finish, language or condition, the copies that fit lead the grid instead of sitting below the newest edition.',
      },
    ],
  },
  {
    version: '0.144.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Re-scanning a deck, binder or box now files the copies you scanned into it, so they turn green like they do when you use "Scan cards". Before, the cards and counts were right but nothing was actually holding them. A re-scan whose counts already match is no longer a no-op either.',
      },
    ],
  },
  {
    version: '0.144.0',
    changes: [
      {
        kind: 'added',
        text: 'Filing a card from its sheet now asks which copies are going in when you own more than one. Tap a copy to send it, tap again for a second, then File. The copy you opened starts out picked, and the ones the container already holds are greyed out.',
      },
    ],
  },
  {
    version: '0.143.3',
    changes: [
      {
        kind: 'fixed',
        text: 'Filing a card into a deck, binder or box that already holds copies of it no longer promises copies you do not own. Own two with one already filed there, and filing puts the loose copy away instead of claiming a third and warning you about it.',
      },
    ],
  },
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
