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
    version: '0.188.0',
    changes: [
      {
        kind: 'added',
        text: 'Decks have a Considering section for cards you might play. They never count toward the deck.',
      },
      {
        kind: 'added',
        text: 'Commander decks get a Companion zone. Tap "Set as companion" on a companion card.',
      },
      {
        kind: 'changed',
        text: 'Commander decks no longer have a sideboard. Cards in one move to Companion or Considering.',
      },
    ],
  },
  {
    version: '0.187.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The card data download no longer flickers between "Downloading" and "Installing".',
      },
    ],
  },
  {
    version: '0.187.0',
    changes: [
      {
        kind: 'added',
        text: 'Four more deck formats: Premodern, Cube, Dan-dan Variant and Judge\'s Tower. Premodern checks card legality like the other sanctioned formats; the other three are kitchen-table formats with no checks, same as Casual. Commander now sits at the top of the format list.',
      },
    ],
  },
  {
    version: '0.186.0',
    changes: [
      {
        kind: 'added',
        text: 'Agent tools support filtering with the app\'s search syntax (e.g., "t:creature pow<=1"), showing creature P/T in rows, deck folders, and a brief option to drop oracle text on large results. Responses are compact JSON now instead of pretty-printed.',
      },
    ],
  },
  {
    version: '0.185.1',
    changes: [
      {
        kind: 'added',
        text: 'Agent collection tool now returns market prices per copy, in both EUR and USD for each card\'s exact printing and finish. Sort by "price" to rank cards by value.',
      },
    ],
  },
  {
    version: '0.185.0',
    changes: [
      {
        kind: 'added',
        text: 'Agent connections (desktop): a new Settings toggle lets a Claude Code session on your computer search cards and work with your collection, decks and lists through the open tab. Off by default, local only, and every agent change is one undoable history entry.',
      },
    ],
  },
  {
    version: '0.184.0',
    changes: [
      {
        kind: 'changed',
        text: 'Scans, imports, wishlist purchases and opened sealed products all end in one questionnaire: which cards are already yours, where they live, whether a copy moved. One sheet, numbered steps, Back keeps your answers, and nothing is written until the last step.',
      },
      {
        kind: 'changed',
        text: 'Scanning into a deck asks "Are these yours?" once per card (Already mine, New copy, Not mine), the "which copy?" pick sits inside the row, and one scan or import is one history entry to undo.',
      },
    ],
  },
  {
    version: '0.183.0',
    changes: [
      {
        kind: 'fixed',
        text: 'Scanning into a deck, binder or box no longer asks "did it move?" about a card you just marked as a new copy, and "Where do these live?" no longer reappears under that question.',
      },
      {
        kind: 'fixed',
        text: 'Update carries a card\'s filing along instead of leaving a conflict behind, review steps keep your answers when you go back, and a move between containers undoes in one step.',
      },
    ],
  },
  {
    version: '0.182.5',
    changes: [
      {
        kind: 'fixed',
        text: 'Every popup sheet in the app now shares one frame, so the guard against a double-tap landing inside a freshly opened sheet, Escape/back handling and screen-reader dialog markup apply everywhere.',
      },
    ],
  },
  {
    version: '0.182.3',
    changes: [
      {
        kind: 'added',
        text: 'A card that belongs to a cycle (bond lands, shocklands, Titans, ...) now has a "See the other cards in this cycle" link on its card sheet, jumping straight to a search for its cycle-mates.',
      },
    ],
  },
  {
    version: '0.182.2',
    changes: [
      {
        kind: 'changed',
        text: 'The app downloads about a fifth less on first load and updates. Trade, the scanner and deck analysis now load when you open them, and the analysis defaults file no longer downloads on install.',
      },
    ],
  },
  {
    version: '0.182.1',
    changes: [
      {
        kind: 'added',
        text: 'A lone commander with Partner, a Background or a Doctor pairing now offers a "Find a partner" button that lists exactly the cards that can join them — no more fighting the color identity filter for Tana.',
      },
      {
        kind: 'added',
        text: 'The Prismatic Piper and friends show five mana pips on their card in the command zone: tap one to choose the color, and the deck’s identity follows.',
      },
    ],
  },
  {
    version: '0.182.0',
    changes: [
      {
        kind: 'fixed',
        text: 'A background data update no longer resets the screen when it finishes — if you were adding cards or editing a deck, you stay right where you were.',
      },
      {
        kind: 'added',
        text: 'Background card-data and price downloads now show a slim progress strip under the header while they run.',
      },
    ],
  },
  {
    version: '0.181.3',
    changes: [
      {
        kind: 'changed',
        text: 'Editing a card no longer makes every badge, total and list re-read your whole collection separately — they now share one pass, so edits feel snappier on big collections.',
      },
    ],
  },
  {
    version: '0.181.2',
    changes: [
      {
        kind: 'changed',
        text: 'The deck simulator moved into its own package with a proper test suite, and out of the main download: the app fetches a little less and the engine loads when you first watch a game play out.',
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
