# Changelog

Testers: the app shows an "Update now" banner when a new version is published.

## 0.88.1

- **The flip button no longer sits on a creature's power/toughness.** It moved to the bottom centre of the card, so you can read 7/7 and still turn the card over.
- **Ownership checkmarks in the edition picker are back on the card.** They were floating a line too low, printed over the price under each printing.
- **All three card-corner markers line up along the bottom-left of the art**: what you own, where it's filed (deck/binder/box), then which way its price is moving. They used to be scattered across three different corners.

## 0.88.0

- **The search bar remembers what you just typed.** Tap it with nothing in the box and your last ten searches are sitting there, newest first — one tap puts a query back. Deck building is a loop of "search, look at the deck, search again", and a hand-typed `t:goblin o:"draw a card" cmc<=3` used to die every time you closed the search.
- **A search is banked when you're done with it**: on Enter, when you close the search, or when you wander off to another tab mid-query. Never while you're still typing, so the list holds real searches and not every prefix of "lightning".
- **Refining counts as the same search.** Come back to `t:goblin` and add `cmc<=3` and you get one entry, not two.
- **One list, wherever you search.** The same Scryfall syntax works on your collection, tradelist and wishlist, so those queries are remembered too — and the list is offered with the scope chips as well, not just on database searches. A query you wrote against the whole database is one tap away from being pointed at your own binders.
- **Yours to prune.** ✕ forgets one search, **Clear** wipes the list. It stays on this device and isn't synced.

## 0.87.0

- **The command zone takes two again.** Setting a second commander had quietly stopped working: once one card sat in the zone, the **Make commander** and **Add as commander** buttons vanished for everything else. Partner, Partner with, Friends forever, Doctor's companion and Backgrounds are all back, and the button says **Make second commander** so you can see what you're doing.
- **Backgrounds specifically.** A Background is an enchantment, not a legendary creature, so it never even offered the button. Now it does: put Jaheira in the zone and Raised by Giants can join her. Two Backgrounds still can't share the zone — somebody has to say "Choose a Background".
- **Searching from the deck no longer hides your Background.** With one commander in the zone, the deck-legal filter used to trim results to that commander's colors, which is exactly the wrong thing to do to the second commander that widens them. A legal partner or Background now comes through whatever its colors.
- **A lone Background says what it needs.** The legality panel used to call it "not a legendary creature"; it now says it needs a commander that says "Choose a Background", which is the actual missing half.

## 0.86.1

- **The double check is now strictly "I have *that* card".** A deck slot only earns it once it names an edition, finish, condition and language *and* a copy in your collection fits. Leave anything on **Any** and it keeps the single check: you own the card, but the slot hasn't decided which copy fills it. Correcting 0.86.0, where an undecided slot double-checked on ownership alone. Condition is still a minimum, so a slot asking for LP is happy with your NM copy.
- **"In your collection (×N)" is a shortcut now.** The green badge under a card's name is a button: tap it and you land on that copy's sheet in your collection, chevron and all. Handy the moment a deck slot tells you something is off and the fix belongs on the entry itself.

## 0.86.0

- **A deck slot can name the exact card you mean.** Tap a card in a deck, binder or box and the sheet now has **Minimum condition**, **Finish** and **Language** next to Edition, all four starting on **Any** — the same "any printing / any finish" wording the wishlist has always had. So the mainboard can ask for the foil Japanese Counterspell while the sideboard is happy with whatever's in the drawer.
- **"Pick one from my collection."** The new link under Edition opens your own copies of that card as tiles — TSP #157 · LP · Foil · de, ×1 — and picking one fills in the edition, finish, condition and language in a single tap. That's the shortcut: point the slot at the piece of cardboard you actually own instead of setting four dropdowns.
- **The double check now means "I have *that* one".** A slot gets the double check when a copy you own meets everything it asks for. Ask for a foil while your only copy is nonfoil and it drops to the single check — you own the card, just not the one this deck wants. Slots left on "any" double-check the moment you own the card in any edition, so pasted decklists behave exactly as before. A deck asking for foils is also priced at foil prices.
- **Two new actions in a deck's ⋯ menu.** **Add missing cards to wishlist** brings up the sheet that used to only appear as you left a deck, so you can ask for it whenever — and it stays on the deck page afterwards. The wishes inherit what the deck's slots asked for, so a foil deck doesn't go shopping for nonfoils. **Add all owned cards to tradelist** (and its undo) was a binder-and-box action; decks get it too, for the evening you decide to break one up.

## 0.85.0

- **Basics come from the lands box now.** Add a basic land to a deck and it goes in as **any printing**: the copy you grab off the top of the pile, whatever set it's from. It counts toward the deck's card count and toward "you own X of Y", it never eats one of the Islands in your collection, and it adds nothing to what the deck is worth. Nobody should have to scan 24 Islands to stop a deck reading 36/60.
- **It's the default, not a setting.** +Main on a basic, the card sheet's Add button, and pasted decklists all file basics this way. If you do want the specific foil Unglued Island, the Edition dropdown still lists every printing — pick one and the slot goes back to being a copy you own. Binders and boxes are unchanged: they hold real cardboard, so basics there are counted like anything else.
- **The rest of the app plays along.** Any-printing basics don't show a deck badge on your collection lands, don't trip the "promised more copies than you own" flag, aren't offered when a deck asks what to wishlist on the way out, and are skipped by "mark everything for trade". Re-scanning a deck leaves them where they are, since no camera can see a card you never sleeved.

## 0.84.0

- **The pickers are there wherever you scan.** Finish, condition and language used to vanish when you scanned into a deck, binder, box or wishlist. They don't any more. A box scan offers to add anything you don't own yet to your collection, and that copy now goes in as the foil Japanese one you actually scanned instead of a plain English NM. A scanned wish keeps the finish and language you picked too, and leaves them as "any" if you didn't touch them.
- **Change a picker after you've tapped.** Tap **+1**, then notice the card is foil: switching Finish now fixes the copy you just added instead of only the next one. Same for condition and language, for everything the card in frame has put on the list. Values still reset to Nonfoil / NM / read-language when the next card locks, so what you fix stays fixed.
- **A padlock, bottom left, for the lock.** The card the scanner is holding on to now has a face: a padlock with a ring that counts down its hold. Tap it and the lock lets go at once, which is how you scan the second copy of the same card without hunting for something else to point the camera at. Left alone, the lock lets go on its own once the hold is up and the card leaves the frame, so a pile with doubles just works.
- **Condition pile is gone.** It sounded useful and wasn't; the per-card Cond picker does the job. Finish, Language and Set pins are unchanged.

## 0.83.0

