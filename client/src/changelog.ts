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
    version: '0.192.0',
    changes: [
      {
        kind: 'added',
        text: 'A Plan tab on the deck analysis page: write goals like "four lands and a creature on the battlefield by turn 4" and the simulator counts how often its games get there. Searches in your card rules fetch what the plan is missing first.',
      },
      {
        kind: 'added',
        text: 'The Bracket tab reads the clock: how often a goldfish has one opponent dead by each turn, and the bracket that speed reads as.',
      },
      {
        kind: 'added',
        text: 'A card rule can look at the top N cards instead of searching the whole library (Muxus, Gishath), with the rest going to the bottom or the graveyard.',
      },
    ],
  },
  {
    version: '0.191.0',
    changes: [
      {
        kind: 'added',
        text: 'Card rules can copy a permanent you control: token copies for Kiki-Jiki and Rite of Replication, or "this card enters as the copy" for Clone.',
      },
      {
        kind: 'added',
        text: 'A Bracket tab on the deck analysis page counts Game Changers, mass land denial, extra turns and tutors in a Commander deck and names the lowest bracket they fit.',
      },
      {
        kind: 'changed',
        text: 'Board-scaling mana (Gaea\'s Cradle, Priest of Titania), chosen-color rocks and Mahadi\'s Treasures now read closer to the card, and cards that tax you too (Thalia, Rule of Law) are flagged on the Model tab.',
      },
    ],
  },
  {
    version: '0.190.0',
    changes: [
      {
        kind: 'added',
        text: 'The deck simulator reads lifelink, infect and toxic off your cards, tracks your life and the opponent’s poison, and card rules get a "When you gain life" trigger and a poison step.',
      },
      {
        kind: 'added',
        text: 'Cost reduction: a standing rule can make the spells you name cost less (Medallions, Electromancer, Animar), and printed affinity is read off the card.',
      },
      {
        kind: 'added',
        text: 'Smaller rule grammar: prowess-style "this card" pumps, +X/+0, counters on each creature, "what woke it" as an amount, conditions on standing effects, a beginning-of-combat trigger, attacking tokens and "only once each game".',
      },
    ],
  },
  {
    version: '0.189.2',
    changes: [
      {
        kind: 'fixed',
        text: 'You can no longer join your own trade from a second device or tab. Trade solo is still there for recording a trade with someone who isn’t on the app.',
      },
    ],
  },
  {
    version: '0.189.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The app no longer crawls while card data downloads or the account syncs. Updates install quietly and refresh the screens once, and syncs write in bulk.',
      },
      {
        kind: 'fixed',
        text: 'New zones, formats and card rules no longer make every device re-download the whole account after an update.',
      },
    ],
  },
  {
    version: '0.189.0',
    changes: [
      {
        kind: 'added',
        text: 'The deck simulator reads Equipment and Auras: the printed bonus goes on your best attacker. Swords, Colossus Hammer and Rancor count in combat now.',
      },
    ],
  },
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
