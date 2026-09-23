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
  {
    version: '0.166.0',
    changes: [
      {
        kind: 'added',
        text:
          'Who does the work now lists the draw and ramp cards the simulator plays as nothing, at 0 and in amber. Tap one to write what it does.',
      },
    ],
  },
  {
    version: '0.165.0',
    changes: [
      {
        kind: 'added',
        text:
          'Flow opens on Screw and flood: how often you are screwed or flooded by turn six, a turn-by-turn table, and how much mana you really have on any turn ("at least 6 on turn 6 in 33% of games").',
      },
    ],
  },
  {
    version: '0.164.0',
    changes: [
      {
        kind: 'changed',
        text:
          'The Mana tab answers "can I cast it on time" once: Cast on time lists your commander and every late cost with the reason it was late, total mana, a color, or a tapland. Colored sources no longer gives a second, different verdict.',
      },
    ],
  },
  {
    version: '0.163.0',
    changes: [
      {
        kind: 'added',
        text:
          'Deck analysis opens on a new Overview tab: one row each for Mana, Flow and Model, saying how it looks and what to do next. Tap a row for the details.',
      },
      {
        kind: 'changed',
        text:
          'Much less small print in Deck analysis: one caveat per section, the rest behind "How this is worked out". "What each card is worth" is now "Who does the work".',
      },
    ],
  },
  {
    version: '0.162.0',
    changes: [
      {
        kind: 'changed',
        text:
          'Deck stats is now Deck analysis, a page of its own with three tabs: Mana, Flow and Model. A bar at the top stays on screen and holds the one play/draw switch (there used to be three), the play style and how much of the deck is modelled. Tap either chip to go to the Model tab, where card behavior now lives.',
      },
      {
        kind: 'fixed',
        text:
          'The simulator now mulligans on your Opening hand keep rule. It always kept two to five lands whatever you set, so changing the rule moved one panel and nothing else. The rule is remembered per deck.',
      },
    ],
  },
  {
    version: '0.161.0',
    changes: [
      {
        kind: 'added',
        text:
          'The colored-source panel now shows what was actually on the battlefield. The counts at the top assume every copy in your deck is in play at once; the new block under them counts the sources the simulation really had, per color, on the turn you pick. A deck with a Yavimaya is told it has 40 green sources, and told two rows later that 2.3 of its 4.0 sources make green on turn four.',
      },
      {
        kind: 'added',
        text:
          'A fourth tile on the deck stats sheet, saying how many of your cards the model plays out rather than resolving as nothing.',
      },
      {
        kind: 'changed',
        text:
          'The Card behavior line leads with unread draw spells now, instead of counting every removal spell as a card that does nothing.',
      },
    ],
  },
  {
    version: '0.160.0',
    changes: [
      {
        kind: 'added',
        text:
          '"Watch one game play out" now shows the board in card images: permanents on the top row, lands on the bottom, copies stacked with a count. It follows you as you scroll the turns, and buttons open your hand, graveyard and exile. Every line of the turn-by-turn text is still there under it.',
      },
      {
        kind: 'added',
        text:
          'Play style, under Card behavior. Pick how the simulator spends a turn (ramp first, card draw first, creatures first, or cheapest first), who attacks (only when it triggers something, everything, or nobody), and whether instants get cast or held up. Every number in the stats sheet moves with it.',
      },
      {
        kind: 'added',
        text:
          'A damage chart, for the decks that deal any. It counts what an opponent would have taken, combat and spells apart, and there is a new "Deal X damage" step so you can write a burn spell out by hand.',
      },
    ],
  },
  {
    version: '0.159.4',
    changes: [
      {
        kind: 'fixed',
        text:
          'Cards like Arboreal Grazer no longer hand you an extra land drop every turn. The card database was reading anything that puts a land onto the battlefield as an Exploration; it now wants the card to actually say "on each of your turns". Azusa correctly grants two.',
      },
      {
        kind: 'changed',
        text:
          'Every effect the simulator gives a card is now listed in the card behavior editor, including extra land drops and what a land, rock or mana creature taps for. Writing your own rule replaces the derived reading outright, so you can say a card does not do the thing we read off it.',
      },
      {
        kind: 'added',
        text:
          'A move onto the battlefield can now arrive untapped, so a land put into play by a rule pays for something that turn. An "Add X mana" step can now name its colors: one color, a few, or any.',
      },
    ],
  },
  {
    version: '0.159.3',
    changes: [
      {
        kind: 'added',
        text:
          'Rituals now put mana in your mana pool and the simulator spends it. A Dark Ritual used to resolve as a blank; it is now three black mana for the rest of that turn, gone at the end of it. The sequencer only casts one when something in hand is waiting on it.',
      },
      {
        kind: 'added',
        text:
          'An "Add X mana" step for card behavior, for the mana that evaporates at end of turn. A landfall trigger that adds a mana is now writable; the Treasure step is still there for the mana that keeps.',
      },
    ],
  },
  {
    version: '0.159.2',
    changes: [
      {
        kind: 'changed',
        text:
          'What each card is worth now scores one copy rather than the whole stack. Twenty basics added together buried every other card in the list and only told you that you run twenty basics. A Forest is now judged against a Sol Ring, and rows with several copies still show what all of them come to.',
      },
    ],
  },
  {
    version: '0.159.1',
    changes: [
      {
        kind: 'added',
        text:
          'What each card in your deck is worth. A new line under the trajectory charts splits both curves up by the card that made them, so you can see which of your cards puts your mana online and which of them finds you your cards. A land another card fetched counts for the card that fetched it, and a card drawn off a trigger counts for the permanent that triggered.',
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