- **Finish, condition and language while you scan.** Scanning used to file every card as a Near Mint nonfoil and take the language from whatever the reader could make out. There's now a slim row of three small pickers between the camera and the match tray, and whatever they say is what the next card you tap gets. So the one foil in the stack is one tap on **Foil** away, and the beaten-up Counterspell can go in as **HP** without a trip through the list afterwards.
- **Pin them for a whole pile.** Behind the gear you can now pin **Finish pile**, **Language pile** and **Condition pile** to a value. Pinned means every card added takes it, the reader can't overrule the language (it does misread non-English cards), and the pickers don't reset between cards. Unpinned, the pickers belong to the card in frame and fall back to Nonfoil / NM / whatever the reader says as soon as the next one locks. The old "Foil pile" tickbox has grown into the Finish pin, etched included.
- **Set pile, for when the whole box is from one set.** Tick it and the scanner captures the set of the card in frame, then suggests only that set's printings. This is the fix for Command Tower and friends, where three dozen editions share the same art and picking the right tile was a squint-and-guess. If a card turns out not to be from the pinned set, all the matches come back and the row says so, so nothing gets stuck.
- **Every pin is visible.** Each active pin sits as a little padlocked chip over the camera, and the pinned pickers wear a padlock too. A pin left on from last night's pile shouldn't be something you discover forty cards later. Pins are remembered between sessions for the same reason a half-finished scan is.
- **Change your mind afterwards, as before.** Tap any row in the scanned-cards list and the card sheet still edits the edition, finish, condition, language and count of that line before anything is written.
- **Auto-add no longer skips a repeat.** With "Auto-add pinpointed edition" on, going back to a card it had already added once (A, B, A, which is just what a binder page of near-duplicates looks like) quietly added nothing the second time. It adds it now. Auto-add also fires when a set pin leaves exactly one candidate standing, which gets a whole set pile in without waiting on the reader.

## 0.82.0

- **Select cards inside a deck, binder or box.** The **Select** button that Collection has had for a while now sits in every deck, binder and box too, next to the sort and view controls. Tick as many cards as you like — the selection spans the mainboard, sideboard and command zone at once, so "Select all" really does mean all of it — and the action bar slides up with everything you can do to the lot.
- **Five bulk actions.** **Add to tradelist** and **Remove from tradelist** flag the owned copies of everything you've picked, so a shelf of a box you've decided to sell is one selection instead of forty taps. **Remove from deck** (or binder, or box) empties those slots out. **File away…** also puts them in another deck, binder or box, creating one on the spot if you like. And **Unfile…** takes them *out* of one, which is the fix for the card you've promised twice.
- **Unfile knows where to look.** Rather than making you hunt through every deck you own, the Unfile sheet lists only the containers that actually hold something you've selected, and says how much of it each one is holding — "Casual · holds 2 of these". Pick one and those copies come off. It matches on the edition when both sides name one, the same rule the little deck badge uses, so what the sheet offers is what gets removed.
- **All of it undoes in one tap.** A bulk removal lands in the edit history as a single entry ("Removed from Mono-Red Burn · 4 cards"), not four, and undoing it puts every slot back.

## 0.81.0

- **Search your collection, then sort it and select it.** When the two search bars became one, the search-and-then-operate workflow quietly went with them: you could search your collection in the overlay, but the results arrived name-sorted with no way to pick them out and act on them. Now, when search is pointed at the very list you're standing on, it filters that page in place instead of covering it. Tap the search bar on Collection and you get a slim chip row under the header; type `t:creature -c:r mv<=3` and the collection narrows to those cards, still with its own sorting, its own **Select**, and the full set of bulk actions. Select all now means "all of the ones I searched for", so filing sixty commons into a box is a search, a tap and a tap. Same on Wishlist and Tradelist. The entry and card counts at the top follow the filter too, which is a quick way to price out a slice of the collection.
- **The chip is the switch between the two searches.** With the Collection chip lit you're filtering what you own; turn it off and the full-database search opens over the page as before, ready to add something new. "Search for cards" links on empty lists always go straight to the database search. Picking a different list's chip (Wishlist while you're on Tradelist) still opens the overlay, since there's no page there to filter.
- **One list at a time.** The scope chips used to be tickboxes, so you could search your collection and wishlist at once. That combination had no sensible home for sorting or bulk actions ("add to tradelist" on a wishlist row?), so the three are now one-of.

## 0.80.1

- **The "it's in a deck" badge now points at the right copy.** If you own an Enlightened Tutor from Mirage and another from The List, and only The List one is in a deck, the little deck badge used to appear on both — it only knew the card was filed somewhere, not which edition. Now it sits on the copy that's actually in the deck, and the card sheet's pills follow the edition you're looking at. Cards added to a deck by name only (a pasted decklist, say) don't pin an edition, so those still show on every printing — there's nothing to match against. The "more copies placed than owned" warning still counts every copy of the card across every printing, which is the only way to count it honestly when some slots name no edition.

## 0.80.0

- **Prices in your own currency.** Settings has a new **Prices & currency** section. Pick any of 30 currencies — kroner, pounds, złoty, yen, take your pick — and every price in the app converts to it: card prices, collection and deck values, trade balances, price history, the lot. Rates are the European Central Bank's daily reference rates, fetched once a day. You also choose which of Scryfall's two currencies (euros or dollars) conversions start from, and that's what shows if a rate can't be fetched. Two side effects worth having: a collection holding some euro-priced and some dollar-priced cards used to report its total as "€412 + $38", and now adds up to one number; and sorting by price no longer sorts euro cards and dollar cards into separate piles. What gets *recorded* in your history is untouched, so switching currency never rewrites your own numbers.
- **Choose which printing a card shows as.** Also in Settings: **Card printings**. The app has always represented a card by its newest edition, which is how a Lightning Bolt search ends up showing you a Secret Lair. Now you can ask for the **newest normal printing** instead (skipping promos, prerelease stamps, Secret Lairs, judge foils and token sheets), the **first printing** (the card as it originally appeared), or the **cheapest**. There's also a **prefer a printing I already own** tick that overrides the rest whenever you own a copy. Whatever you pick is what search results show *and* what gets recorded when you add a card without choosing an edition yourself — including from a pasted list. Cards already in your collection, decks and boxes keep the printing they were filed under; this doesn't rewrite your shelves.
- **Nothing downloads behind your back any more.** Card prices, the card database and the camera scanner's card-art index all used to fetch themselves whenever a new version appeared — a few megabytes at a time, no questions asked, which is a rude thing to do to someone on mobile data. Now each one asks the first time it has something new, and the prompt has a **"don't ask again"** tick: whichever button you press with it ticked becomes the standing answer. Settings has an **Automatic downloads** section with all three set to Ask / Automatic / Never, each with a **Check now** button, so "never" doesn't mean stuck. Declining the big card-database update no longer means declining the small daily price file — they're separate questions.
- **One larger card-data update, once.** To tell a real set from a promo one, the card database now records which printings are promos. That touches every edition record, so the next card-data update is a bigger one than usual (around 9 MB instead of the usual trickle). You'll be asked before it spends anything, and it only happens once.

## 0.79.0

- **Decks, binders and boxes now tell you what you actually own.** The value on a deck, binder or box used to be the price of the whole list, whether the cards were in your collection or still on someone else's shelf — a 60-card brew you'd bought four cards for happily claimed to be worth €400. Now the number that leads is the value of the copies you own, and what's missing is priced separately: "€82 owned · €318 missing". The Decks/Binders/Boxes list says the same thing at the top ("Owned value", with the rest noted underneath), and every deck, binder and box in the list now carries its own owned value next to the card count. One copy covers one slot, so a card sitting in both your mainboard and your sideboard isn't counted as two copies you own.

## 0.78.0

- **The back button closes what's on top of the screen.** On a phone, backing out of a card sheet used to bounce you out of the deck (or the collection, or wherever you were) with the sheet still in your face. Now back does the obvious thing: it closes the card sheet, then the search overlay, then the picker you opened on top of that — one layer at a time, exactly like Escape does on a desktop — and only leaves the page once nothing's left to close. The scanner's screens play along too, and a swipe-back on iOS counts as a back press. Nothing has to be tapped twice: closing a sheet with its own button doesn't leave a phantom back press behind.

## 0.77.0

- **The camera can finally read the weird cards.** Sagas, split cards and Aftermath, Classes, Cases, flip cards, full-art lands, borderless and extended-art printings, and anything in an old pre-8th-Edition frame: scanning these mostly just failed, and for some of them it could never have worked. The scanner was comparing the wrong piece of cardboard. It looks at a fixed window on the card, but the reference index it matches against was built from each card's *artwork*, and on a Saga the artwork is a tall panel down the right-hand side, on a split card it's sideways, on a full-art land it's the whole card. The index is now built from the same window on the same card image the scanner looks at, so it lines up on every card layout Wizards has ever printed, including ones they haven't invented yet. In testing, Sagas, Classes and Cases went from "impossible" to identified at near-perfect confidence.
- **Your scanner will download a fresh index once.** The first scan after this update re-downloads the card index (about the same size as before). Nothing you've scanned or collected is affected.
- Known gap, for the completists: on the text-heavy layouts (Sagas, Classes, Cases, split cards) the window lands mostly on rules text, so a **non-English** copy of one of those is still hit and miss. English copies are unaffected, and every other layout reads fine in any language. A proper fix for this is on the list.

## 0.76.0

- **Every deck now remembers how it got here.** There's a new History section at the bottom of any deck, binder or box: every card you've put in or taken out, newest first, grouped by the day it happened, with the deck's size at the end of each day and a little line showing it grow and shrink. Tap a change to see the details (and the card's own history from there). It's in the ⋯ menu too, which opens it and takes you straight to it. Nothing new is being recorded for this — it's the same log the Edit history page has always kept, just told from the deck's point of view. A scan or a pasted list still counts as one change, and a re-scan says what it added *and* what it took away.
- **Imports and scans stay whole across your devices.** An imported list, a scanned pile or a bulk deck add arrived on your other devices (or back from a backup file) shattered into one line per card, having forgotten it was ever an import — so it lost its label and couldn't be undone in one go. It now travels intact.

