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
    version: '0.151.0',
    changes: [
      {
        kind: 'added',
        text: 'Colored sources, in the deck stats sheet. It counts what taps for each of your colors and names the card your mana lets down worst: "2 white sources short for Wrath of God on turn 4". A card your deck makes no mana for at all reads "never".',
      },
      {
        kind: 'added',
        text: 'Taplands count from turn two and mana rocks from a turn after you could cast them, so the count is what you can actually tap, not what is in the list.',
      },
    ],
  },
  {
    version: '0.150.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The deck stats charts were flat on a phone. The mana curve and the draw-odds chart both collapsed to their axis labels whenever the sheet was taller than the screen. Both stand up again.',
      },
    ],
  },
  {
    version: '0.150.0',
    changes: [
      {
        kind: 'added',
        text:
          'Draw odds in the deck stats sheet: the chance of drawing what you want by turn N. Pick a group with the search bar you already know (`type:land`, `otag:removal`, `cmc<=2`) or tap a preset, set how many copies you need, and read the curve from your opening hand to turn six.',
      },
    ],
  },
  {
    version: '0.149.0',
    changes: [
      {
        kind: 'added',
        text:
          'Deck stats: the mana curve, your land count against Karsten’s rule of thumb for that curve, and what your tapped lands cost you in tempo. Open it from the line under the legality panel, or from the deck’s “...” menu.',
      },
    ],
  },
  {
    version: '0.148.2',
    changes: [
      {
        kind: 'added',
        text:
          'Search by the mana a card makes. `produces:g` finds anything that taps for green, `produces:wu` wants both colors, `produces>=3` finds your fixing. Plus `is:tapland` for the lands that always enter tapped (not the ones that only sometimes do), `is:untappedsource` for the ones that don’t, and `is:manasource` for anything that taps for mana.',
      },
      {
        kind: 'changed',
        text:
          'The card database learned two new things about every card to make that work, so expect a card-data update after this one. Bigger than usual, just this once.',
      },
    ],
  },
  {
    version: '0.148.1',
    changes: [
      {
        kind: 'added',
        text:
          'Sort by release date, on every card list. Your own lists order by the printing you hold; the card database orders by when the card first came out. While that sort is on, each card shows its release year.',
      },
    ],
  },
  {
    version: '0.148.0',
    changes: [
      {
        kind: 'added',
        text:
          'The card sheet’s ⋯ menu has "Format legality": the seven formats we track with the card’s standing in each. Green legal, red banned, amber restricted, grey not legal.',
      },
    ],
  },
  {
    version: '0.147.9',
    changes: [
      {
        kind: 'added',
        text:
          'Sealed products now open. Tap one in "Find sealed products with this card", or in the add sheet, to see a grid of the cards inside it in the printings it actually ships. The card you looked up is marked, and any card opens from there.',
      },
    ],
  },
  {
    version: '0.147.8',
    changes: [
      {
        kind: 'fixed',
        text:
          'A foil is measured against what you paid for the foil, not against the plain version, so foils no longer show an invented loss. Hold a card both plain and foil and each gets its own figure.',
      },
      {
        kind: 'changed',
        text:
          'The price chart draws the nonfoil price, the only one we record daily, and now says so on a foil card. Where a starting price had to be estimated from it, the change is marked "(est.)".',
      },
    ],
  },
  {
    version: '0.147.7',
    changes: [
      {
        kind: 'changed',
        text:
          'The collection sorts by "Value change" and "Value change %" now, measured since you got each card, which is the same figure the card sheet shows. Price movers is still the place for a fixed 7, 30 or 90 day window.',
      },
      {
        kind: 'fixed',
        text:
          'Cards with no recorded purchase price are valued from the reading closest to the day they went in, so the ones you owned before the app tracked prices join the sort instead of falling to the bottom. Those say "since you got it" rather than "since you paid".',
      },
    ],
  },
  {
    version: '0.147.6',
    changes: [
      {
        kind: 'fixed',
        text:
          'Sorting the collection by price change barely sorted anything. Each card was measured from its own first reading, so the order tracked how long you had owned a card rather than what its price did. Both price-change sorts now cover the same seven days for every card, the window the arrows on the tiles use, and a dollar move is converted before it is weighed against a euro one.',
      },
    ],
  },
  {
    version: '0.147.5',
    changes: [
      {
        kind: 'fixed',
        text:
          'Two special conditions on one copy left the card sheet showing "Altere…". It now says "2 selected", and the four dropdowns share out the width by what they hold, so a long answer stops getting cut off.',
      },
    ],
  },
  {
    version: '0.147.4',
    changes: [
      {
        kind: 'changed',
        text:
          'Condition, finish and language now open inside the card sheet, the way Special does, instead of as a box in the middle of the screen. One at a time, all at the same line spacing, capped at five rows with the current answer already in view.',
      },
    ],
  },
  {
    version: '0.147.3',
    changes: [
      {
        kind: 'changed',
        text:
          'The card sheet puts the rules text up beside the art, and the price and "filed in" pills down at the top of the form. The text is never folded away now, so highlighting a phrase to search for it always works.',
      },
      {
        kind: 'changed',
        text:
          'Condition, finish, language and "special" are four dropdowns on one line, for trade is back next to the quantity, and the edition line says the set code so the collector number fits.',
      },
      {
        kind: 'changed',
        text: 'A tall card sheet grows up to the search bar before anything has to scroll.',
      },
    ],
  },
  {
    version: '0.147.2',
    changes: [
      {
        kind: 'added',
        text: 'A `set:` term in the card search now lists that set’s printings one by one, instead of one tile per card in your preferred printing. `forest set:blb` shows all five Bloomburrow Forests, and tapping one opens on that printing.',
      },
      {
        kind: 'added',
        text: 'The search bar suggests set codes. Type `set:` for the newest sets, or part of a name to narrow it — each code comes with the full set name beside it.',
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
