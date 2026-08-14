// User-facing changelog for the "What's changed" popup (WhatsNewModal.tsx).
// Short, plain-spoken entries — not the fuller writeups in CHANGELOG.md at the
// repo root. Only versions from 0.98.0 onward are listed: every install still
// in the wild is already past that point, so nothing older needs a place here.
//
// Add an entry here on every version bump, same as CHANGELOG.md (see
// CLAUDE.md's Conventions section) — otherwise the popup silently has nothing
// to say about that release.
export type ChangeKind = 'added' | 'changed' | 'fixed' | 'removed';

export interface ChangelogChange {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  changes: ChangelogChange[];
}

export const CHANGELOG: ChangelogEntry[] = [
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
