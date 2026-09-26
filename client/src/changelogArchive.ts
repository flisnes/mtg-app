// The older half of the changelog (0.172.1 down to 0.98.0), split out of
// changelog.ts so its weight lands in its own chunk. Reached only through
// loadChangelog() — the About page's full history, or a device that's been
// offline for a very long time.
//
// Append-only from the top as entries age out of CHANGELOG_RECENT. Nothing
// here is ever edited; these releases already shipped.
import type { ChangelogEntry } from './changelog.js';

export const CHANGELOG_ARCHIVE: ChangelogEntry[] = [
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
  {
    version: '0.144.2',
    changes: [
      {
        kind: 'changed',
        text: '"Assemble from my collection" now puts the copies matching what the slot asked for first. If a line names a printing, finish, language or condition, the copies that fit lead the grid instead of sitting below the newest edition.',
      },
    ],
  },
  {
    version: '0.144.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Re-scanning a deck, binder or box now files the copies you scanned into it, so they turn green like they do when you use "Scan cards". Before, the cards and counts were right but nothing was actually holding them. A re-scan whose counts already match is no longer a no-op either.',
      },
    ],
  },
  {
    version: '0.144.0',
    changes: [
      {
        kind: 'added',
        text: 'Filing a card from its sheet now asks which copies are going in when you own more than one. Tap a copy to send it, tap again for a second, then File. The copy you opened starts out picked, and the ones the container already holds are greyed out.',
      },
    ],
  },
  {
    version: '0.143.3',
    changes: [
      {
        kind: 'fixed',
        text: 'Filing a card into a deck, binder or box that already holds copies of it no longer promises copies you do not own. Own two with one already filed there, and filing puts the loose copy away instead of claiming a third and warning you about it.',
      },
    ],
  },
  {
    version: '0.143.2',
    changes: [
      {
        kind: 'fixed',
        text: '"Filed: Nowhere" hid cards you own two of when one copy was filed away. A line with copies still loose now shows up under it, so selecting them all catches everything left in the shoebox.',
      },
    ],
  },
  {
    version: '0.143.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Sorting by "Last edited" threw the card you just changed to the top and then dropped it back down. It now reads each copy’s own timestamp, so the card stays where it belongs — and only the copy you touched moves. Edit one edition of a Forest and the rest stay put; change the Italian copy and the English one does not budge. Filing a card into a deck, binder or box, or taking it out, counts as an edit too.',
      },
    ],
  },
  {
    version: '0.143.0',
    changes: [
      {
        kind: 'added',
        text: 'Mark a copy you own as altered, signed, misprint, miscut or crimped — any combination of them — from the new Special dropdown on a collection card. Those copies wear an amber A, and they sit on their own line, so your altered copy no longer shares a row with the plain one. Matching is untouched: a signed card still fills a deck slot and still answers a wish.',
      },
    ],
  },
  {
    version: '0.142.0',
    changes: [
      {
        kind: 'added',
        text: 'Decks can be archived. An Archived folder sits under the deck list, greyed out until you use it. Archiving keeps the whole list but takes the deck out of the list of decks you play, and asks whether to unfile its cards so your other decks can have the copies back. Restore it any time from the options menu.',
      },
    ],
  },
  {
    version: '0.141.9',
    changes: [
      {
        kind: 'changed',
        text: 'Cards start higher up on the collection, wishlist and tradelist. The blurb under the title is gone and the count moved up next to it. Another user’s full list lost its own search box, since the header search already reaches their lists.',
      },
    ],
  },
  {
    version: '0.141.8',
    changes: [
      {
        kind: 'changed',
        text: 'The search bar in the header now searches every card, instead of starting on the list you were standing on. Each list keeps a magnifying glass next to Select for searching just that list, and the scope pills still switch either way.',
      },
    ],
  },
  {
    version: '0.141.7',
    changes: [
      {
        kind: 'fixed',
        text: 'The Bloomburrow paw print renders as a paw again. Cards that spend paw prints on their modes were showing the Phyrexian mana pip instead.',
      },
    ],
  },
  {
    version: '0.141.6',
    changes: [
      {
        kind: 'fixed',
        text: 'Cards now load in whole rows. A batch that ended mid-row looked like the end of the list and stopped people scrolling for the rest.',
      },
    ],
  },
  {
    version: '0.141.5',
    changes: [
      {
        kind: 'changed',
        text: 'Deck, binder and box rows keep their value and options button at the right edge, so they line up down the list instead of drifting with the badges.',
      },
    ],
  },
  {
    version: '0.141.4',
    changes: [
      {
        kind: 'changed',
        text: 'Visual stacks are now the default view on the trade board and in the scanned card list, and the card at the bottom of a stack always shows in full. Tiles and rows are still one tap away on the toggle.',
      },
    ],
  },
  {
    version: '0.141.3',
    changes: [
      {
        kind: 'added',
        text: 'The scanned-cards list shows a price on both card layouts now, and a total value for everything you scanned above the Add button.',
      },
    ],
  },
  {
    version: '0.141.2',
    changes: [
      {
        kind: 'changed',
        text: 'Finish, condition and language in the scanner are now buttons that cycle through the options instead of dropdowns. One tap per step, and they are bigger to hit.',
      },
    ],
  },
  {
    version: '0.141.1',
    changes: [
      {
        kind: 'changed',
        text: 'In the scanner, the set symbol now sits above each card in the row and is bigger. The plus and minus buttons have rings around them so they stay visible on light card borders and busy art.',
      },
    ],
  },
  {
    version: '0.141.0',
    changes: [
      {
        kind: 'added',
        text: 'Visual stacks: a view where cards overlap down the column with only their names showing, and the set, quantity and price beside them. Tap a card to open it fully. Toggle it on the trade board or in the scanned cards list.',
      },
    ],
  },
  {
    version: '0.140.6',
    changes: [
      {
        kind: 'fixed',
        text: 'The scanner card row now scrolls back to the start for every new card, including the next copy of the card you just scanned.',
      },
    ],
  },
  {
    version: '0.140.5',
    changes: [
      {
        kind: 'changed',
        text: 'The card row in the scanner holds still while you pick a printing. Scrolling or tapping it freezes the row (the bar on top shows for how long), and a new card in frame waits instead of shifting the printings under your finger.',
      },
      {
        kind: 'fixed',
        text: 'A confirmed edition no longer jumps to the front of a row you have started scrolling through. It still gets the green check.',
      },
    ],
  },
  {
    version: '0.140.4',
    changes: [
      {
        kind: 'added',
        text: 'Scanning into a deck, binder or box now asks what your collection should do with every card, not just the ones you own no copy of. Per card: Skip, Add a second copy, or Update to the printing you scanned.',
      },
    ],
  },
  {
    version: '0.140.3',
    changes: [
      {
        kind: 'added',
        text: 'Escape leaves select mode, so the ✕ on the bulk bar is no longer the only way out.',
      },
    ],
  },
  {
    version: '0.140.2',
    changes: [
      {
        kind: 'fixed',
        text: 'In grid view the keyboard cursor was a thin line drawn on the card’s own black border, and it faded out on cards you do not own. It is a proper ring around the tile now, and the card you are pointing at is no longer greyed out.',
      },
    ],
  },
  {
    version: '0.140.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Arrowing through a deck kept scrolling the card you were pointing at underneath the tab bar, so its purple outline was invisible. The cursor now stops where you can see it.',
      },
    ],
  },
  {
    version: '0.140.0',
    changes: [
      {
        kind: 'changed',
        text: 'The scanner’s set pin is a dropdown of the card’s editions instead of a checkbox that guessed from the card in frame. Set symbols, years, and a search box, so a card with twenty reprints pins the set you are actually holding.',
      },
      {
        kind: 'changed',
        text: 'A pinned set also pinpoints editions faster. When the pin leaves one printing standing, the reader does not have to run: the green check lands as the card locks, and auto-add drops the copy straight in.',
      },
    ],
  },
  {
    version: '0.139.1',
    changes: [
      {
        kind: 'added',
        text: 'Press ? for the full list of keyboard shortcuts, which were all invisible until now. Also new: + adds the search result you are pointing at, / jumps to the search box, v switches list and grid, and x ticks a card for a bulk action.',
      },
    ],
  },
  {
    version: '0.139.0',
    changes: [
      {
        kind: 'added',
        text: 'Deck building from the keyboard. Point at a card and press + or - to change its copies, Enter to open it, Delete to remove it, and the arrow keys to walk between cards. Ctrl+K jumps to the search box. A run of + presses now folds into one line in the edit history.',
      },
    ],
  },
  {
    version: '0.138.0',
    changes: [
      {
        kind: 'added',
        text: 'Copy, cut and paste cards on a deck, binder or box. Ctrl+C gives you a decklist anywhere else and the exact printings back in the app, Ctrl+X moves cards between decks in one undoable step, and Ctrl+V on a list from any website opens the import review already filled in. Ctrl+A selects the lot.',
      },
    ],
  },
  {
    version: '0.137.0',
    changes: [
      {
        kind: 'added',
        text: "Ctrl+Z undoes your last change on the page you're looking at, Ctrl+Y puts it back (Cmd on a Mac). Neither reaches into a deck you've navigated away from, and both leave your typing alone.",
      },
    ],
  },
  {
    version: '0.136.0',
    changes: [
      {
        kind: 'changed',
        text: 'Undo in the edit history is no longer limited to the newest entry. Any change can be reversed as long as nothing newer has touched the same copies, filters and all.',
      },
    ],
  },
  {
    version: '0.135.8',
    changes: [
      {
        kind: 'fixed',
        text: "Buttons whose work fails now tell you, instead of looking like they did nothing. Fifteen of them were silent before, from editing a price in a card's history to changing how many sealed boxes you own.",
      },
    ],
  },
  {
    version: '0.135.5',
    changes: [
      {
        kind: 'fixed',
        text: "A device running an older version no longer strips fields off your own synced data, and no longer skips rows it doesn't understand yet. Both used to need a full re-download of the account to repair.",
      },
    ],
  },
  {
    version: '0.135.4',
    changes: [
      {
        kind: 'fixed',
        text: 'Back no longer skips a page when you close the search overlay or a card sheet. Each one parks its own history entry now instead of guessing which entry was its own, so back peels off exactly one layer at a time.',
      },
    ],
  },
  {
    version: '0.135.3',
    changes: [
      {
        kind: 'added',
        text: 'Unfile now offers the deck, binder or box you are standing in. The card stays on the list, still asking for the same copy, but stops holding one: the green filed badge drops to the double checkmark and the copy is free for another deck. "File back here" puts it back.',
      },
    ],
  },
  {
    version: '0.135.2',
    changes: [
      {
        kind: 'fixed',
        text: 'Pulling down to refresh works again. A fix in 0.134.5 pinned the gesture to the page and disabled the browser refresh along with it; the problem it was aimed at turned out to be already handled elsewhere.',
      },
    ],
  },
  {
    version: '0.135.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The small print under a deck, binder or box in a list is small and dim again, instead of full-size text spread across the row.',
      },
      {
        kind: 'changed',
        text: 'The app downloads a little less on first open. Older release notes now load only when you go looking for them.',
      },
    ],
  },
  {
    version: '0.135.0',
    changes: [
      {
        kind: 'added',
        text: 'Card search now sorts: best match, name, mana value or price, either direction. Sorting by price ranks every hit, not just the page on screen.',
      },
      {
        kind: 'added',
        text: "Search scoped into your collection, tradelist, wishlist or a deck offers that list's own sort options, and reordering there reorders the list itself.",
      },
    ],
  },
  {
    version: '0.134.9',
    changes: [
      {
        kind: 'changed',
        text: 'Recent searches now drop down from the search bar as a small see-through panel instead of filling the screen. Arrow keys walk the list, Enter picks one.',
      },
      {
        kind: 'changed',
        text: 'The search bar remembers 500 past searches, up from 10, and narrows them to whatever you are typing.',
      },
    ],
  },
  {
    version: '0.134.8',
    changes: [
      {
        kind: 'added',
        text: 'About now has an "Open source licenses" page listing the 28 components the app is built on, each with its copyright and licence in full. The licences ask to be shipped with the app, and now they are.',
      },
      {
        kind: 'added',
        text: 'MTGJSON is now credited for sealed product data, as its licence requires, along with TCGCSV and Cardmarket for sealed prices and Andrew Gioia for the set and mana symbol fonts.',
      },
    ],
  },
  {
    version: '0.134.7',
    changes: [
      {
        kind: 'fixed',
        text: 'Deck, binder and box emblems that went missing on another device are back. A device still on an older build when emblems shipped dropped them on the way in and never asked again; it now re-reads your account once and restores them.',
      },
    ],
  },
  {
    version: '0.134.6',
    changes: [
      {
        kind: 'added',
        text: '"Pick one from my collection" now has a "Not here? Add a copy" line under the grid, for when the edition you are holding never made it into the collection. Add it there and that copy fills the slot you were on.',
      },
    ],
  },
  {
    version: '0.134.5',
    changes: [
      {
        kind: 'fixed',
        text: 'Swiping down at the top of a page no longer slides the bottom nav bar half off the screen. The gesture was reaching the browser instead of stopping at the page.',
      },
    ],
  },
  {
    version: '0.134.4',
    changes: [
      {
        kind: 'changed',
        text: 'The trade tag and wishlist star now fill in solid when the printing on screen is the one on your list, and stay tinted when it is some other edition. A wish on "any printing" always counts as a match.',
      },
    ],
  },
  {
    version: '0.134.3',
    changes: [
      {
        kind: 'added',
        text: 'Cards on your wishlist now show a gold star in search results and on deck slots, so you can see what you are already hunting. Your own wishlist stays unstarred.',
      },
      {
        kind: 'changed',
        text: 'Adding a card to your collection, tradelist or wishlist from its sheet now says which list it went to before the sheet closes.',
      },
    ],
  },
  {
    version: '0.134.2',
    changes: [
      {
        kind: 'added',
        text: 'Tap the app version in About to read the full release notes, all versions, scrollable. No more catching them once and losing them.',
      },
    ],
  },
  {
    version: '0.134.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Two different printings of one card filed into a binder or box no longer collapse into a single line with the second printing thrown away. Same printing twice, or "any printing", still pools onto one line.',
      },
    ],
  },
  {
    version: '0.134.0',
    changes: [
      {
        kind: 'added',
        text: 'New accounts arrive with a profile picture: one of 145 card arts, framed on the face and dealt at random. Change it to any card you like from your profile.',
      },
    ],
  },
  {
    version: '0.133.2',
    changes: [
      {
        kind: 'added',
        text: 'Symbol and set-symbol emblems can be tinted: pick one of ten colours above the grid, then pick your symbol. Tap a colour while a symbol is already set and it recolours on the spot.',
      },
    ],
  },
  {
    version: '0.133.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Updating to 0.133.0 could leave a signed-in device stuck syncing, with most of its collection, decks and lists missing and cards flickering in and out. Nothing was lost: your account on the server was never touched, and this version pulls the whole thing back down.',
      },
    ],
  },
  {
    version: '0.133.0',
    changes: [
      {
        kind: 'added',
        text: 'Decks, binders and boxes can wear an emblem in the list: a crop of any card’s art, a mana pip or other Magic symbol, or a set symbol. Open the ⋯ menu on a row, or tap the icon next to the name on its own page. It syncs to your other devices with the rest of the deck.',
      },
    ],
  },
  {
    version: '0.132.0',
    changes: [
      {
        kind: 'changed',
        text: 'The scanner’s padlock ring now fills as the camera closes in on a card, so you can see how near it is to locking. It comes full at the lock, then drains through the few seconds before the scanner will take a second copy of the same card. Tap it to let go at once.',
      },
    ],
  },
  {
    version: '0.131.0',
    changes: [
      {
        kind: 'added',
        text: 'Scanning reads the copyright year now, so it can finally tell a 4th Edition card from a 5th Edition one. Cards that old print no set code and no collector number, and the year is often all that separates two reprints.',
      },
      {
        kind: 'fixed',
        text: 'Scanning was reading only the left half of a card’s bottom line, which is exactly where cards printed between 1998 and 2014 do not keep their collector number. It reads the whole line now.',
      },
      {
        kind: 'changed',
        text: 'When nothing printed on the card can identify the edition, scanning says so instead of guessing. Alpha through Revised carry no year, number or set code at all.',
      },
    ],
  },
  {
    version: '0.130.0',
    changes: [
      {
        kind: 'fixed',
        text: 'A trade of more than about 160 cards now reaches your other devices. It saved locally but the sync of it failed silently, because the server rejected any single row that large.',
      },
      {
        kind: 'changed',
        text: 'Deleting a card no longer leaves a permanent marker on the server. The markers clear once every device on your account has seen them. A device left offline for months now refreshes from your account instead of showing cards you deleted, and anything it had queued up is sent first.',
      },
      {
        kind: 'changed',
        text: 'Accounts now have a stated storage limit, set at roughly four times the largest collection we have measured. Deleting things always works even at the limit.',
      },
      {
        kind: 'changed',
        text: 'Deck, binder and box names stop at 200 characters, which was already the limit everywhere else.',
      },
    ],
  },
  {
    version: '0.129.8',
    changes: [
      {
        kind: 'fixed',
        text: 'Searching your collection, tradelist, wishlist, a deck or a binder with set:znr now finds the copies you own from that set. It only worked in the card search before. is:foil, is:promo and the other printing keywords work there too, and match the copy itself.',
      },
    ],
  },
  {
    version: '0.129.7',
    changes: [
      {
        kind: 'fixed',
        text: 'Filing cards from a sealed product you just opened no longer asks whether copies you already own moved. The question now only comes up when your decks, binders and boxes would hold more of a card than you own.',
      },
    ],
  },
  {
    version: '0.129.6',
    changes: [
      {
        kind: 'fixed',
        text: 'The Decks / Binders / Boxes tabs no longer scroll away in the filing picker when you have a lot of decks, so a card can be filed into a binder or box again.',
      },
      {
        kind: 'added',
        text: '"Fixed incorrect card information" is now a reason a copy is gone when you sort out a filing conflict, for when the conflict came from correcting the card yourself.',
      },
    ],
  },
  {
    version: '0.129.5',
    changes: [
      {
        kind: 'fixed',
        text: "Correcting a card's condition, language or edition keeps it filed where it was. The deck, binder or box holding that copy follows the correction instead of raising a filing conflict.",
      },
    ],
  },
  {
    version: '0.129.4',
    changes: [
      {
        kind: 'added',
        text: 'Open a sealed product you already own. Tap a box on the shelf and pick "Open it, add the cards": the contents go into your collection, the shelf count drops, and you get the usual prompt to file them in a deck, binder or box.',
      },
    ],
  },
  {
    version: '0.129.3',
    changes: [
      {
        kind: 'fixed',
        text: 'Unopened sealed products now show up on your other devices. Devices that synced before boxes existed had skipped those rows for good; every signed-in device re-reads its account once and picks up what it missed.',
      },
      {
        kind: 'removed',
        text: 'The Collection menu no longer has a "Sealed products" shortcut. The sealed shelf is under More; "Add sealed product" stays in the menu.',
      },
    ],
  },
  {
    version: '0.129.2',
    changes: [
      {
        kind: 'changed',
        text: 'The rules-text search button now reads back the ~ it searches for, and it swaps in the ~ even when you only caught part of the card’s name in the highlight.',
      },
    ],
  },
  {
    version: '0.129.1',
    changes: [
      {
        kind: 'changed',
        text: 'Highlighting rules text that includes the card’s own name now searches with ~ in its place, so you get every card with that ability, not just this one.',
      },
    ],
  },
  {
    version: '0.129.0',
    changes: [
      {
        kind: 'added',
        text: 'Settings → Card images lets you set how many card pictures this device keeps cached, with an estimate of the storage that takes. Lower it and hit Save and the oldest images are dropped right away.',
      },
    ],
  },
  {
    version: '0.128.0',
    changes: [
      {
        kind: 'added',
        text: 'Highlight a phrase in a card’s rules text and a "Search rules text for ..." button appears below it, which finds every card whose text contains that phrase.',
      },
    ],
  },
  {
    version: '0.127.2',
    changes: [
      {
        kind: 'added',
        text: 'A deck grouped by card type shows a second land count behind the first: the total including MDFC land halves and lands like Dryad Arbor. Tap the (i) for the list of what got added.',
      },
    ],
  },
  {
    version: '0.127.1',
    changes: [
      {
        kind: 'changed',
        text: 'The multi-select bar now starts collapsed to a single line, so it stops covering half the list on a phone. Tap the chevron to show the actions.',
      },
    ],
  },
  {
    version: '0.127.0',
    changes: [
      {
        kind: 'added',
        text: 'Move cards between a deck’s zones. A card’s sheet has a Zone field (mainboard, sideboard, command zone, tokens), and multi-select has "Move to…" for a whole selection. No more removing a card from one zone to add it to another.',
      },
      {
        kind: 'changed',
        text: 'The Select button now follows you down a long list: once the toolbar scrolls off, it reappears floating above the tab bar.',
      },
    ],
  },
  {
    version: '0.126.0',
    changes: [
      {
        kind: 'added',
        text: 'Sealed products are tracked like cards: a daily price reading each, and the "Sealed value" total opens a chart of what your shelf has been worth. Tap a product for its own sheet, with price each, what your copies are worth and its price chart.',
      },
      {
        kind: 'added',
        text: 'Grid view on the Sealed products page, plus sorting by price change and price change %.',
      },
    ],
  },
  {
    version: '0.125.0',
    changes: [
      {
        kind: 'fixed',
        text: 'The emergency "fetch cards straight from Scryfall" fallback works again. Scryfall changed that download\'s format and we had not caught up, so it failed instead of rescuing a first launch that could not reach our server. It also unpacks the file as it downloads now, so a phone can handle it.',
      },
    ],
  },
  {
    version: '0.124.2',
    changes: [
      {
        kind: 'added',
        text: 'Price history now goes back to mid-May instead of starting the day our archive did. Card trends, the "then" hints in a card\'s history and "Since tracking began" in Price Movers all gained about two months.',
      },
    ],
  },
  {
    version: '0.124.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Opening a card no longer flashes the wrong edition first. The art waits until we know which printing to show, and the foil sheen waits for the art instead of shimmering over an empty frame.',
      },
    ],
  },
  {
    version: '0.124.0',
    changes: [
      {
        kind: 'fixed',
        text: '"Newest normal printing" and "First printing" now skip the variants a set prints alongside a card: borderless, showcase, extended art, retro frames, serialized and chase foils like surge and galaxy. You get the version you would actually pull from a pack.',
      },
      {
        kind: 'added',
        text: 'Search keywords for them: is:borderless, is:showcase, is:extendedart, is:retro, is:serialized, is:specialfoil, is:textless, is:boosterfun, and is:variant for any of them.',
      },
    ],
  },
  {
    version: '0.123.0',
    changes: [
      {
        kind: 'changed',
        text: 'The Edition picker on a card is one line instead of two. Tap it and that line becomes the search box while the editions unfold below, the one you are on first.',
      },
      {
        kind: 'added',
        text: 'Every edition in the list now shows its set symbol next to the set name.',
      },
    ],
  },
  {
    version: '0.122.0',
    changes: [
      {
        kind: 'added',
        text: 'Price movers counts every copy you own, so a pile of thirty cheap specs moving 15 cents each is reported as the €4.50 it is. Rows show "×30 = €4,50", and there is a slider for it in Tune the formula.',
      },
      {
        kind: 'changed',
        text: 'The movers price filter is now a value filter: it asks what your copies are worth together, not what one costs. New "Sort: Value held" alongside it.',
      },
    ],
  },
  {
    version: '0.121.0',
    changes: [
      {
        kind: 'added',
        text: 'The ⋯ menu on Price movers opens "Tune the formula": sliders for how big a move has to be, how straight a steady trend must run, and how much history a dip or spike needs. Kept on this device, with one tap back to the defaults.',
      },
    ],
  },
  {
    version: '0.120.1',
    changes: [
      {
        kind: 'fixed',
        text: "A deck's colour pips ignore its tokens now, so a mono-white deck making a white-and-black cleric stays mono-white.",
      },
    ],
  },
  {
    version: '0.120.0',
    changes: [
      {
        kind: 'added',
        text: 'Suggested tokens now covers marker cards too: emblems, Poison Counter, Energy Reserve, Experience, The Monarch, Day // Night, The Ring, On an Adventure, Plot, Radiation, Max Speed and the face-down helpers for morph, manifest and disguise.',
      },
      {
        kind: 'added',
        text: 'Venture decks get suggested the dungeons they can actually enter, and initiative cards suggest Undercity.',
      },
    ],
  },
  {
    version: '0.119.0',
    changes: [
      {
        kind: 'added',
        text: 'Price movers gained filters (one section at a time, which list a card is on, a minimum price) and sorting by change, change %, price or name.',
      },
      {
        kind: 'added',
        text: 'Tapping search on the price movers screen now offers a "Price movers" chip that filters the sections in place, full Scryfall syntax included.',
      },
      {
        kind: 'added',
        text: 'Sealed products can be filtered by name, set, product type or whether they have a price, and sorted by price, total value, copies, set, release date or date added.',
      },
    ],
  },
  {
    version: '0.118.0',
    changes: [
      {
        kind: 'added',
        text: 'Sealed products now have European prices from Cardmarket, alongside the American ones from TCGplayer. They follow your currency settings like every other price, and the source is named beside the figure.',
      },
      {
        kind: 'changed',
        text: 'Sealed value is no longer stuck in US dollars, so your collection total is finally all in one currency.',
      },
    ],
  },
  {
    version: '0.117.0',
    changes: [
      {
        kind: 'added',
        text: 'Keep sealed products sealed. Booster boxes, displays and packs are in "Add sealed product" now, and picking any product asks whether to keep it unopened or open it for the cards. Your unopened ones live under More → Sealed products, with box shots and prices.',
      },
      {
        kind: 'added',
        text: 'Card sheet ⋯ → "Find sealed products with this card" answers which precon or Secret Lair a card came in.',
      },
      {
        kind: 'changed',
        text: 'Collection value now includes your sealed products. Sealed prices are TCGplayer market prices in US dollars, labelled as such.',
      },
      {
        kind: 'fixed',
        text: 'Transferring your data to another device no longer loses which folder each deck was in.',
      },
    ],
  },
  {
    version: '0.116.0',
    changes: [
      {
        kind: 'added',
        text: 'Scanning, importing or adding a sealed product now ends with "Where do these live?" — file the pile in a deck, binder or box while you have it in your hands, or leave it unfiled.',
      },
      {
        kind: 'changed',
        text: 'An import\'s "Replace" deleted every copy of the card you owned, in any printing. It is now "Update" and swaps a single copy for the imported printing, keeping your total the same, asking which copy when you own several.',
      },
      {
        kind: 'changed',
        text: 'Importing into a binder or box offers to register the cards as owned, importing to the tradelist can mark copies you already have, and pasting the same list twice offers to skip or top up instead of quietly doubling it.',
      },
      {
        kind: 'added',
        text: 'Import screens carry the scanner\'s pile pins: set condition, finish and language once for the whole list. A wishlist import now keeps an edition the list actually named.',
      },
      {
        kind: 'added',
        text: 'The tradelist gets File away and Unfile, the collection gets Unfile, the wishlist gets "I bought these", and Select now works in goblin mode and on search results.',
      },
      {
        kind: 'changed',
        text: 'Every "are you sure" is an in-app sheet that says what will happen, instead of a browser popup. Re-scanning a deck now asks the same "already filed elsewhere" question scanning into one does, and a trade scan keeps the condition you picked.',
      },
    ],
  },
  {
    version: '0.115.0',
    changes: [
      {
        kind: 'changed',
        text: 'The card sheet now offers the same things wherever you open it: flip through editions on any card, fix a recorded price from the History tab anywhere, add to your collection or wishlist while searching inside a deck, and file a copy you own into a deck, binder or box straight from its sheet.',
      },
      {
        kind: 'changed',
        text: '"Add to collection" opens the real form instead of quietly filing a Near Mint, nonfoil, English copy. Back returns you to the card.',
      },
      {
        kind: 'changed',
        text: 'The sheet holds its shape: art, price and where copies are filed at the top, buttons always in the same place, and rules text or history scrolling inside their own boxes. A copy you own reads as one line until you press Edit.',
      },
      {
        kind: 'fixed',
        text: 'Picking a card out of the collection value chart offered to add another copy instead of showing the one you own.',
      },
    ],
  },
  {
    version: '0.114.3',
    changes: [
      {
        kind: 'fixed',
        text: 'Goblin mode is far lighter on phones. The pile now builds only the cards near your view and adds more as you scroll, with art sized for the cards it draws and cheaper shadows. Cards you shove or flip stay that way when you scroll back to them.',
      },
    ],
  },
  {
    version: '0.114.2',
    changes: [
      {
        kind: 'fixed',
        text: 'Adding a scanned pile to a binder or box could silently do nothing. The "already filed somewhere else?" question opened with its Cancel button right under the button you just pressed, so a second tap cancelled the scan. Sheets now ignore taps for a moment after they open, and a cancelled or failed save tells you what happened.',
      },
    ],
  },
  {
    version: '0.114.1',
    changes: [
      {
        kind: 'added',
        text: 'Tap "Total value" on the Collection page for a chart of what your collection has been worth, day by day. A second tab shows only what your cards have gained since you got them, and picking a day lists what came in and out.',
      },
    ],
  },
  {
    version: '0.114.0',
    changes: [
      {
        kind: 'added',
        text: 'Tap the price sparkline on a card to open a full chart with real axes, marked with where you bought, sold and filed the card, and what you paid per copy.',
      },
    ],
  },
  {
    version: '0.113.1',
    changes: [
      {
        kind: 'fixed',
        text: 'A match notification no longer claims someone wants a card when they only wished for a different printing of it.',
      },
      {
        kind: 'changed',
        text: 'Community match marks are the same star, trade arrows and checkmark whether you arrive from the bell or the user list, and a notification now only lights up the list its match was actually in.',
      },
    ],
  },
  {
    version: '0.113.0',
    changes: [
      {
        kind: 'added',
        text: 'Tag the cards in a deck, binder or box with your own labels. Add them on a card, or select several and use "Tag…" to do the lot. "Group: Tag" then splits the list by tag, with the rest under "Untagged". Tags sync with the list they live in.',
      },
    ],
  },
  {
    version: '0.112.0',
    changes: [
      {
        kind: 'changed',
        text: 'Opening a trade now fetches the day\'s prices first, so both sides value the cards the same. Any card your device still can\'t price is called out above the trade bar instead of quietly counting as zero.',
      },
    ],
  },
  {
    version: '0.111.0',
    changes: [
      {
        kind: 'added',
        text: 'Search now understands `or` and parentheses: `t:goblin or t:elf`, `(t:goblin or t:elf) mv<=2`, and `-(...)` to rule a whole group out. Spaces still mean "and", which binds tighter than "or".',
      },
    ],
  },
  {
    version: '0.110.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Deck folders: simpler "Add deck"/"Add folder" buttons with the name ready to type, a per-deck menu that actually moves/deletes instead of a dropdown that bumped you into the deck, an options menu that no longer gets clipped, and a mobile layout that gives decks the full width.',
      },
    ],
  },
  {
    version: '0.110.0',
    changes: [
      {
        kind: 'added',
        text: 'Filter and sort the Decks screen: search by name, filter by format or color, sort by name/format/colors/value, and an "All decks" toggle to ignore folders.',
      },
    ],
  },
  {
    version: '0.109.0',
    changes: [
      {
        kind: 'added',
        text: 'Deck folders. Group decks into folders from the Decks screen, rename or delete them, and move decks between folders. Folders sync across devices.',
      },
    ],
  },
  {
    version: '0.108.0',
    changes: [
      {
        kind: 'added',
        text: 'Search understands a big batch of is: keywords: card structure (is:transform, is:mdfc, is:saga...), classification (is:permanent, is:vanilla, is:commander...), is:reserved / is:gamechanger, foil/promo/reprint availability, and land archetypes (is:fetchland, is:shockland, is:dual...).',
      },
    ],
  },
  {
    version: '0.107.0',
    changes: [
      {
        kind: 'added',
        text: 'Search understands more Scryfall syntax: set:znr (or s:/e:) for cards printed in a set, cmc:even / cmc:odd for mana value parity, and mana>={2} (or m:) for matching mana costs by symbol.',
      },
    ],
  },
  {
    version: '0.106.0',
    changes: [
      {
        kind: 'fixed',
        text: 'Trades reconnect properly after your phone backgrounds or the connection drops. Rejoining no longer gets stuck, shows "session full" by mistake, or gives up too soon.',
      },
    ],
  },
  {
    version: '0.105.0',
    changes: [
      {
        kind: 'fixed',
        text: 'The trade screen no longer lets the value/Accept bar cover the Add/Scan buttons. Title and menu stay fixed at the top, the bar docks above the tab bar, and each column scrolls its own cards independently.',
      },
    ],
  },
  {
    version: '0.104.0',
    changes: [
      {
        kind: 'added',
        text: 'A “This deck/binder/box” pill in search, so you can search just that container’s cards. It never turns on by itself — tap it when you want it.',
      },
    ],
  },
  {
    version: '0.103.0',
    changes: [
      {
        kind: 'changed',
        text: '“In your collection” now jumps to a Collection search for that card’s name instead of guessing which copy to open.',
      },
    ],
  },
  {
    version: '0.100.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The “What’s changed” popup itself: an install updating for the first time since it shipped looked like a fresh install, so it stayed quiet instead of showing what changed. It now shows the full list in that case.',
      },
    ],
  },
  {
    version: '0.100.0',
    changes: [
      {
        kind: 'added',
        text: 'This “What’s changed” popup, so an update tells you what’s different since you last opened the app.',
      },
    ],
  },
  {
    version: '0.99.0',
    changes: [
      {
        kind: 'changed',
        text: 'Scanning a card into a deck, binder or box now files that exact copy. Already filed elsewhere? You’re asked whether to move it or keep both.',
      },
    ],
  },
  {
    version: '0.98.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Trading away a filed card now clears its filing automatically, when the app can tell which copy left.',
      },
    ],
  },
  {
    version: '0.98.0',
    changes: [
      {
        kind: 'added',
        text: 'Decks now have a Tokens section. Token-making cards suggest what they need, ready to file in one tap.',
      },
    ],
  },
];
