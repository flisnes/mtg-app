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
    version: '0.176.0',
    changes: [
      {
        kind: 'added',
        text: 'Dredge in the simulator. Printed Dredge is read off the card, a new "While it is in your graveyard" rule sets it by hand, and a new static step gives cards in your graveyard dredge, like the lands under The Necrobloom.',
      },
      {
        kind: 'changed',
        text: 'Milled cards now count toward cards seen.',
      },
    ],
  },
  {
    version: '0.175.0',
    changes: [
      {
        kind: 'added',
        text: 'Rules can create any token by name, like Moloids or Everywhere, built from the real token card. A new "cards in a zone can be cast" step gives your graveyard retrace, flashback or escape, like Six.',
      },
      {
        kind: 'fixed',
        text: 'A commander that exiles itself at upkeep keeps its upkeep rule after you recast it.',
      },
    ],
  },
  {
    version: '0.174.2',
    changes: [
      {
        kind: 'fixed',
        text: 'Rules you write now sync to your other devices, and going back to a built-in rule no longer brings back an old version of yours.',
      },
    ],
  },
  {
    version: '0.174.1',
    changes: [
      {
        kind: 'fixed',
        text: 'A rule you edit on one device no longer snaps back to the old version from another device a few seconds after saving.',
      },
      {
        kind: 'fixed',
        text: 'The "saved" popup no longer waits forever when you save while the games are still being dealt.',
      },
    ],
  },
  {
    version: '0.174.0',
    changes: [
      {
        kind: 'added',
        text: 'Rules can fire at your end step, when another creature of yours dies, or when you sacrifice something (Treasures and Clues count). Blood Artist drains, Pitiless Plunderer makes Treasures.',
      },
      {
        kind: 'added',
        text: 'Abilities you pay for: mana, {T}, a sacrifice, a discard or life. The simulator uses them with spare mana, so Mind Stone, Clues and War Room draw cards now.',
      },
      {
        kind: 'added',
        text: 'Rules can say "only if" (threshold, metalcraft) and "once each turn", and a move can take the biggest card instead of a random one. 31 more popular cards model themselves, and 18 do more.',
      },
    ],
  },
  {
    version: '0.173.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Any creature without haste waits a turn to tap for mana, Dryad Arbor included, and rocks tap the turn they land. Desert Warfare, Path to Exile and about 300 others no longer read as land ramp.',
      },
      {
        kind: 'added',
        text: 'Rules can give haste, vigilance or double strike to a card itself, and a mana ability can be limited to spells matching a search.',
      },
    ],
  },
  {
    version: '0.173.0',
    changes: [
      {
        kind: 'added',
        text: "About 220 of the most-played Commander cards now come with a simulator rule written for them, used until you write your own. Find them on the Model tab under Written for you.",
      },
      {
        kind: 'fixed',
        text: 'Search understands pow and tou, so pow>=3 finds power 3 or more instead of searching card names.',
      },
    ],
  },
  {
    version: '0.172.1',
    changes: [
      {
        kind: 'fixed',
        text:
          'Trades that gave away a card filed in a deck or binder said "Trade complete" but changed nothing. They save now, and a failed save shows a Retry button.',
      },
    ],
  },
  {
    version: '0.172.0',
    changes: [
      {
        kind: 'added',
        text:
          'Some cards now come with their rule already written (Craterhoof, Ashaya, Everflowing Chalice, Beast Whisperer and about 45 more), one tap away in the Model tab. Other cards get a starting point from their tags, like "Landfall: draw a card".',
      },
    ],
  },
  {
    version: '0.171.0',
    changes: [
      {
        kind: 'added',
        text:
          'Card rules can do far more: make tokens, put counters on a card, pump your creatures, add a type while a card is out (Ashaya), write a mana ability (Everflowing Chalice), and cast a card with kicker, flashback, escape or suspend.',
      },
      {
        kind: 'changed',
        text:
          'The simulator now discards down to seven at end of turn, recasts your commander with its tax, and a creature that taps for mana no longer also attacks.',
      },
    ],
  },
  {
    version: '0.170.0',
    changes: [
      {
        kind: 'added',
        text: 'The Model tab now plays your deck under all four spend orders and shows them side by side, so you can see whether the order matters and tap the one that does best.',
      },
    ],
  },
  {
    version: '0.169.0',
    changes: [
      {
        kind: 'added',
        text: 'A card you already wrote a rule for in another deck offers that rule in its editor. One tap copies it in; save to keep it.',
      },
    ],
  },
  {
    version: '0.168.0',
    changes: [
      {
        kind: 'added',
        text:
          'Saving a card rule shows what it changed: its own draws or mana, and any deck number that moved, before and after. Undo puts the old rule back. A quick answer comes first, the full 20,000 games right after.',
      },
      {
        kind: 'added',
        text:
          'The card editor says how often each saved trigger fired, and Watch it in a game deals a game with that card in it and shows only its lines.',
      },
    ],
  },
  {
    version: '0.167.0',
    changes: [
      {
        kind: 'changed',
        text:
          'The Model tab opens on Write these first: the cards that should draw, ramp, tutor or build something and do nothing yet, best first. Removal and plain creatures fold away under Right as nothing.',
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
