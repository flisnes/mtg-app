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
    version: '0.198.13',
    changes: [
      {
        kind: 'fixed',
        text: 'Layout fixes: recent searches no longer cover the scope chips, Spoilers opens on a set with cards, the sealed steppers are centred, and Delete sits apart from Archive in the deck menu.',
      },
    ],
  },
  {
    version: '0.198.12',
    changes: [
      {
        kind: 'changed',
        text: 'Easier to hit and easier to read: toolbar buttons, sheet close buttons, steppers and chips are bigger, and purple and red text and buttons have more contrast.',
      },
    ],
  },
  {
    version: '0.198.11',
    changes: [
      {
        kind: 'fixed',
        text: 'Community lists, profiles, trade matches and price charts are only downloaded again when they changed, so revisits load right away.',
      },
    ],
  },
  {
    version: '0.198.10',
    changes: [
      {
        kind: 'fixed',
        text: 'Mover arrows, value-change sorting, the value chart and Price movers share one read of your price history, so big collections stay quick.',
      },
    ],
  },
  {
    version: '0.198.9',
    changes: [
      {
        kind: 'fixed',
        text: 'Decks, binders, the wishlist, trades and price movers share one read of your cards instead of each looking them up again, so they open faster.',
      },
    ],
  },
  {
    version: '0.198.8',
    changes: [
      {
        kind: 'fixed',
        text: 'Deck pages, card details and owned counts no longer redo their work on every write during a sync or a big import, so the app stays snappy while cards pour in.',
      },
    ],
  },
  {
    version: '0.198.7',
    changes: [
      {
        kind: 'changed',
        text: 'Select mode shows its two main actions as soon as you pick a card, with the rest under More. The check circle moved off the card name.',
      },
    ],
  },
  {
    version: '0.198.6',
    changes: [
      {
        kind: 'fixed',
        text: 'Every screen now lights up its tab, and screens off More have a "‹ More" link back.',
      },
    ],
  },
  {
    version: '0.198.5',
    changes: [
      {
        kind: 'changed',
        text: 'Trade: starting or joining a trade shows what it is doing and has a Cancel. If the server can’t be reached you get Retry or Trade solo, a wrong code says so, and a dropped connection mid-trade keeps your board up while it reconnects.',
      },
    ],
  },
  {
    version: '0.198.4',
    changes: [
      {
        kind: 'fixed',
        text: 'Restoring a backup keeps a foil and a nonfoil wish for the same card apart, a deck you edit moves to the top of Decks, and wish quantity changes show in History and can be undone.',
      },
    ],
  },
  {
    version: '0.198.3',
    changes: [
      {
        kind: 'changed',
        text: 'Price tracking does its work once a day instead of on every launch, and reopening a card while signed in no longer refetches its price history.',
      },
    ],
  },
  {
    version: '0.198.2',
    changes: [
      {
        kind: 'changed',
        text: 'The app opens faster and downloads less on each open. Card search loads its data when you first search, and the daily price update no longer rebuilds it.',
      },
      {
        kind: 'fixed',
        text: 'otag: on your lists kept working only until the first card data update. Now it survives one, and a search made offline tries again once you are back.',
      },
    ],
  },
  {
    version: '0.198.1',
    changes: [
      {
        kind: 'changed',
        text: '"Find sealed products with this card" now lists the boosters you can open it from, and the boxes and bundles that hold them. A Wilds of Eldraine card in Set Boosters but not Draft says so.',
      },
    ],
  },
  {
    version: '0.198.0',
    changes: [
      {
        kind: 'added',
        text: 'Foil prices are tracked day by day. A foil card\'s price chart and trend now follow the foil price instead of the plain one, and the collection value chart uses it too.',
      },
      {
        kind: 'added',
        text: 'Signed in, price charts can reach back years: "Since 2021" puts monthly prices from late 2021, spring 2023 and July 2025 in front of the daily line, where we have them.',
      },
    ],
  },
  {
    version: '0.197.3',
    changes: [
      {
        kind: 'fixed',
        text: 'Wishes and deck slots on "Any printing" now show your preferred printing, not the newest one, so a Secret Lair or set promo no longer stands in for the card. "Newest normal printing" also skips The List and other copies with letters in the collector number.',
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
