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
  {
    version: '0.147.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Search ignores apostrophes, hyphens and commas: "lions" finds Lion’s Eye Diamond and "bond kin" finds Ainok Bond-Kin. Æ counts as "ae" both ways, so "aether charge" and "Æther Charge" find the same card.',
      },
    ],
  },
  {
    version: '0.147.0',
    changes: [
      {
        kind: 'changed',
        text: 'The card sheet is rebuilt around the card: a bigger picture, two columns on a desktop, and condition/finish/language on one tappable line. Nothing on it is greyed out any more: a copy you are only looking at reads as text instead of dead dropdowns.',
      },
      {
        kind: 'changed',
        text: 'The Details / History tabs are gone. The card’s own history is in the ⋯ menu as "Collection history", next to price history and a searchable "All printings". More -> "Edit history" got the same name.',
      },
      {
        kind: 'added',
        text: '"For trade", "altered, signed, misprint" and slot tags are links that open when you want them, so even a card in a deck now fits one phone screen.',
      },
    ],
  },
  {
    version: '0.146.0',
    changes: [
      {
        kind: 'added',
        text: 'Cards in a language you don’t collect in now wear a small flag next to their badges — in your collection, in decks and boxes, and in a trade. Pick the language you collect in under Settings -> Language.',
      },
    ],
  },
  {
    version: '0.145.4',
    changes: [
      {
        kind: 'fixed',
        text: 'The "Since acquisition" chart put two unrelated figures on one line: the gain, and how far that gain had moved since the chart started. It now reads the gain and the same gain as a share of what you paid.',
      },
    ],
  },
  {
    version: '0.145.3',
    changes: [
      {
        kind: 'changed',
        text: 'A card now shows how much it has gained or lost against what you paid for it, not against the day we started recording prices. Cards that came in without a price still show the recorded movement.',
      },
      {
        kind: 'added',
        text: 'The price charts pan and zoom. Scroll or pinch to zoom, drag to move along the line, double-tap to reset.',
      },
      {
        kind: 'added',
        text: 'Decks, binders and boxes carry a total value in the header. Tap it for that container’s value over time, including what its cards have gained since you got them.',
      },
      {
        kind: 'removed',
        text: 'The little graph on a container’s History panel. It drew card counts in the price chart’s clothes, which read as money.',
      },
    ],
  },
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
