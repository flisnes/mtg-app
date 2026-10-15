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
  {
    version: '0.197.2',
    changes: [
      {
        kind: 'fixed',
        text: '"Newest normal printing" shows the plain card again for sets that print several versions of it, instead of the borderless chase copy. When a set only has variants, the lowest collector number wins.',
      },
    ],
  },
  {
    version: '0.197.1',
    changes: [
      {
        kind: 'changed',
        text: 'Simulator Auras now wait for a creature of yours, go on it as they resolve and are lost with it. Equipment stays behind and moves on. The trace says which creature each one is on.',
      },
    ],
  },
  {
    version: '0.197.0',
    changes: [
      {
        kind: 'added',
        text: 'The deck simulator seats opponents at the table: they draw and cast after your turn, so Rhystic Study, Smothering Tithe, Sheoldred, Grave Pact and the like finally do something. Set how many, their pace and how often they pay a tax on the Model tab.',
      },
      {
        kind: 'added',
        text: 'A new interaction setting holds counterspells for an opponent\'s spell and removal for an opponent\'s creature, and card rules get four "an opponent..." triggers with an "unless they pay" switch.',
      },
    ],
  },
  {
    version: '0.196.0',
    changes: [
      {
        kind: 'added',
        text: 'On a computer, drag a card image from Scryfall or Gatherer (or image files from your disk) onto your collection, a deck, binder or box, or your trade or wish list. The app works out which card it is and lists it for you to check before it is added.',
      },
    ],
  },
  {
    version: '0.195.0',
    changes: [
      {
        kind: 'changed',
        text: 'The sort and filter dropdowns above every card list are now one button that reads the current order ("Price ↓") and opens a sheet of choices. The toolbar fits on one row on a phone, so the cards start higher up.',
      },
    ],
  },
  {
    version: '0.194.0',
    changes: [
      {
        kind: 'added',
        text: 'Stack printings: a button beside the list/grid switch (or the S key) folds every copy of a card into one tile with the total count, wearing the edition your printing preference picks from the ones you own. Tap it and step between your copies on a strip in the card sheet. Works in the collection, tradelist and your decks, binders and boxes.',
      },
    ],
  },
  {
    version: '0.193.0',
    changes: [
      {
        kind: 'added',
        text: 'The deck simulator reads the other ways to cast a card off its text: evoke, foretell, plot, warp, madness, convoke, delve, flashback, escape and suspend. It takes the cheap way in only when the mana cost is out of reach.',
      },
      {
        kind: 'added',
        text: '"As an additional cost, sacrifice a creature" is a real cost now, and a card rule can exile cards "playable this turn" for red\'s impulse draw. Light Up the Stage and friends play that way instead of as a draw.',
      },
    ],
  },
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
