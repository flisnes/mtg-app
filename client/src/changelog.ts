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
  {
    version: '0.159.0',
    changes: [
      {
        kind: 'added',
        text:
          'Two triggers that watch the rest of the game: "when another permanent enters" and "when you cast another spell". Say which cards count with the same search syntax as everywhere else, so t:land is landfall, t:instant or t:sorcery is magecraft, and t:creature is a Beast Whisperer.',
      },
      {
        kind: 'added',
        text:
          'That makes most deck engines writable. A permanent sitting on the battlefield can draw, ramp, mill or make Treasure every time it sees what it is waiting for, and the curves finally count it.',
      },
    ],
  },
  {
    version: '0.158.8',
    changes: [
      {
        kind: 'added',
        text:
          'The simulator knows what is on your battlefield, not just what taps for mana. A sacrifice can go and find a creature, and "X = your creatures" and "X = the greatest power" are amounts you can pick.',
      },
      {
        kind: 'added',
        text:
          'Two more triggers: "when it attacks" and "when it dies". There is a combat step now, with no blockers, no damage and no life total. Nothing attacks the turn it arrives.',
      },
      {
        kind: 'added',
        text:
          'Flicker a permanent and everything it does on the way in happens again. The trigger picker is a dropdown now, because five of them will not sit abreast on a phone.',
      },
    ],
  },
  {
    version: '0.158.7',
    changes: [
      {
        kind: 'added',
        text:
          '"When played" has split into "when played" and "when it enters". A creature dragged back out of the graveyard was never cast, so only the second one fires for it, and a permanent you hard-cast does both.',
      },
      {
        kind: 'fixed',
        text:
          'A rule written on a fetchland now actually fires. The simulator was resolving the land it found and never the fetch itself, so a behavior authored on a Flooded Strand was a rule you could write, save, and never once see happen.',
      },
      {
        kind: 'fixed',
        text:
          'A fetchland put onto the battlefield some other way cracks for a land instead of sitting there as a land that taps for every colour it could have found.',
      },
    ],
  },
  {
    version: '0.158.6',
    changes: [
      {
        kind: 'changed',
        text:
          'The twenty-card ceiling on what one behavior step can do is gone. "Draw half your library" in a 99-card deck really is 49 cards now, so the curve for a Peer Into the Abyss deck is the curve for a deck that contains one.',
      },
      {
        kind: 'added',
        text:
          'Division comes in two flavours: rounded down and rounded up, because the cards print both. The operator now sits next to the amount as a symbol, blank until you pick one.',
      },
      {
        kind: 'added',
        text:
          'The card behavior editor shows the card. Writing a rule means reading the card, and reading it off a name alone was a memory test.',
      },
    ],
  },
  {
    version: '0.158.5',
    changes: [
      {
        kind: 'added',
        text:
          'Card behavior can now say "the previous X": the number the step before it actually reached. That is what a Windfall needs, since the hand it draws for is already in the graveyard by the time it draws.',
      },
      {
        kind: 'added',
        text:
          'Any amount can be adjusted: plus, minus, times or divided by a number. Dark Deal is the previous X minus 1, Peer Into the Abyss is your library divided by 2. "Cards in your library" is a new amount too.',
      },
    ],
  },
  {
    version: '0.158.4',
    changes: [
      {
        kind: 'fixed',
        text:
          'Ramp spells were ramping twice once you wrote a rule for them. Harrow, Into the North, Three Visits and the rest are read as land ramp off the mana data, not the oracle text, so the card behavior screen filed them under "nothing read yet" and the simulator fetched a land anyway. They now say what the database reads, and your own rule replaces it instead of stacking on top.',
      },
      {
        kind: 'fixed',
        text:
          'A move step with criteria took the topmost match in your library rather than a random one, so the copy that left was always the copy you would have drawn soonest. Worth about 6% of a ramp deck\'s mana by turn six.',
      },
    ],
  },
  {
    version: '0.158.3',
    changes: [
      {
        kind: 'added',
        text:
          'Card behavior can put cards on the top or the bottom of your library, and a card can talk about itself. A tutor that puts the card on top, a spell that exiles itself instead of hitting the graveyard, a Green Sun\'s Zenith that shuffles back in: all one step now.',
      },
      {
        kind: 'changed',
        text:
          'A card put into the library on its own lands in a random spot, which is what shuffling it back in means. Top and bottom go where they say, and several cards sent to either arrive in a random order.',
      },
      {
        kind: 'fixed',
        text: 'Moving a card back into the library used to drop it in most decks. It goes back in now.',
      },
    ],
  },
  {
    version: '0.158.2',
    changes: [
      {
        kind: 'added',
        text:
          'Card behavior criteria can read X. Write `[X]` anywhere a number goes, like `t:creature mv<=[X]`, and pick what it is worth from the dropdown that appears: the mana you spent on X, the cards in your hand, the lands you control. `[X-1]` and `[X+2]` work too. The editor shows the range it matches as you type.',
      },
      {
        kind: 'changed',
        text:
          'The simulator now pays for X. It used to treat a Fireball as a one-mana spell and leave the rest of the turn unspent. X spells are cast last, take whatever mana is left over, and are held rather than cast for nothing. Expect the "mana spent" line to sit closer to the "mana available" line in any deck that plays one.',
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
