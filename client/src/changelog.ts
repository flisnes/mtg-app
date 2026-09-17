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
  {
    version: '0.153.1',
    changes: [
      {
        kind: 'changed',
        text:
          'Your commander leads the On curve panel now, with its own chart. It waits in the command zone rather than in your library, so the odds of casting it on turn four are purely about your mana, and every game in the run counts toward the number.',
      },
    ],
  },
  {
    version: '0.153.0',
    changes: [
      {
        kind: 'added',
        text:
          'On curve, in the deck stats sheet. It deals twenty thousand games, mulligans them and plays the land drops out in order, so it can tell a tapland played on turn one from the same tapland on turn three. Pick any card and see how often your mana actually pays for it by each turn.',
      },
      {
        kind: 'added',
        text:
          'Fetchlands now take the land they find out of the library, so eight fetches over a single Island count as one blue source, the same as at the table.',
      },
      {
        kind: 'fixed',
        text:
          'Split, adventure and modal cards had both halves of their printed cost added together, so an Adventure creature costing {W} was checked as if it cost {1}{W}{W} and read as uncastable.',
      },
    ],
  },
  {
    version: '0.152.0',
    changes: [
      {
        kind: 'added',
        text: 'Opening hand, in the deck stats sheet. How often your deck hands you a keepable seven, how many cards you start with on average, and what each opening hand is worth: a one-lander is 18% to have three lands by turn three, a two-lander 66%.',
      },
      {
        kind: 'added',
        text: 'The keep rule is a search, same as the draw-odds group. Two to five lands is the default; two to five untapped sources, or one cheap spell, is a stepper and a query away.',
      },
    ],
  },
  {
    version: '0.151.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Fetchlands count as colored sources. They tap for nothing, so the new colored-source report could not see them at all, and an eight-fetch manabase read far worse than it plays. A fetch now counts for every color of every land it could actually find in your deck.',
      },
      {
        kind: 'changed',
        text: 'Evolving Wilds and the other fetches that cost you a turn count from turn two, and show up in the tapland tax where they used to slip past it.',
      },
    ],
  },
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