## 0.75.2

- **The whole scanned stack lands in the trade.** Scanning a pile of cards into a trade offer only ever added one of them — the rest of your scan list vanished on the way in, and stacks of the same card came in as a single copy. Now the full list arrives in one go, counts and all.

## 0.75.1

- **Binders stay binders across your devices.** A binder or box made on one device arrived on your other devices as a plain deck. The cards and counts were all there, only the label was wrong, and the server's copy was correct the whole time. Fixed, and the app repairs the ones already sitting on your devices: next time you open it, it re-reads your account from the server and your binders and boxes turn back into binders and boxes. Same fix for a binder restored from an exported backup file, and for history lines that showed a deck icon for a binder.

## 0.75.0

- **Binders and boxes.** Decks are no longer the only place a card can live. The Decks tab now has three segments: **Decks**, **Binders** and **Boxes**. A binder or box works exactly like a deck minus the format and the sideboard, so you can build "Blue box" or "Small green binder" and file cards into it: search from inside it, scan a stack with the camera, re-scan it to reconcile what's really there, import or export a list, rename it, delete it. In your collection, select a few cards and hit **File away** to drop them into any deck, binder or box (you can create one right there in the picker).
- **Cards tell you where they are.** Every card image in your collection now carries a small corner glyph for the deck, binder or box it's filed in, and the card sheet has a **Filed in** row of pills. Tap a pill to jump straight to that deck, binder or box. Filed a card in two places at once? The badge and the pill row flag it (⚠ 2 placed / 1 owned) instead of stopping you: the app trusts your shelves over its bookkeeping.
- **A whole box up for grabs.** A binder or box has **Mark all for trade** and **Remove all from trade** in its ⋯ menu, so the trade-fodder crate goes on your tradelist in one tap.

## 0.74.4

- **Card data keeps flowing.** Scryfall changed how they hand out their nightly card dump (a new gzipped JSONL format), which had quietly broken our nightly rebuild — new cards and fresh prices would have stopped arriving. Reconnected to the new format, so the daily updates land as usual.

## 0.74.3

- **Foils show their proper backside in the pile.** In goblin mode, flipping a foil card over now reveals the real Magic card back instead of a mirrored, shiny version of the front. As it should be: the card back is never foil.

## 0.74.2

- **Goblin mode goes all in.** Flipping on goblin mode now dumps your whole collection straight into the pile, no list or grid, no toggle out. Want your sorting back? Turn goblin mode off in settings. Just like Richard Garfield intended.

## 0.74.1

- **Oversized cards loom large in the pile.** In goblin mode's pile view, oversized cards (the big Commander precon planeswalkers and the like) now scatter at their true-to-life size — noticeably bigger than the normal cards around them, just like the real shoebox.

## 0.74.0

- **Community lists you can swipe.** A user's trade and wishlist now each show as a single row of cards you swipe sideways (flick on mobile, scroll wheel or the arrow buttons on desktop) — no more scrolling past a giant grid to reach their wants. More cards load as you swipe toward the end. The cards you care about come first: on their trades, the ones you want; on their wishes, the ones you have (then the ones you own but haven't listed). Prefer the old stacked grid? There's a new layout toggle next to the sort menu. And each list has a **See all** button that opens the full list with its own search box, sort, and infinite scroll.
- **The whole tradelist shows now.** Big tradelists were being cut off at 500 cards when viewed in Community, even though the count said more. All shared cards are visible again (up to the 5,000 publish limit).

## 0.73.0

- **Search and sort other people's lists.** Someone's tradelist runs to hundreds of cards? While browsing their trade & wishlist in Community, the search bar now offers two extra scope pills — "*name*'s tradelist" and "*name*'s wishlist" — so you can hunt for a specific card inside their piles instead of scrolling forever. And both of their lists now carry the same Sort menu as your own collection (by name, mana value, or price), so you can float the pricey stuff to the top.

## 0.72.1

- **See exactly what someone wants.** Tapping a card on another user's wishlist in Community now spells out their wish: whether they'll take any printing or want a specific edition, plus their minimum condition, finish, and language. No more guessing whether that foil is a must-have.

## 0.72.0

- **Share a deck with a link.** Favorited a deck? There's now a Share button — in the deck's ⋯ menu, and at the top of any deck you're viewing on someone's profile. It hands off to your phone's share sheet (or copies the link) so you can drop it in a chat. Whoever opens it needs to be signed in and lands straight on the decklist. Decks you haven't favorited stay private, so the Share button nudges you to favorite one first.

## 0.71.2

- **Scroll wheel works across the whole window on desktop.** On a wide monitor, parking your mouse in the empty space to the left or right of the content used to leave the scroll wheel dead. The scroll area now fills the window, so you can spin the wheel anywhere.

## 0.71.1

- **Card badges no longer sit on the name.** Those little "New"/"Reprint" tags in Spoilers and the ownership checkmarks on deck cards used to land right on the card's printed title in grid view. They've moved to the bottom-left corner, so you can actually read what the card is called. (Price-trend arrows swapped up to the top-left to make room.)

## 0.71.0

- **Spoilers: view several sets at once.** The set picker is now a checklist, so you can tick Star Trek Commander, its tokens, and the Stardates all together and see every new card and reprint from the lot in one combined list. A card reprinted across two of your chosen sets shows just once. Untick down to a single set and you get the familiar release-date header back.

## 0.70.2

- **Scanning now really does favour the editions you own.** On cards with a pile of look-alike printings (hello, Command Tower) the version sitting in your collection could get crowded out of the match tray entirely, forcing an "All editions" detour to fix it. Now any printing you own that matches what's under the camera is pulled into the tray and floated to the front, so the right one is a single tap away.

## 0.70.1

