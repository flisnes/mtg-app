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
  {
    version: '0.181.0',
    changes: [
      {
        kind: 'fixed',
        text: 'A Theros god no longer attacks below its devotion threshold, and creatures with defender no longer attack at all. Damage curves read a little lower and closer to how the deck plays.',
      },
    ],
  },
  {
    version: '0.180.0',
    changes: [
      {
        kind: 'fixed',
        text: 'The card database read some mana too generously. Mana priced in a sacrifice or another permanent (Ashnod\'s Altar, Springleaf Drum), one-shots without a tap cost (Blood Pet, the Spirit Guides), spells with a sacrifice attached (Deadly Dispute), "activate only if" abilities (Mox Opal) and loyalty or Saga mana no longer read as free repeating sources, and tapped rocks like Coldsteel Heart now enter tapped. Around 250 cards read lower and closer to how they play.',
      },
    ],
  },
  {
    version: '0.179.0',
    changes: [
      {
        kind: 'added',
        text: 'The top 500 EDH cards per color (3,500 total, by color-wheel and colorless splits) are now reviewed. More rules ship out of the box: Treasures and Clues auto-crack, lands tutor themselves, creatures grant evasion. 1,801 rules now play the top 3,000 cards.',
      },
    ],
  },
  {
    version: '0.178.0',
    changes: [
      {
        kind: 'added',
        text: 'The 1000 most-played commanders are now reviewed: 522 of them ship with a rule, like the top 1000 cards before them. Your own rule still wins.',
      },
      {
        kind: 'fixed',
        text: 'Mana that can only be spent on some spells now only pays for those. Ancient Ziggurat, Cormela and Jeweled Lotus used to pay for anything.',
      },
    ],
  },
  {
    version: '0.177.0',
    changes: [
      {
        kind: 'added',
        text: "Rules can count your devotion to a color, so Gray Merchant drains for the right amount and Karametra's Acolyte taps for it. Your permanents matching can count different names, which is how Field of the Dead ships now.",
      },
    ],
  },
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
