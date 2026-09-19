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
  {
    version: '0.158.1',
    changes: [
      {
        kind: 'added',
        text:
          'Card behavior can move cards between zones. One step covers tutoring, ramping a land into play, regrowth, bouncing and putting a card back: pick a zone to take from, a zone to put it in, and how many. Which cards it finds is a card-search query, so `t:basic` means here what it means in the search bar, and the editor counts the matches in your deck as you type.',
      },
      {
        kind: 'changed',
        text:
          'The simulator keeps a graveyard now, filled by everything that fills one: milling, discarding, a cracked fetch, and every spell that is not a permanent. So a rule that goes looking in the yard finds what should be there.',
      },
    ],
  },
  {
    version: '0.158.0',
    changes: [
      {
        kind: 'added',
        text:
          'Tell the simulator what a card actually does. Deck stats → Card behavior lists every card in the deck with what the model currently thinks it does ("Do nothing" for most of them), and you pick: when played or each upkeep, then draw / mill / discard / scry / surveil / make Treasures, with X a fixed number or the cards in your hand, the lands you control or the turn number. Steps run in the order you write them, so a loot that discards first draws for a smaller hand.',
      },
      {
        kind: 'added',
        text:
          'Cards you author are counted on the coverage line under the charts. The curves stop being a pure floor once you have told the model something, and the panel says how many cards that is rather than quietly changing what the numbers mean.',
      },
    ],
  },
  {
    version: '0.157.1',
    changes: [
      {
        kind: 'added',
        text:
          '"Watch one game play out", under the deck stats charts. One game, turn by turn: what it drew, which land it played and which it passed over, every permanent it tapped and what that mana paid for, and why it stopped casting. Deal another whenever you want.',
      },
      {
        kind: 'fixed',
        text:
          'Treasures stayed around too long. One spent to fix a colour rather than to add a mana was never sacrificed. The trace is what caught it.',
      },
    ],
  },
  {
    version: '0.157.0',
    changes: [
      {
        kind: 'changed',
        text:
          'The simulator resolves your spells instead of casting them as blanks. Draw, loot, mill, surveil, scry and Treasure all happen now, a Phyrexian Arena keeps drawing every upkeep, and an Exploration is a second land drop rather than a dead card. The "How the game unfolds" charts move with it.',
      },
      {
        kind: 'added',
        text:
          'A line under those charts saying how much of your deck the model actually plays out, and naming the draw spells it knows it is missing. The curves are still a floor, but now you can see how far off the floor they are.',
      },
    ],
  },
  {
    version: '0.156.0',
    changes: [
      {
        kind: 'added',
        text:
          'The card database now knows what your spells do, not just what they cost: how much they draw, discard, mill, surveil, scry or make in Treasure. Nothing reads it yet. It is what the simulator needs to stop casting your draw spells as blanks.',
      },
      {
        kind: 'changed',
        text:
          'Because every card in the database moved, your next card-DB refresh downloads the whole thing rather than the usual few kilobytes.',
      },
    ],
  },
  {
    version: '0.155.0',
    changes: [
      {
        kind: 'added',
        text:
          'Deck stats has a new "How the game unfolds" section: mana available against mana spent, and cards seen against cards in hand, charted over the first eight turns. The gap between what you have and what you spend is the part worth looking at.',
      },
      {
        kind: 'changed',
        text:
          'The simulator now spends the whole turn instead of casting one ramp spell and stopping. Ramp first, then the rest of the hand, priciest first.',
      },
      {
        kind: 'fixed',
        text:
          'The colored-source report used to ask for more sources than a deck that size could hold, so a mono-black deck was told it was short of black. Where the target is out of reach it now tells you which turn the card comes online instead.',
      },
    ],
  },
  {
    version: '0.154.0',
    changes: [
      {
        kind: 'added',
        text:
          "Deck stats now tells you what to do about a colored-source shortfall, out of the cards you already own. \"Two white sources short\" becomes \"+2 Tundra, 2 spare in Binder: Duals\", and one tap files them into the deck. Cards another deck is holding are named but never suggested.",
      },
      {
        kind: 'fixed',
        text: "The On curve panel's play/draw toggle was squashed to a hairline on a phone.",
      },
    ],
  },
  {
    version: '0.153.2',
    changes: [
      {
        kind: 'fixed',
        text:
          "The mana model counted a lot of cards as sources that are not. Caged Sun, Mirari's Wake, Vorinclex and every Treasure-maker cause mana without making any, and were being counted as mana rocks. Nykthos and the Cave and Gate lands were counted as six-color sources when their free ability makes one colorless.",
      },
      {
        kind: 'fixed',
        text:
          "Urborg, Yavimaya and Chromatic Lantern now make every land in your deck a source of what they grant, which is the one thing the mana report was under-counting. Lotus Field makes three of one color rather than one of each, costs you the two lands it eats, and Urza's Saga and the depletion lands stop producing when they run out.",
      },
      {
        kind: 'changed',
        text:
          'Because every card in the database moved, your next card-DB refresh downloads the whole thing rather than the usual few kilobytes.',
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