- **Tidied up those quick-add buttons.** They were showing on every card you so much as glanced at. Now: in your own decks you get both Collection and Wishlist buttons, on your own wishlist you get a "got it" Add to collection button, and everywhere else (browsing a friend's deck, a trade, price movers) they hide behind a ⋯ menu so the card sheet stays clean.

## 0.70.0

- **"I've got it" / "I want it" from any card.** Tapping a card you're only browsing (someone else's deck or profile) or a card in one of your own decks now offers quick Collection and Wishlist buttons right in its sheet. Collection files the printing you're looking at; Wishlist adds it as any-printing, same as a normal wish. No more dead-end "Close"-only sheet when you spot something you have or covet.

## 0.69.0

- **Tidier deck editing.** The little row of buttons under each card while editing a deck is gone. Tap a card to open its sheet and change the quantity, remove it, or set it as your commander from there. Less clutter, same moves.

## 0.68.0

- **Scan into a deck, top up your collection too.** Scanning cards straight into a deck now offers to add any scanned printing you don't own yet to your collection, the same prompt re-scanning a deck already gave you. Physical cards you're scanning are usually in hand, so this keeps your collection honest without a second pass. Own them all already? It just adds them to the deck, no interruption.
- **"Update" now swaps a single copy, not your whole shelf.** On the collection scan prompt, choosing Update for a card you already own swaps just one of your copies for the scanned printing (finish, language or condition too) and keeps your total the same, instead of wiping every copy you own. If you own the card in more than one version, a quick follow-up asks which copy to replace, one card at a time with a 1/N counter when several are queued.
- **Cleaner trade history for cards you never logged.** Trading away a card that wasn't in your collection now records it as added and then traded away, instead of a lone "traded away" for a card you supposedly never had. Undoing such a trade puts things back exactly as they were.

## 0.67.1

- **Wishlist a spoiler on the spot.** Tapping a card in Spoilers & reprints now opens the full add sheet with Wishlist leading, so you can wish for that shiny new card (or file it into your collection or tradelist) without leaving the view.

## 0.67.0

- **See what's fresh off the presses.** A new "Spoilers & reprints" view (under More) lets you browse the latest sets, newest first, with upcoming sets tagged before they're even released. Pick a set and filter to just the New cards (their first-ever printing) or just the Reprints, where each reprint tells you where the card first showed up ("first in Unlimited Edition (1993)"). Updates with the daily card-data refresh, so spoiler season lands here as Scryfall reveals it.

## 0.66.0

- **Card artists get their credit.** Profiles now show an "Art by …" line at the bottom, naming the illustrator of the card art your profile picture is cropped from. Shows for anyone's profile whose picture is a card art.

## 0.65.0

- **Group and sort someone else's deck too.** Viewing a favorite deck on another player's profile now has the same Group-by and Sort controls as your own decks. The mainboard defaults to grouping by card type instead of dumping everything into one big list, and you can regroup by color or sort by name, mana value or price, all without touching their build.

## 0.64.0

- **Wishlist preferences now affect matches.** Your finish, condition, and language picks on a wish now filter what counts as a match in community sharing and in-person trades. A card only satisfies a wish when its finish and language match your preference and its condition is at least as good as your "Minimum condition" pick. The wishlist card sheet's Condition field is now labelled "Minimum condition" to make this clearer.

## 0.63.0

- **File a card into any list from its sheet.** Open a card from search and the sheet now carries all three destinations, not just the one you searched from. The list you came from is the big button (e.g. "+Wishlist"); the other two sit beside it as compact +Collection / +Tradelist icon buttons. Found a card while browsing your wishlist but actually want it in your collection? One tap, no reopening search on the right scope.
- **Wish for a specific finish, condition or language.** The wishlist card sheet now has the full Condition / Finish / Language pickers, each defaulting to "Any" so nothing changes unless you want it to. Want *that foil* specifically? Set Finish to Foil. A foil wish and a nonfoil wish for the same card stay as separate lines, and the wishlist row shows what you pinned down.

## 0.62.0

- **One search bar, not two.** The per-page filter (and its set/color/rarity dropdowns and "On tradelist only" toggle) is gone from Collection, Tradelist and Wishlist. Finding a card you own now happens in the same search bar you use for everything else.
- **Search scopes.** Open search and you'll see Collection / Tradelist / Wishlist chips. Whichever list you searched from is picked for you, so searching from your collection filters your collection right away. Tap a chip off to search the whole card database again, or turn on several at once to search across them together. Your typed search sticks around while you flip between them.
- Scoped results show your actual copies (edition, condition, "for trade" count) and tap straight through to edit them, exactly like the list pages did.

## 0.61.0

- **Adding cards to a trade now asks before it commits.** Tapping a card while building an offer (from search or your/their tradelist) opens the card sheet, where you pick the edition, condition, finish, language and quantity, then hit "Add to trade". No more mystery "+" button quietly adding a version you didn't choose.
- **Edit a card already in the trade.** Tapping a card in either trade column now opens the full sheet, so you can change its edition, condition, finish, language and quantity, or remove it, all in one place, not just nudge the count.

## 0.60.0

- **Foil pile mode.** Scanning a stack of foils? The scanner's gear menu now has a "Foil pile" switch: flip it on and every card you add is marked as foil, no per-card fiddling. A "Foil pile" badge stays on screen while it's active so you don't forget it's on. (Only shows where finish matters, so it's absent for deck and wishlist scans.)

## 0.59.0

- **Let the scanner add editions for you.** New gear menu in the scanner (top-right) with an "Auto-add pinpointed edition" switch. Turn it on and, the moment the scanner nails down the exact printing (the green check on the tile), it drops +1 of that card into your pile automatically, so scanning a big stack can be almost hands-off. Off by default, and your choice is remembered.

## 0.58.0

- **Scanning goes "pop".** Adding a card to your scanned pile now plays a little pop, so you get audible confirmation without looking away from the cards. Pile up copies of the same card and the pop climbs a note higher each time (up to ten), so a playset sounds like a satisfying little run.

## 0.57.0

- **Scan matches now show the set symbol.** Under each match tile, next to the set code and collector number, there's now the actual set symbol, drawn nice and big so it's easy to read. Handy when you recognise a set by its icon faster than by its three-letter code.

## 0.56.0

- **The +/− on scan matches got out of the way.** The little plus and minus hints on each match tile were sitting right on top of the ownership check, making it hard to tell a single check from a double. They're now centered along the top and bottom edges, so the corner badges read cleanly.

## 0.55.0

- **Your scan survives a stray refresh.** If you're partway through scanning cards into a deck, your collection, tradelist, or wishlist and the page reloads, the cards you'd already scanned are still there when you reopen the scanner. The list only clears when you actually add the cards or discard them yourself, so a fat-fingered refresh no longer means starting the pile over.
- **The editions you own come first.** When scanning, the printings you already have in your collection now lead the match tray, with the green double-check on the exact printing you own, so the right edition is the first one you reach for. The Edition dropdown and the "view all editions" grid on any card do the same: owned printings sort to the top.

## 0.54.0

- **Re-scan a whole deck to bring it up to date.** A deck's options menu has a new "Re-scan deck": point the camera at your pile and scan the whole deck again, tagging main/side/commander as you go, just like the normal deck scan. When you finish, you get a change list showing only what's different, cards you added, cards no longer in the deck (removed), and any copy-count changes, so cards that were already there don't clutter the review. The deck is then set to exactly what you scanned. Anything you scanned that isn't in your collection is offered up afterward, so you can add those to your collection in the same pass or skip them.

## 0.53.0

- **Foils are priced as foils.** Until now every finish of a card showed the same price, so a foil and its nonfoil twin looked identical in value. Prices now track the foil (and etched) market price separately everywhere it matters: per-card in your collection and lists, the collection and tradelist value totals, and both sides of a trade. Etched cards use their own price where the market has one. Prices refresh with the nightly card-DB update, so foil values fill in within a day of updating.

## 0.52.0

- **Trade solo, for when the other player isn’t on the app.** The trade screen has a new “Trade solo” option: you fill in both sides yourself (the cards you give and the cards you get), accept, and confirm, just like a normal trade but without waiting for a partner to join. It records to your collection, trade history, and each card’s edit history exactly the same way, so a trade with a friend who doesn’t use the app still shows up correctly.

## 0.51.0

- **Add any variant to a trade, not just the default.** When you add a card to a trade that isn't in your collection (or, for their side, isn't on their tradelist), the card sheet now opens so you can pick the edition, condition, finish, language, and quantity before it lands in the offer. Foils and other variants finally come through correctly instead of always defaulting to a near-mint nonfoil.

## 0.50.0

- **Own-it checkmarks everywhere.** Cards now carry the same ownership badge wherever they show up: search, the scan tray, your wishlist, deck lists, and the trade "you give" side. A green double-check means you own that exact printing, a single check means you own a different printing of the card, and a purple tag means you've got copies marked for trade. So you can tell at a glance, while browsing search or someone's list, whether a card's already in your binder.

## 0.49.0

- **History is now per printing.** A card's History tab shows the timeline for the exact edition you're looking at, not all editions lumped together. Switch editions in the dropdown and the timeline (and "owned since") follows. Edition-agnostic events, like an "any printing" wish or deck slot, still show on every edition so nothing goes missing. The "Last edited" sort follows the same rule, so it lines up with what you see. Heads up: if you change a card's edition, its earlier history stays with the old edition, since that's a different printing.

## 0.48.0

- **Date-added and last-edited sorting, now on the Wishlist too, and truer to the History tab.** The Wishlist sort menu gains the "Date added" and "Last edited" options that Collection and Tradelist got. And "Last edited" now sorts by the most recent entry in each card's History (the same date you see at the top of the History tab) instead of an internal timestamp that could drift, so the order matches what you actually did to the card.

## 0.47.0

- **Sort by date added and last edited.** Your Collection and Tradelist sort menus have two new options: sort by when a card was added, and by when you last touched it (changed quantity, condition, tradelist status, and so on). Use the ↑/↓ toggle to flip between newest-first and oldest-first.

## 0.46.0

- **Total value at a glance.** Your Collection, Wishlist, Tradelist, and Decks pages now show the total value up in the header, tucked beside the title so it takes no extra room. Each deck's detail page also tells you what that deck is worth. Prices follow the same currency as the per-card prices (EUR where available, otherwise USD).

## 0.45.0

- **Way less card-database downloading.** Two fixes to the thing that kept nagging you to re-download 7-14 MB several times a day. App updates (new versions, bug fixes) no longer trigger a card-database re-download at all, only genuinely new card data does. And when card data does change, the app now grabs just the small slices that actually changed instead of most of the database. Prices already updated quietly in the background and still do. One-time catch: the first update after this ships re-downloads the card data once so it can switch to the finer-grained scheme.

## 0.44.1

- **Mana pips in deck list view too.** The mana symbols added to list rows now also show when you switch a deck to list view, not just your collection.

## 0.44.0

- **Tap your picture for a proper menu.** The avatar in the top-right corner now opens a little dropdown: **Profile**, **Settings**, and **About**. Your profile used to be buried (Community → your trades → Profile); now it's one tap away.
- **Settings, gathered in one place.** The old "Account & sync" and "About & settings" pages have been reorganized. **Settings** now holds your account, sync, data transfer/backup, and Goblin mode. **About** is just the app version, card database info, and attribution. Old links still work.

## 0.43.6

- **Mana pips in list view.** List rows now show each card's mana cost as mana symbols, next to the price.

## 0.43.5

- **Flip double-faced cards in the card sheet.** Werewolves, modal DFCs, and other two-faced cards now show a flip button on their art in the card sheet. Tap it to turn the card over and read the back.

## 0.43.4

- **Ownership shows in the "view all editions" grid.** Open the grid of every printing and the ones you already own are marked with a double check in the corner, so you can see at a glance which exact editions are in your collection.

## 0.43.3

- **"Add as commander" only shows up when it's legal.** When adding a card to a Commander deck, the button now appears only for cards that could actually be your commander (legendary creatures, cards that say "can be your commander", and the like). No more offering to crown a Lightning Bolt.

## 0.43.2

- **Search the Edition dropdown.** For cards with lots of printings, a filter box now sits above the edition picker. Type a set name or its code ("Modern Horizons 2" or "MH2") to narrow the list instead of scrolling forever.

## 0.43.1

- **Double check = you've got that exact printing.** The "In your collection" badge on the card sheet now shows a double checkmark when the edition you're looking at is one you actually own, and the familiar single checkmark when you own the card but in a different printing.

## 0.43.0

- **The card sheet now tells you if you already own a card.** Open any card (searching to add to a deck, wishlist, or tradelist, or tapping a card in someone else's tradelist) and a badge under the name shows "In your collection (×N)" if you own any printing, or flags how many you have marked for trade. No more guessing whether that hot pickup is already sitting in a box at home.

## 0.42.3

- **Tokens and art cards can't sneak into a deck.** If a token, emblem, or art card ends up in your mainboard, command zone, or sideboard, the deck is now flagged illegal, since those aren't real deck cards. As always, Casual decks skip legality entirely, so anything goes there.

## 0.42.2

- **Companion legality got the rules right.** In constructed formats (Modern, Pioneer, …) a companion in your sideboard whose deckbuilding requirement isn't met no longer marks the deck illegal, since you pick the active companion at game start and can side the others in between games. Commander is the one format that allows exactly one companion, so more than one companion in a Commander sideboard is now flagged.

## 0.42.1

- **Importing no longer turns a card into its token.** Lots of cards share a name with a token or art card they spawn (Bloomburrow Offspring copies, eternalize tokens, etc.), and the importer would sometimes grab the token instead, e.g. your Warren Warleader (BLB) landing as the Offspring token. Imports now use the set code to tell them apart, so `Warren Warleader (BLB)` stays the card while a real token line like `Angel (TWAR)` still comes in as the token.

## 0.42.0

- **Pick which missing cards go to your wishlist when leaving a deck.** The "Add missing cards to wishlist?" prompt now gives every card a tick box (all ticked to start) plus a select/unselect all toggle, so you can drop the ones you don't want before adding. The whole add lands as a single batch entry in your edit history that you can open and undo in one go, instead of one row per card.

## 0.41.2

- **Marking a batch of owned cards for trade now shows up in your edit history.** When a tradelist scan flags copies you already own, the whole batch lands as a single "Marked for trade" entry (stacked thumbnail and all) that you can open and undo, instead of silently changing your tradelist with no record.

## 0.41.1

- **Scanning owned cards into your tradelist no longer forces you to choose "add copies" or nothing.** When a scanned card is already in your collection, the tradelist screen now offers **Trade** (mark the copies you already own for trade, adds nothing), **Add** (you got more, add and mark them), or **Skip**. Trade is the default, so scanning your binder just flags what you have instead of doubling your counts or leaving cards off the list.

## 0.41.0

- **Imports and scans land as one entry in your history.** A scanned batch or an imported list (including into a deck) now shows up as a single stacked "N cards" entry instead of flooding the edit history with one row per card.
- **Scanning cards you already own asks before piling on copies.** Adding a scan to your collection or tradelist now surfaces the same Skip / Add / Replace screen as importing when a card is already in your collection, so scanning your trade binder no longer silently doubles your counts.
- **No more accidental double-adds.** Finishing a scan now confirms with a toast and closes the scanner, and the "Add to…" button locks while it saves, so an impatient second tap can't add everything twice.

## 0.40.1

- **Collection list auto-loads when you scroll down.** The "Show 60 more" button is gone; just scroll and the next batch appears, so you never stop scrolling to tap.

## 0.40.0

- **Trade home redesigned into three sections.** The trade landing screen now shows start/join controls at the top, a new "Recent trades" section in the middle listing your last few sessions, and two tiles at the bottom linking to your tradelist and the community trades list — everything you need to get trading in one place.

## 0.39.0

- **Trades survive a dropped connection.** Reconnecting mid-trade no longer leaves you stuck on "Connecting…", cancels a trade that's actually still live, or double-applies the other side's offer. If the relay really can't be reached it now tells you instead of spinning forever.
- **Editing a card's condition or finish no longer hides a duplicate.** If the edit matches another entry you already own, the two now merge into one, the same way the wishlist already did — no more phantom second row that made counts and the tradelist inconsistent.
- **Big collections and lists load faster.** Your collection and other users' trade/wishlists now page in (with a "Show more" button) instead of rendering thousands of cards at once, and "select all → add to tradelist / delete" runs in one go instead of one card at a time.
- **Scanner tidies up after itself.** Closing the scanner now reliably releases the camera even if you close it mid-startup, and it quietly picks up newer card-art data instead of running on the first download forever.
- **Reliability and speed under the hood.** Server-side fixes to connection limits and match lookups so the app keeps working as more people use it, faster sign-in, and search no longer flickers back to stale results while you type.

## 0.38.0

- **Favorite decks are now browsable.** Tapping a favorite deck on someone's profile opens the full decklist — commander, mainboard and sideboard, in the usual list or grid view. The list is read live from the owner's synced decks, so it's always their current build, and renaming a deck now shows up on the profile right away (the old stale-name bug is gone). Only decks you favorite are shared; everything else stays private. Favorites picked before this update share just the summary — re-pick them to make them browsable.
- **Pick the printing of your favorite cards.** Choosing a favorite card on your profile now opens the same edition grid as the card sheet, so your profile can show the right Yawgmoth's Will, not just the newest one.

- Your profile picture now shows on the account button in the top-right corner (sync dot included), instead of the generic silhouette. It also follows you across devices.

## 0.37.0

- **User profiles.** Every account now has a profile page showing a profile picture and up to three favorite cards and three favorite decks. Deck favorites share only a summary (name, format, colors, card count) — your decklists stay private. Find yours via Account & sync, or tap any profile picture in the Community list to visit someone else's; their profile links back to their trade and wishlists.
- **Card art profile pictures.** Pick any card, pick your favorite printing of it, then drag and pinch (or scroll) to frame the artwork inside the circle — Serra Angel's halo or just the business end of a Swiftspear, your call.

## 0.36.0

- **Import and export your tradelist.** The Tradelist page's options menu now has Import and Export, just like the wishlist. Import a pasted list or a file (plain text, Moxfield, Archidekt CSV) and every card lands in your collection marked for trade, with the same skip/add/replace prompt if you already own copies. Export writes the trade-marked cards to a CSV that reads straight back in.

## 0.35.0

- **Dips and spikes on the Price movers page.** A new section lists cards whose price swings up and down within a range and is currently sitting near the bottom or top of it, with the range and a sparkline on each row. What you do with that is your call.
- **Colorless decks now wear the Colorless pip.** A deck with no coloured identity shows the {C} symbol in the deck list instead of nothing.

## 0.34.0

- **Tap a scanned card to edit it fully.** In the scanner's session list, tapping a card now opens its card sheet, where you can change the edition, condition, finish, language and quantity — Apply updates the line in the list, Remove drops it. Conditions now carry through when the session is committed, so a played copy no longer lands in your collection as NM. (The foil chip on the rows is gone; foil is edited in the sheet and shown on the printing line instead.)
- **View all editions, visually.** Next to the Edition dropdown there's a new grid button that lays out every printing as card images with set, number, year and price — tap one to pick it. Works everywhere the edition is editable, including wishlist lines ("Any printing" is a tile too) and trade offers.
- **Card sheet plays nicer with phone keyboards.** Quantity and "For trade" are now −/+ steppers, so most edits never summon the keyboard; tapping the number still lets you type, now with the numeric keypad. And on Android the app now shrinks above the keyboard instead of being covered by it.

## 0.33.2

- Scanner tray tiles now show the full card instead of a cropped slice, and blank-art playtest cards are no longer suggested as matches.

## 0.33.1

- Fixed the card scanner's candidate tray on phones: the card thumbnails no longer balloon to full size — they're sized to fit the tray's quarter-screen strip along the bottom.

## 0.33.0

- **The card scanner is now a continuous, full-screen session.** The camera fills the top three-quarters of the screen and never pauses between cards — as it recognizes each one it drops into a scrollable tray along the bottom. Tap the top half of a tray tile to add another copy, the bottom half to take one back. A list button opens the session for review and editing (quantities, foil, and which deck board a card belongs to), and completing the session writes everything to its destination — collection, deck, trade or tradelist — in one go. No more confirming a single card at a time.

## 0.32.0

- **Quick-add buttons moved into the card sheet.** In the header search, grid tiles no longer carry their own add buttons — tapping a tile opens the card sheet, which now holds the add actions that fit where you are. List view keeps its per-row quick-adds, and the in-trade card pickers are unchanged.
- Searching from a screen with no obvious destination (the Decks tab, Trade tab, or More) now offers all three targets at once: add to collection, wishlist, or tradelist.

## 0.31.1

- Fixed the scanner occasionally matching a blank surface — a bare table or wall — to a real card. A featureless camera frame used to lock onto a blank-art playtest card; the scanner now recognizes when a frame has no artwork to read and ignores those cards entirely.

## 0.31.0

- **Imports now handle cards you already own.** When an import includes cards already in your collection (any printing counts), a new step appears between review and commit: each overlapping card is listed with your owned copies next to the incoming ones, and a per-card choice to **skip**, **add** (keep both), or **replace**. Skip-all / add-all / replace-all handle the whole list at once. A replace and its new copies land in a single history entry, so one undo puts everything back the way it was.

## 0.30.1

- Fixed the "Update now" banner sometimes needing several taps to take. Tapping it now runs the full update handshake — and shows a disabled "Updating…" while it works — instead of a plain reload that could leave the banner stuck reappearing.

## 0.30.0

- **Import, export and scan come to the wishlist**, matching the collection's tools. A new options menu on the Wishlist (available even when it's empty) adds:
  - **Scan** — point your camera at a card to add it as a wish for that specific printing.
  - **Import** — paste or upload a list; everything comes in as "any printing", and the whole import is a single undoable entry.
  - **Export** — download your wishlist as a plain-text list that imports straight back.

## 0.29.2

- Polished the multi-select look from 0.29.0: selected grid tiles shrink into an accent ring (no longer overlapping the info badge), selected list rows get an accent-tinted background and a clear checkbox, and the bulk-action bar is now a floating rounded card with equal-width buttons that slides up into view. The last rows stay reachable while it's open, and the animations respect a reduced-motion preference.

## 0.29.1

- Fixed the card-database download gate reappearing on every refresh for some users, which forced a full ~16 MB re-download each time. (Scryfall had shipped one printing twice; the app now counts what's actually stored on your device, so a count mismatch can never wedge the gate again.)

## 0.29.0

- **Select many cards at once.** Collection, tradelist and wishlist gain a **Select** button that turns on multi-select with a bulk-action bar. In the collection you can add or remove tradelist marking, add to a deck, or delete; the tradelist can remove-from-trade or delete; the wishlist can remove — all across as many cards as you pick, in one action. Bulk edits are recorded in your history just like single edits.

## 0.28.0

- **Decks show more at a glance.** The deck list now displays each deck's format, its colour identity as mana pips, and a mainboard / sideboard split (e.g. 60 / 15) in place of a single card count. For a Commander deck the commander counts toward the 100-card mainboard, and the colours collapse to the commander's identity.

## 0.27.0

- **Trade adds now pick the edition people actually have.** Searching for a card during a trade used to always add the newest printing. Now:
  - Adding to **"You get"** uses the printing from your partner's tradelist — matching finish, condition and language — when they have it listed.
  - Adding to **"You give"** uses your best owned copy: for-trade printings first, then whichever printing you have the most of.
  - The Edition dropdown groups the relevant person's printings first ("In your collection" / "On their tradelist") with quantities, and opens on the best guess. You can still change any offered line's edition in place.

## 0.26.0

- **Full search syntax in your own lists.** The collection, tradelist and wishlist filters used to do a plain name match; they now understand the same Scryfall-style syntax as the main search — `t:`, `cmc:`, `o:`, `c:`, `id:`, `r:`, `f:` and negation all work when filtering the cards you own. The set / colour / rarity dropdowns and the tradelist-only toggle are still there.

## 0.25.0

- **Edit history.** A new **Edit history** page (under More) lists every change you've made to your collection, newest first, with name search plus type and date filters. Imports, sealed-product adds and trades collapse into a single entry (with stacked thumbnails), so a big import reads as one line instead of hundreds. Tap an entry to view it, drill into any card's own History tab, or undo the most recent change.

## 0.24.0

- **QR-code trade invites.** Starting a trade now opens a full-screen invite showing a scannable QR code next to the 6-character join code — your partner just points their phone camera at it to open the app and join, no code to read aloud. A "Start ahead" option lets you build your offer before they arrive, and a QR button on the trade board reopens the invite while the session is still open. (The code encodes a normal https link, so it also works from a plain browser tab or an installed app.)

## 0.23.0

- **A proper card search inside trades.** The "Add cards" pickers in a trade used to have their own cramped, list-only search squeezed into a small sheet. They now use the same full search as the rest of the app — filter row, list/grid toggle, result count and paging — in a full-screen overlay. Ownership indicators (on their tradelist ⇄, owned ✓, or not owned ❓) show as a corner badge in both grid and list.

## 0.22.0

- **Price history from the server.** The server now records every card's market price once a day, for every printing that exists — not just cards you own. When you're signed in, a card's price chart and trend use this shared history, so a fresh device (or a card you just discovered) shows the full recorded window immediately instead of starting from scratch. Histories fetched while online stay available offline.
- **"What was it worth then?" hints.** On the History tab, acquisitions and removals where you never entered a price now show an approximate market price from the archive (≈ €x.xx/ea then) when the archive covers that day — as a hint next to the entry and inside the price editor. Your own entered prices always take precedence.
- Signed-out use is unchanged: your device keeps recording prices for your own collection and wishlist locally.

## 0.19.0

- **Scan cards straight into a deck, trade or your tradelist** — not just your collection. The same camera scanner is now on the ⋯ menu of each of those screens:
  - **Deck** → build a deck you've already assembled physically; a Main / Side (and Commander) toggle picks the board, and the scanned edition is remembered for the slot.
  - **Trade** → scan cards onto your side of the offer as you trade in person, no typing.
  - **Tradelist** → scan through a stack as you fill your trade binder; each card is added and marked for trade.
- Confirm each card with one tap and the camera resumes for the next, exactly like collection scanning.

## 0.18.1

- Shorter bottom navigation bar on mobile so it takes up less of the screen.

## 0.18.0

- **Scan cards with your camera.** Collection → ⋯ → **Scan cards**: point your phone at a card and the app recognizes it from the artwork — in any language, no typing. A small recognition pack (~4 MB, downloaded once and kept up to date automatically) lets everything run on your device; photos never leave your phone.
- After the art match, the app reads the fine print at the bottom of the card to pick the exact edition and language automatically. When the print is too blurry or sleeved to read, it shows the closest candidates and you tap the right one.
- Confirm with one tap (foil toggle included) and the card lands in your collection; the camera resumes on its own so you can work through a whole stack.

## 0.17.0

- **Seamless sync between your devices.** Signing in now keeps every device up to date automatically: add, edit or remove a card (or change a deck) on your phone and it appears on your PC within seconds — no more manual backup/restore. Works offline too: changes queue up and sync when you're back online. If the same card is edited on two devices before they meet, the newest edit wins quietly.
- **Joining a new device:** the first device you sign in on becomes the account's data. Signing in on another device that has its own local data asks once whether to replace it with the account's copy (the app warns you clearly before touching anything).
- **Card history.** Every card's details sheet has a new **History** tab: when you got your copies (and what they cost at the time), when copies left (assumed sold — tap to correct to traded/lost/other, or fix the price), which decks the card has been in, and its wishlist journey (wished for → fulfilled). Cards you already own get an "owned since" anchor from when you first added them; you can fill in what you paid by hand.
- The summary line shows how a card's value has moved since you acquired it.
- **Trades now remember who they were with**: if both traders are signed in, the trade history shows the partner's username instead of "Other User". Anonymous trading still works exactly as before.
- The account button in the header now doubles as a subtle sync indicator: green = synced, amber = syncing or changes waiting, red = a sync problem.
- The old manual "Back up now / Restore" flow and its conflict prompts are gone — sync replaces them. Device-to-device transfer is still available when signed out; while signed in it's disabled (your account already does this, better).
- "Delete all my data" (About) is disabled while signed in, so a device can't silently fall out of step with the account — sign out first, or delete the account itself.

## 0.15.0

- **Card rules text** now appears on the details sheet. Each ability is on its own line, and the mana, tap and other symbols in the text render as the same icons introduced in 0.14.0 — so a cost like "{T}: Add {G}" shows real pips inline instead of plain braces.

## 0.14.0

- **Mana symbols** now render as proper icons instead of plain text. A card's mana cost on its details sheet shows the familiar coloured pips — white, blue, black, red, green, colourless and generic numbers — including hybrid, Phyrexian, snow and tap/untap symbols. The font is bundled with the app and works offline.

## 0.13.0

- **Set symbols** now appear next to card printings — the little expansion icon you see on a physical card. They show up in the Edition picker when you add or edit a card, and beside the set name in your Collection, Wishlist and Price movers lists, so you can tell editions apart at a glance. The symbols are bundled with the app and work offline.

## 0.12.1

- Fixed the bottom navigation bar on Android: it no longer stays stretched tall, and it stops jittering when you change scroll direction. The cause was the browser's URL bar sliding in and out as the whole page scrolled; the app now scrolls its content internally so the browser chrome — and the tab bar — stay put.

## 0.10.1

- Pile view fixes: the heap no longer paints over the search bar, the bottom navigation, or the card details sheet — the app chrome always stays on top and tappable. Scrolling down through a tall pile on a phone is much easier too: a vertical swipe now scrolls even when it starts on a card, while holding briefly (or dragging sideways) still picks a card up.

## 0.10.0

- **Goblin mode** (About & settings): flip it on to unlock a third way to view your collection. Off by default — humans keep their sorting and filtering.
- New **pile view** in Collection (the 🂠 button, once goblin mode is on): your whole collection dumped out in one glorious scattered heap. There's no sorting or filtering — you find a card the way you'd dig through a shoebox, shoving cards around with your finger and scrolling down through the pile.
- **Double-tap** a card to flip it over. Some cards land face down showing the classic Magic card back; double-faced cards (transform, modal DFCs) flip to their actual back face.
- **Press and hold** a card for its details. Hold a face-down single-faced card and you'll get the card back's "details" instead — no peeking at what it really is until you flip it.
- Card images now include real back faces for double-faced cards (used by the pile view's flip).

## 0.9.0

- **Optional accounts** (More → Account & sync): create an account with an invite code to back up your collection, lists and decks to the server — then sign in on another device and restore. The app still works fully without one, and everything stays on your device unless you opt in.
- One combined agreement at signup covers what the feature does: your data is stored on a small hobby server (keep local exports too!), and your **tradelist and wishlist become visible to other signed-in users**. Your collection, decks and price history stay private.
- Backups happen when you tap "Back up now" and automatically now and then when you open the app (you can turn that off). If another device saved a newer backup, the app warns you before anything is overwritten — restore it or overwrite it, your choice.
- New **Community** page (More → Community): browse everyone's trade and wishlists. Cards you want on someone's tradelist and cards you have that they want are highlighted and sorted first — same matching rule as in-person trades ("any printing" wishes match every edition).
- Delete your account any time from the Account screen; it removes your backup and shared lists from the server while local data stays put.

## 0.8.0

- Every card in your collection now has its price tracked automatically — a reading is recorded each day you open the app, with no setup. (The separate price-tracker watchlist is gone; the card sheet shows each printing's sparkline and change since tracking began.)
- Wishlist cards are price-tracked too: a specific-edition wish follows that edition, an "any printing" wish follows the card's default edition — so you can watch for a dip before buying.
- New **Price movers** page (More → Price movers): cards that recently rose or fell substantially, over the last 7 days, 30 days, or since tracking began. "Substantial" blends absolute and percentage change, so a €5 move on an expensive card and a 25% move on a cheap one both count — and tiny penny-card swings don't.
- Price movers also lists **steady trends**: cards drifting consistently in one direction day after day, even in small steps.
- Movers are flagged everywhere you browse: a green rising / red falling chart marker appears on card tiles and rows in Collection, Wishlist, and Tradelist. On the Price movers page, cards on your tradelist or wishlist carry their tag/star symbol so you can spot "should I trade this now?" at a glance.

## 0.7.0

- Search is no longer a tab — it lives in a bar at the top of the app, reachable from every screen. Tap it (or "＋ Add cards" in Collection) to search the whole card database, with the same filters and quick-add buttons as before; Esc, ✕, or switching tabs closes it. Collection is now the home tab.
- Trade: wishlists are exchanged automatically when both partners connect, and a "Wishlist matches" panel shows both directions — cards you have that they want, and cards they have that you want — with one-tap add to your offer.
- Wishlist entries without a specific edition ("any printing", the default) now match every printing of that card during a trade. A wish pinned to a specific edition matches only that edition.
- Tap any card in the wishlist to edit it: quantity and edition, including switching back to "any printing".
- Tap any card in a deck to edit its quantity or remove it (collection and tradelist cards already opened their editor on tap).
- Updates no longer re-download the whole card database. Card data is now served as 32 hash-addressed chunks plus a separate daily prices file, and the app fetches only the pieces that changed — a typical day costs a few hundred KB (fresh prices) instead of the full ~14 MB. First install is unchanged.
- The slow "Preparing editions" step now only runs for chunks that actually changed, and the daily price refresh writes 16 small rows instead of rewriting ~150k card rows — so refreshes on mobile are near-instant. An interrupted update resumes where it left off instead of starting over.
- Import no longer marks cards for trade by default. Moxfield CSVs carry a "Tradelist Count" column (often set for every card), and the importer used to honor it silently — now a "Tradelist" option on the Import page chooses between ignoring it (default), using the file's counts, or marking everything for trade, and the review screen shows how many cards will be marked before you confirm.
- Tradelist: new "Remove all from tradelist" button — clears the trade markings without touching your collection (undoes an import that marked everything).

## 0.6.0

- Trading is live! The Trade tab now connects to the trade server, so two phones (or a phone + PC) can trade with a 6-character code.
- Trade: "＋ Add cards" now searches the entire card database — you can offer any card, not just tradelist entries. Each offered card shows whether it's in your tradelist (⇄), owned but not for trade (✓), or not in your collection (❓).
- Trade: your own tradelist is no longer rendered inline (long tradelists made the page enormous) — it appears as quick-picks inside the height-capped "Add cards" panel instead.
- Trade: "View their tradelist" — either side can ask to browse the other's tradelist during a trade.
- Wide screens: the app now uses more of a desktop monitor — wider content column, larger grid tiles, centered tabs.

## 0.5.0

- Grid is now the default card view.
- Import: unmatched lines are now fixable by hand — tap a suggestion or search for the right card, and it imports with the rest. Typo suggestions are ranked by closeness.
- Import: understands ManaBox `.txt` exports (foil markers like `*F*` and set/collector suffixes are handled, so those cards match automatically).

## 0.4.2

- Tapping a card now shows a large, readable card image in its detail sheet (with mana cost, type, and price), instead of a tiny thumbnail. The image follows the selected edition.

## 0.4.1 — hardening

- Trade offers received from a partner are now validated before display or import (quantities clamped, condition/finish enforced, fabricated cards dropped).
- Card-database downloads are checksum-verified before import.
- Trade connections use a heartbeat so they survive long inspection pauses.
- Price tracking made faster for large watchlists.

## 0.4.0

- Price tracker: watch a card's price ("Watch price" on a card's detail sheet), and the app records its value each time you open it. A new "Price tracker" view (under More) shows every watched card with its current price, change, and a sparkline. Track your whole collection at once from About.

## 0.3.0

- Card grid view (with a quantity badge in the corner) for collection, lists, and decks — toggle list/grid, remembered across views.
- Deck formats + legality checking: pick a format when creating a deck (or change it later), and the deck shows whether it's legal — flagging banned / not-legal / restricted cards, copy limits, and deck size (including Commander's 100-card singleton).

## 0.2.0 — beta hardening

- First-run onboarding (search → collect → trade), with an iOS "Add to Home Screen" hint.
- Error boundary with a copyable diagnostic log (also on the About screen) so bugs are recoverable and reportable.
- Update beacon: the app notices a new published version on launch / when brought to the foreground, not only when the service worker happens to check.
- Nightly card-database refresh so prices stay current.
- Fan Content Policy compliance pass (attribution + checklist).

## 0.1.0 — core beta

- Card database (Scryfall, ~37k cards) downloaded on first launch, then fully offline.
- Search with images, prices, and filters.
- Collection / wishlist / tradelist with editing; import from Moxfield / Archidekt / plain-text; lossless CSV export.
- Decks with owned checkmarks and a "add missing cards to wishlist" prompt.
- In-person trading: 6-character join code, dual offers, accept + confirm, trade history. (Goes live once the trade server has a TLS domain.)
