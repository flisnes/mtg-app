# Changelog

Testers: the app shows an "Update now" banner when a new version is published.

## 0.139.0

- **Deck building from the keyboard.** Point at a card in a deck, binder or box and press `+` or `-` to change how many copies it wants. Down from one takes the card out, which is safe to do on a keystroke now that Ctrl+Z is there to put it back. `Enter` opens the card, `Delete` removes it.
- **Arrow keys walk the cards**, so you never have to reach for the mouse to get to the next one. They move through the deck the way you read it: across a row of tiles, down to the next one, straight through from mainboard to sideboard. Whichever card you last pointed at, by mouse or by key, is the one the other keys act on, and it wears a thin outline so you can see which that is. Escape lets go of it.
- **Ctrl+K jumps to the search box** from anywhere in the app.
- **A run of `+` presses is one line in the edit history, not four.** Taking a card from one copy to four now reads "Storm Crow +4" rather than four separate entries, and one Ctrl+Z takes the whole run back. Presses in the other direction stay separate on purpose, so undo always has something to reverse.
- None of these fire while you're typing, and none of them exist on a touchscreen, where there's no card to point at.

## 0.138.0

- **Copy, cut and paste cards.** On a deck, binder or box: Ctrl+C copies what you've selected, or the whole thing when nothing is selected. Paste it into Discord or a notepad and you get an ordinary decklist. Paste it back into the app and the cards arrive exactly as they left, right down to which printing, finish and condition each slot asked for, rather than a list of names you have to pick editions for all over again.
- **Ctrl+V on a decklist from anywhere else imports it.** Copy a list off a website, press paste on a deck, and the usual import review opens already filled in. No more finding the import panel and pasting a second time.
- **Ctrl+X moves cards between decks.** Cut marks the cards with a dashed outline and leaves them where they are; the move happens when you paste. Change your mind and never paste, and nothing was lost. The whole thing lands as a single move in the edit history, and one Ctrl+Z takes it back, from either deck.
- **Ctrl+A selects every card on the page**, so building a selection to copy isn't sixty clicks. Pressing it twice keeps everything selected rather than throwing the selection away.
- All four leave your typing alone, and copying text you've highlighted on the page still copies that text.

## 0.137.0

- **Ctrl+Z undoes your last change, Ctrl+Y puts it back.** Cmd+Z and Cmd+Shift+Z on a Mac; Ctrl+Shift+Z redoes too. It only ever reverses something that happened where you are: fumble a card into one deck, wander into another, and pressing undo there will not start quietly unpicking the first one behind your back. Instead it says which deck your last change was in. It also stays out of the way while you're typing, so undo in a deck's name box is still the browser's undo of your typing. Nothing older than the current session is in reach of the key, on purpose: the edit history is where last week's changes get reversed, deliberately and with the entry in front of you.
- Redo is scoped the same way, and it declines rather than guesses: if you've changed those cards by hand since undoing them, putting the old version back on top would be a surprise, so it says what happened instead. None of this clutters the edit history. Undoing a change removes its entry, redoing writes one fresh entry, and no amount of pressing either key leaves a trail of "added, removed, added" behind.
- Behind the scenes: the app had picked up half a dozen private keyboard listeners over the years, each re-deciding for itself whether you were busy typing or covered by a sheet. Those questions now have one answer in one place, which is the groundwork for the rest of the deck-building shortcuts.

## 0.136.0

- **Undo is no longer only for the very last thing you did.** It used to be offered on the single newest entry in the edit history and nowhere else, which meant one unrelated change anywhere in the app put the mistake you actually wanted to reverse out of reach. Undo now asks the question that matters instead: has anything newer touched these same copies? If not, it can be reversed, whether it happened five minutes or five weeks ago, and whether or not you have the list filtered down to find it. When something newer *is* in the way, it says so rather than refusing without a reason.

## 0.135.11

- Behind the scenes: which thing covers which (header over page, tab bar under the search overlay, sheets over both, toasts over everything) was seventeen bare numbers spread across the stylesheet, several carrying a comment explaining which other number they had to beat. That is a ladder whether it's written down or not, so it's written down now, in one named list. Nothing moved: every layer computes to exactly the number it did before.

## 0.135.10

- Behind the scenes: the three scoped searches (into your own lists, into the deck or binder you're standing in, and into someone else's lists on Community) each carried their own copy of the same frame: the result count with the sort and view controls, the cards, the "load more as you scroll" sentinel and the "Nothing here matches." line. They now share one, and keep only what is actually different about them. The card-database search still has its own, because it pages by asking for more rather than by revealing more.

## 0.135.9

- Behind the scenes: the list/grid preference could in principle also hold "pile", a leftover from when goblin mode was a third setting rather than its own switch. Nothing could ever produce that value and the code threw it away on the way out, so every screen was handling a case that could not happen. Gone, and a stored leftover from an old install is now tidied up when it's read.

## 0.135.8

- **Buttons that fail now say so.** Most of the app's buttons hand their work to a background task, and if that task failed, nothing came back: no message, no retry, the button just looked dead. The scanner learned to report this a while ago, but only the scanner. Fifteen more of them now report the failure the same way, and it lands in the diagnostics log at About -> Copy diagnostics with it. Affected: editing a price in a card's history, creating a deck, binder, box or folder from a picker, tagging and renaming tags, dismissing a match, changing how many sealed boxes you own, and adding a suggested token.

## 0.135.7

- Behind the scenes: the card sheet does six jobs (add, edit an owned copy, edit a wish, edit a deck slot, edit a scan or trade line, or just show the card), and it used to work out which one by looking at which of a dozen optional inputs the caller had filled in. Callers now say which job they want. Nothing changes on screen; combinations that never made sense are simply no longer possible to write, and reading a screen's code tells you which sheet it opens.

## 0.135.6

- Behind the scenes: the fields a deck slot carries (its printing, what it asks of the copy, its tags, whether it's filed) were spelled out by hand in four places, all optional, so leaving one out was nobody's error. That is how 0.135.3's unfiled flag needed a follow-up. There is now one definition, worked out by subtracting a slot's identity from the stored row, and the screens that pass slots around copy them whole instead of field by field. No change to what the app does.

## 0.135.5

- **Fixed: a device on an older version no longer strips fields off your own data.** Every device rebuilt each row it pulled from the account out of the fields it knew about, so a phone or PC running a build older than a feature quietly wrote the new field away and moved on. That is what lost container kinds in 0.75.1, emblems in 0.134.7 and unfiled slots in 0.135.3, each needing a full re-download of the account to put right. Fields a device doesn't recognise now travel through it untouched.
- **Fixed: a new kind of data can no longer be skipped for good.** A device also used to step past rows belonging to a table its version didn't have yet, which is why unopened boxes added on a phone never turned up on a PC still on an older build. It now stops just short of anything it can't apply and picks those rows up after it updates.
- Behind the scenes: adding a field to synced data now fails the build until it's declared, so this class of bug is caught before release rather than by a tester weeks later.

## 0.135.4

- **Fixed: back can no longer skip a page when you close the search or a sheet.** Every overlay parks a throwaway history entry so back closes it instead of leaving the page you were on. Which entry belonged to which overlay was matched by URL, and every entry in the stack has the same URL, so an overlay that shut down while another sat on top of it could spend the wrong one. The next close then took a real page with it, and you landed one screen further back than you asked for. Entries are stamped now, and an overlay only ever spends its own.

## 0.135.3

- **You can now take cards out of the deck you're standing in.** Select cards in a deck, binder or box, tap Unfile and the list you're looking at is the first thing on offer. Before this it only listed the *other* places those copies were filed, which is no help when what you want to say is "these left this deck".
- **Unfiling from here empties the slot without editing the list.** The card stays on the decklist, still asking for exactly the copy it did (printing, finish, condition, language); it just stops holding one. The solid green "filed here" box swaps to the double checkmark, the row says "not filed here", and the copy is free for another deck with no filing conflict raised. That's the deck you pulled apart for parts but haven't given up on.
- **"File back here" puts them back.** It shows up in the same selection bar as soon as anything you've picked is out of the list. Assembling the deck from your collection, re-scanning it, or saving the card's own sheet also files it back.
- Taking cards out of another container still takes them off that list, as before. The picker now says which of the two you're about to do.

## 0.135.2

- **Fixed: pulling down to refresh works again.** Version 0.134.5 pinned the scroll gesture to the page to stop the bottom nav bar sliding half off the screen. It also took the browser's own pull-to-refresh with it, which was never the intent. Retracing it, the nav bar was already protected twice over: the page body has blocked the gesture reaching the browser since the first build, and since 0.12.1 the app scrolls an inner container so the document itself never moves. The half-hidden nav bar was almost certainly a slight pinch-zoom instead, which parks the fixed bar below the visible area until you pinch back out. Both rules from 0.134.5 are gone.

## 0.135.1

- **Fixed: the small print under a deck, binder or box in a list was rendering wrong.** The format, colour pips and card count sat at full text size in normal colour, pushed apart across the width of the row, instead of the small dim line they were meant to be. Two different screens had each defined a style called `.deck-meta`, and the deck detail page's version was quietly winning on every list in the app. The same line on the container picker, the emblem picker, the filing conflicts screen and profile pages was affected. Renamed one of them; the deck detail header is unchanged.
- **The app downloads about 33 KB less on first open.** The archive of older release notes and the two internal harness screens (`#/scan-test`, `#/avatar-lab`) now load only when something actually asks for them, rather than riding along in the file every device fetches on first load. The full release notes at About -> What's changed still list every version back to 0.98.0.
- Behind the scenes: two stylesheet rules that had been written out twice were merged, and the release notes are now split between a recent slice and an archive file.

## 0.135.0

- **Card search now sorts.** The search overlay gained the same Sort control every list in the app has: best match, name, mana value or price, either direction. Best match is still the default, so nothing changes until you ask it to. Sorting by price ranks the whole result set, not just the page you can see, so "most expensive first" on 2,900 hits really does put the dual land on top.
- **Search scoped into one of your lists sorts by that list's own options.** Hunt through your collection from a deck screen and you get price change, price change %, date added and last edited alongside the usual three, exactly as the collection page offers them. The same goes for your tradelist, your wishlist, the deck or binder you're standing in, and the lists of anyone you're browsing on Community.
- **It's the list's own sort, not a second one.** Reorder your collection from inside the search and the collection page has already reordered when you close the overlay. Before this, scoped search was always locked to A-Z with no way to change it.

## 0.134.9

- **Recent searches now hang off the search bar instead of taking over the screen.** Tap the bar and a small translucent panel drops down over your cards, browser-style: no boxes around the rows, and the collection stays visible behind it. Arrow keys walk the list and Enter takes the highlighted one, so a long Scryfall query is two keystrokes away without reaching for the screen.
- **The list also filters as you type and remembers 500 searches instead of 10.** Typing "goblin" narrows it to every past query with "goblin" anywhere in it, so an old `t:goblin o:"draw a card" cmc<=3` is findable weeks later. The × on a row still forgets it, and "Clear history" at the foot of the panel wipes the lot.

## 0.134.8

- **The app now carries the licences of the open source it is built on, at About -> Open source licenses.** Twenty-eight components, from React and Dexie to the Tesseract engine behind card scanning and the Keyrune and Mana symbol fonts, each with its copyright line and full licence text. MIT, BSD and Apache-2.0 all ask that those notices travel with the app, and they were not there before. The page is generated straight from what actually ships, so it cannot drift, and it loads only when opened.
- **Added: MTGJSON credited for sealed product data, which its CC BY 4.0 licence requires.** The About screen now also names TCGCSV and Cardmarket for sealed prices, Frankfurter for exchange rates, and Andrew Gioia for the two symbol fonts. Scryfall and the Wizards Fan Content notice were already there.
- Behind the scenes: the repository now states its own licence, and a comment claiming the Mana font was MIT has been corrected to the SIL Open Font License its authors actually released it under. Nothing about the app changes.

## 0.134.7

- **Fixed: a deck, binder or box emblem could go missing on your other device and never come back.** Emblems arrived in 0.133.0, and any device still running an older build at the time quietly threw the emblem away as it took the row in, then marked that change as seen. Updating the app afterwards didn't help: as far as it knew, it was already up to date. The app now re-reads your account once on the next open and puts the emblems back. Nothing else is touched, and edits waiting to go out still win.

## 0.134.6

- **"Pick one from my collection" no longer dead-ends when the edition you are holding was never added.** The copy picker now carries a "Not here? Add a copy" line under the grid. It opens the collection form for that card, and the copy you describe there goes straight into the slot you were filling, edition, condition, finish and language and all. Previously the only way out was to back out of the deck, add the card, and come back.

## 0.134.5

- **Fixed: tugging down at the top of a page slid the bottom nav bar half off the screen.** Not the pull-to-refresh kind, just an ordinary short swipe when there was nothing left to scroll. The gesture was escaping the page and landing on the browser itself, which answered by sliding its own chrome back in and shoving the tab bar under the edge of the display. The swipe now stops at the page, so Collection, Decks, Trade and More stay put no matter how hard you pull.

## 0.134.4

- **The trade tag and the wishlist star now fill in solid when the printing you are looking at is the one on the list.** Same step in certainty the second checkmark makes for your collection: a tinted chip means "this card is on that list somewhere", a solid one means "this exact printing is". The purple tag fills when the copies you have marked for trade are of the edition on screen, and the gold star fills when the wish names that edition, or when it is set to "any printing" and every edition counts. Hover or long-press either one and the tooltip spells out which case you are in.

## 0.134.3

- **Cards on your wishlist now wear the star wherever you meet them, and adding a card from its sheet says so before the sheet closes.** Searching the whole database and adding something to your wishlist used to look like nothing happened: the sheet just shut. Now the result gets the same gold star the trade board uses, so you can see at a glance which of these you're already hunting, and it shows up on deck slots you don't own yet too. Your own wishlist doesn't star itself, the same way the collection doesn't checkmark itself; what it shows is whether you've since picked the card up. Adding to your collection, tradelist or wishlist from a card sheet now answers in the button's place ("Added to wishlist") for a moment before the sheet bows out.

## 0.134.2

- **The release notes are now readable whenever you want them, not just once.** Every version's notes ship inside the app, but until now they flashed past in the popup after an update and were gone. Tap the app version in About and the whole history opens in a scrollable sheet, newest first, so you can go back and find the change you half-remember.

## 0.134.1

- **Fixed: two different printings of the same card added to a binder or box collapsed into one, and the printing you picked second was thrown away.** Nine Nazgûl arts went in and one came out, quantity ×2. The add was folding everything with the same name onto one line, the way a pasted decklist should, which is wrong for a shelf: the Revised one and the Fourth Edition one are two different pieces of cardboard sitting in there. A line is now identified by what it names — printing, finish, minimum condition and language — so the arts you picked stay separate, while adding another of a printing already filed still lands on the line that's there, and "any printing" adds still pool together. The + button in search results now files the edition you were looking at, too, instead of dropping it.

## 0.134.0

- **New accounts now start with a profile picture instead of a grey letter.** Everyone who signs up is dealt one at random from 145 hand-checked card arts, each already framed on the face, so the Community list looks like a table of players rather than a spreadsheet. It is yours from the moment you create the account: change it to any card in Magic from your profile, or remove it, and it stays that way. Accounts that have already saved a profile are left alone.

## 0.133.2

- **A symbol or set-symbol emblem can now be tinted.** Ten colours plus the default, on their own row above the picker: tap a colour and the whole grid previews in it, then tap the symbol you want. Tapping a colour when the deck already wears a symbol recolours it on the spot and leaves the picker open, so you can try a few against the list behind it. Tinting a mana symbol drops the coloured pip and draws the bare glyph in your colour instead, since a cream circle with a red W in it is nobody's idea of an emblem. Card-art emblems are unaffected, and the colour travels with the deck like the rest of the emblem.

## 0.133.1

- **Fixed: updating to 0.133.0 could leave a signed-in device stuck syncing, with most of the collection, decks and lists missing while cards flickered in and out.** Nothing was lost. The account on the server was never touched; only the copy on the device was, and it comes back on its own once this version has synced.

  What went wrong: 0.133.0 asked every device to re-pull its account from the start, which was never necessary for a brand new field. Worse, re-pulling did not work on an account with more than one page of history. The server hands back 2000 changes at a time, and when the device came back for the second page the server decided it had fallen too far behind and told it to start over from scratch, wiping what it had just received. Second page, start over, wipe, forever. Both halves are fixed: nobody is asked to re-pull for a new field again, and a device that is part-way through re-pulling now says so, so the server hands it the next page instead of sending it back to the start.

## 0.133.0

- **A deck, binder or box can now wear an emblem in the list instead of the same generic icon as everything else.** Three ways to pick one: a crop of any card's art, framed the same way a profile picture is; a Magic symbol from the bundled font, which covers mana pips, the tap and phyrexian symbols, card types, counters, keywords, the Ravnica guilds, the Tarkir clans, the Strixhaven colleges and a pile of watermarks; or the set symbol of any set the card database knows. Reach it from the ⋯ menu on a row, or by tapping the icon next to the name on the container's own page. The emblem also shows up when you file cards into a container, so the list you are aiming at is recognisable at a glance. It lives on the deck itself, so it travels with your account to your other devices and survives a device-to-device transfer.

## 0.132.0

- **The padlock ring on the scanner now shows the scanner closing in on a card, not just the countdown after it has.** It fills as the camera banks the frames that agree on what it is looking at, so a wobbly hand or a glared foil visibly knocks it back to empty and you can see why nothing is locking. The instant it comes full the card locks and the ring turns accent-coloured, then drains over the three seconds before the scanner is willing to take a second copy of that same card. Tapping the padlock at any point after the lock lets go immediately, exactly as before.

## 0.131.0

- **Card scanning can now work out the edition of an older card.** Pinning down which printing you are holding leaned on the collector number and the set code in the bottom strip, and both of those are modern inventions: the set code only turns up from Magic 2015 onward, the collector number only from Exodus in 1998. Older cards carry neither, so a 4th Edition Counterspell gave the scanner nothing to read and always dropped through to the manual picker. It now reads the copyright year as well, which every card back to Fallen Empires prints, and on a reprint that year is usually the only thing separating one edition from the next.
- **The scanner was reading only the left half of the bottom line.** The strip it looked at was measured on a modern card, where the collector number sits in the bottom left corner. On every frame between 1998 and 2014 the number is tacked onto the end of the copyright line instead, out to the right, so it was being sliced in half before the scanner ever saw it. That covers roughly 26,000 printings. It reads the whole line now, stopping short of the power/toughness box so a 1/1 can never be mistaken for a collector number.
- **When a card genuinely cannot say which printing it is, scanning now says so** rather than picking one and sounding sure. Alpha through Revised print no year, no number and no set code, so nothing down there can tell them apart, and two candidates sharing a year is a coin flip rather than a reading. Those scans skip the strip entirely, which also saves the several seconds it used to spend proving it could not read what was never printed.
- Measured over 67 scans spanning every frame from Alpha to today: the exact printing was confirmed 27 times, up from 19, and the right printing came out on top in 40 cases instead of 26. Cards from 1995 to 1997 went from none identified to four of five. Modern cards are unchanged, and neither the old nor the new run ever confirmed the wrong printing.

## 0.130.4

- Device-to-device transfer lost a cancel message the app never sent. Backing out of a transfer has always worked by simply hanging up, which the relay already turns into "the other device disconnected" on the far end. The unused second route through the relay is gone. Cancelling a transfer behaves exactly as before.

## 0.130.3

- Last of the style housekeeping: the ownership badges (owned, marked for trade, filed right here) shed a wrapper class that no longer exists in the app and a fourth "unknown" state nothing has set for a long time. The badges themselves look exactly as they did.

## 0.130.2

- More housekeeping with nothing on screen to show for it: dropped eight style rules for elements the app no longer renders. Every class name still in use was checked, including the ones built on the fly from a card rarity or a price direction.

## 0.130.1

- Housekeeping, nothing to see on screen: removed seven functions that nothing called any more. Leftovers from features that moved on, including a history filter whose one caller is long gone and a card-tag helper the tag field stopped using.

## 0.130.0

- **A big trade now syncs.** Registering a trade of more than about 160 cards saved it locally and then quietly failed to reach your other devices: the server refused any single synced row over 32 KB, and a trade that size is bigger than that. The size allowed per row is now set per kind of row, with trades given room for the largest offer the trade screen can even build.
- **Your account now has a stated storage limit, and it is a generous one.** Signing in gave the server no real bound on how much one account could store. There is now a size budget as well as an item count, sitting at roughly four times the largest real collection we have measured (20,000 cards, 25 decks, a hundred trades). Deleting things always goes through even at the ceiling, so an account can never wedge itself shut.
- **Deletions no longer pile up on the server forever.** Removing a card left behind a permanent marker so your other devices would learn it was gone. Those markers are now cleared once every device on the account has seen them, which for a single-device account is immediately. A device that has been offline for months and missed the clear-out refreshes itself from the account instead, so it can't sit there showing cards you deleted long ago. Nothing local is lost when it does: whatever that device had queued up is sent first.
- **A deck, binder or box name now stops at 200 characters** in the name field. That was already the limit everywhere else, so a longer one silently got cut down the next time it travelled between devices.
- Removed the old whole-collection backup that sync replaced back in 0.17.0. Nothing has used it since, and the dead copies it left on the server are gone.

## 0.129.8

- **`set:` now works in your own lists, not just the card search.** Typing `set:znr` (or `s:`, `e:`, `edition:`) while the search is pointed at your collection, tradelist, wishlist, a deck, a binder, a box, the price movers or someone else's published lists matched nothing at all, because those lists were searched without any edition information to match against. They now filter on the printing each row actually is, so `set:znr` in your collection means "the copies I own from Zendikar Rising" rather than "cards that were printed in Zendikar Rising at some point". `is:foil`, `is:promo`, `is:borderless` and the other printing keywords went the same way, and match the copy in front of you: `is:foil` on your collection lists your foils.

## 0.129.7

- **Filing cards you just opened no longer asks about the copies you already had.** Crack open a precon and file its contents, and every card in it that you also own elsewhere used to raise "already filed somewhere else, did it move?" — a nonsense question, since the box brought its own cardboard along. The filing question now counts copies: it only asks when the decks, binders and boxes would between them hold more of a card than you actually own, which is the same rule the filing-conflict flag has always used. Same for a CSV import, a scan, or filing two of your four Islands into a box while a third sits in a deck. When it does ask, it now names only the copies that are genuinely short.

## 0.129.6

- **"Fixed incorrect card information" is now one of the reasons a copy can be gone.** Working through a filing conflict and picking "I don't have it any more" asks what happened to it. Since correcting a copy's finish, language or edition is itself a common cause of the conflict, that is now a reason of its own, and your history records it as a correction rather than a sale.
- **The deck, binder and box tabs stay put in the "File away" picker.** With more decks than fit on screen the whole sheet scrolled, taking the Decks / Binders / Boxes tabs off the top with it, so filing a card into a binder or a box looked impossible. Only the list scrolls now; the tabs, the name field and Cancel stay where they are.

## 0.129.5

- **Fixing a card's details keeps it where it is filed.** Changing a copy's condition, language or edition is a correction of how it was filed in the first place, not a new card arriving, so the deck, binder or box holding that copy follows it. Before this, the old slot kept claiming a card that no longer existed (an amber filing conflict) while the corrected copy looked like it had never been filed. If the corrected copy lands on one the same container already holds, the two slots merge.

## 0.129.4

- **A box on the shelf can now be cracked open.** Owned sealed products have gained an **Open it, add the cards** button: pick how many copies you're opening, set the condition and language, and the contents land in your collection while the shelf count drops by what you cracked. Until now the only way in was to add the product a second time as cards and delete the unopened one. Booster boxes and packs say why they can't be opened this way, since nobody knows what's inside. As with every other bulk add, it finishes by asking where the cards live so you can file them in a deck, binder or box straight away.

## 0.129.3

- **Sealed products now turn up on your other devices.** A device that synced while running a build from before unopened boxes existed skipped those rows and moved its bookmark past them, so boxes added on the phone never reached the PC (and, further back, the same happened to deck folders). Every signed-in device now re-reads its account once and picks up whatever it missed. Nothing to do but open the app on both devices.
- **The Collection menu lost its "Sealed products" entry.** It was a second door to the same room: the sealed shelf lives under More, and "Add sealed product" is still right there in the menu.

## 0.129.2

- **The rules-text chip shows the `~` it searches for, and catches a half-highlighted name.** The button now reads back the same phrase it will search, so you can see the card's name has become `~`. You also no longer have to start the drag right on the first letter of the name: highlight "olt deals 3" on Lightning Bolt and the chip still offers "~ deals 3". Highlighting nothing but the name gives no chip, since every card that says its own name would match.

## 0.129.1

- **Highlighting a phrase with the card's own name in it now searches for the name-agnostic version.** Select "Whenever Grizzly Bears attacks" and the search runs for `o:"whenever ~ attacks"`, where `~` stands for whatever the card calls itself, so every card with that same trigger comes back instead of just the one you started from.

## 0.129.0

- **You decide how many card images the device keeps.** Settings has a new **Card images** section with a slider (and a number box, if you'd rather type it) for how many card pictures to cache, from 100 up to 10,000. Underneath it says roughly how much storage that comes to when full, and how many images are cached right now. Hit **Save** to apply it: set it lower than before and the oldest images are pruned on the spot, so the space comes back immediately. Cached pictures load instantly and work offline, so this is the trade between your data plan and your free space.

## 0.128.0

- **Highlight rules text to find every card that shares it.** Select a phrase in a card's rules text and a "Search rules text for ..." button appears just below it; tapping it searches the whole database for cards whose text contains that phrase. Mana symbols inside the phrase come along, and a selection spanning two abilities searches for both parts. Your phone's own Copy/Share menu still does what it always did; this sits under the text, out of its way.

## 0.127.2

- **The Land heading counts your sneaky lands too.** Grouping a deck by card type now shows the Land pile's count and, behind it, the total that also counts the land halves of modal double-faced cards and lands that moonlight as something else (Dryad Arbor). Tap the (i) to see exactly which cards were added. Transforming cards whose back is a land are left out: you can't play those as a land.

## 0.127.1

- **The multi-select bar starts as one line.** Selecting cards used to pop up a bar with every action laid out, which on a phone covered a good chunk of the list you were picking from. Now it shows just the count, "Select all" and a chevron; tap the chevron when you want the actions.

## 0.127.0

- **Cards can be moved between a deck's zones.** Tap a card in a deck and its sheet now has a **Zone** field: mainboard, sideboard, command zone, tokens. Pick another one, hit Save, and the card moves — no more removing it from one zone and adding it again to the other. A zone the card can't go to is greyed out and says why, so "this can't be your commander" is answered where you asked it.
- **Multi-select can move a whole selection at once.** Select, then "Move to…", then pick the zone. Cards already in that zone are left where they are, and a card meeting its own copy on the far side merges with it rather than splitting into two lines.
- Either way it's one entry in the edit history ("Moved to sideboard"), undoable in a single tap, and a move no longer counts as cards coming in or going out of the deck.
- **The Select button follows you down the page.** It used to sit in the toolbar at the top, which is nowhere near where you are when you decide you want to select things. Once the toolbar scrolls off, the button reappears floating above the tab bar; tapping either one does the same thing. Nothing else in the layout moved.
- The command-zone buttons that used to live in the card sheet's action row are gone, replaced by the Zone field above.

## 0.126.0

- **Sealed products are tracked like cards now.** The app records what every unopened box, display and precon on your shelf is quoted at, once a day when you open it, and the "Sealed value" figure on the Sealed products page opens a chart of what the whole shelf has been worth. Dots on the line are the days something arrived; tap one to see what it was. A box counts from the day you added it, so the line steps up when you buy rather than pretending you always owned it.
- **Tap a product to open its own sheet:** box shot, price each, what your copies add up to, a sparkline of its recorded price, and the full chart behind it. Copies and Remove live there too.
- **Grid view on the Sealed products page.** The list/grid toggle is the same one the collection uses, and box shots sit in square frames rather than card-shaped ones (a display is square, a pack is tall).
- **Two new sorts: price change and price change %,** alongside the existing price and total value. Rows and tiles also carry a small green or red movement marker.
- Products neither TCGplayer nor Cardmarket quotes are counted out loud rather than quietly left out, and a product you sell off has its readings dropped on the next launch.

## 0.125.1

- Internal: the server deploy now typechecks before it builds. The bundler stripped types without checking them, so a type error in the server could reach production and only be caught by the health check. Nothing changes in the app.

## 0.125.0

- **The emergency card-database download works again.** If our server is unreachable the very first time you open the app, it falls back to fetching cards straight from Scryfall. Scryfall changed the format of that download last month and the fallback was never updated, so it failed instead of rescuing you. It now reads the new format, and unpacks the file as it arrives rather than holding all of it in memory at once, so it works on a phone too. A single damaged line is skipped instead of costing you the whole download.
- This only ever runs when you have no card data yet and our server can't be reached. If you already have cards, nothing about your app changes.

## 0.124.2

- **Price history now reaches back to mid-May, not just to the day we started recording.** The server only knew prices from the day its archive went live, so every chart began there. It has now pulled in MTGJSON's rolling 90-day window of the same two series we track (Cardmarket in euro, TCGplayer in dollar), which backdates every printing to 2026-05-18. Card sheet trends, the "≈ €x/ea then" hints in a card's history, and "Since tracking began" in Price Movers all see roughly two extra months.
- Days the archive missed while the server was down are filled in from the same source. Readings we recorded ourselves always win, so nothing you already saw changes value.

## 0.124.1

- **A card sheet no longer flashes the wrong edition.** Opening one used to paint whatever printing the card database calls representative, then swap to the right one a moment later: the copy you own, the edition your deck records, or the one your printing preference picks. The art now waits until we know which edition to show, then fades in.
- **The foil sheen waits for the card.** It used to shimmer over an empty frame while the image was still downloading. It appears with the art now.
- If the right edition's image can't be fetched, the card's default art still fills in rather than leaving you an empty frame.

## 0.124.0

- **"Newest normal printing" now means normal.** It already skipped promos, prerelease stamps and Secret Lairs, but a modern set prints the same card four or five ways, and the borderless one, the showcase one, the extended-art one and the surge-foil one all count as the same ordinary set. So the setting kept landing on a card you'd never pull from a pack. All of those are now recognised and skipped: borderless, showcase frames, extended art, retro frames, foil-etched, serialized, and every chase foiling Wizards has invented (surge, galaxy, halo, ripple, textured and friends).
- **"First printing" was worse, and is fixed the same way.** Every variant in a set shares one release date, so which one you got was decided by a UUID comparison. Fable of the Mirror-Breaker showed as its Kamigawa showcase; Sheoldred showed as her prerelease promo. Both now show the plain version they debuted as.
- **"Newest printing" picks the plain one too**, when a set released several versions of a card on the same day. It still means the most recent edition, it's just no longer arbitrary about which of that day's versions you get.
- **Search knows about all of this.** New keywords: `is:borderless`, `is:showcase`, `is:extendedart`, `is:retro`, `is:serialized`, `is:specialfoil`, `is:inverted`, `is:textless`, `is:boosterfun`, and `is:variant` for any of them. They work the way `is:foil` does, matching if *any* printing of the card qualifies, so `is:serialized` finds cards that exist as a numbered copy and `-is:variant` finds the ones that only ever came one way.
- Takes effect after the next daily card-data update, which is where the new printing details come from.

## 0.123.0

- **The Edition picker is one line now.** It used to be two: a filter box that was empty most of the time, stacked on a dropdown. Closed, it shows the printing you're looking at and nothing else. Tap it and that same line becomes the search box while the list of editions unfolds below it, the edition you're on sitting at the top.
- **Every edition in the list wears its set symbol.** Recognising Ravnica by its skyline beats reading forty set names, and a native dropdown could never show one.
- The list still groups a trade partner's printings first, still leads with editions you own, and the grid button beside it still opens the full picture-by-picture view. Arrow keys and Enter work in the list; Escape closes the picker without closing the card.

## 0.122.0

- **Speculating on cheap cards in bulk finally registers.** Thirty copies of a 40-cent card creeping to 55 cents is €4.50 of your money moving, and Price movers used to say nothing at all: the move passed the percentage test and then got thrown out as noise, because "noise" was measured one copy at a time. Both the noise floor and the formula now count every copy you own, so a spec pile that moves gets reported like the position it is.
- **A new dial for it: "Move across all your copies", default €10.** It only applies to cards you own more than one of, so a collection of singles behaves exactly as it did before. Playsets benefit too: four copies of a €20 card going to €22 is €8, which now counts even though €2 on its own wouldn't.
- **Rows say what the stack did.** A card you own multiples of shows `×30 = €4,50` next to the per-copy change, so a 15-cent move never reads as a rounding error.
- **The price filter is now a value filter.** It asks what your copies are worth together, not what one costs, so setting "Value: €5+" no longer hides the pile you bought precisely because each card was cheap. New "Sort: Value held" to go with it.
- The up and down arrows on cards elsewhere in the app follow the same rule, so a spec pile that's moving is marked in your collection list too.

## 0.121.0

- **Price movers takes tuning now.** The thresholds behind the four sections were baked in: a card had to move about €5 or about 25% before anything said so. The ⋯ menu on the Price movers screen opens "Tune the formula", where ten sliders decide what counts as news for you. Drop them if you want to hear about every 60-cent wobble, raise them if you only care when a card moves real money.
- What you can set: the cash and percentage moves that qualify on their own, the floor under which a move is just noise, how straight a line has to be (and how far it has to travel) before it reads as a steady trend, and how close to the ends of its range a card must sit to count as a dip or a spike. The readings and days of history each section needs are dials too, so you can see something during your first week of tracking instead of waiting it out.
- The settings stick on the device and the header says "custom formula" while they're off the defaults, with one tap back to how it shipped. The up/down arrows on cards elsewhere in the app follow your thresholds too, so the badges and the movers screen never disagree.

## 0.120.1

- **Tokens no longer colour your deck.** A mono-white commander deck that makes a white-and-black cleric was showing up as Orzhov in the deck list. Tokens are left out of the colour identity now, so the pips match what the deck actually plays.

## 0.120.0

- **Suggested tokens now suggests the rest of the cardboard too.** A deck's suggestions used to stop at tokens it puts onto the battlefield, so everything else a game asks you to keep track of was left to memory and a pile of dice. Emblems, Poison Counter, Energy Reserve, Experience, The Monarch, Day // Night, The Ring // The Ring Tempts You, On an Adventure, Plot, Radiation, Start Your Engines! // Max Speed, and the face-down helpers for morph, manifest, disguise and cloak all show up now, as does Foretell for the cards you exile face down.
- **Dungeon decks get the right dungeons.** Venture cards suggest Dungeon of the Mad Mage, Lost Mine of Phandelver and Tomb of Annihilation; cards that take the initiative suggest Undercity // The Initiative. You only get the ones your deck can actually use.
- These are real printed cards, so they come with the same "do I own one?" badge as everything else, and one tap still files them into the deck's token board without counting toward deck size.

## 0.119.0

- **Price movers can be narrowed down.** Four sections of cards was a lot to read through when you only wanted one of them. There's now a "Show" picker for a single section, a "List" filter for cards in your collection, on your tradelist or on your wishlist, and a minimum-price filter so the 40-cent commons stop crowding out the cards actually worth watching. The alongside-it time window is unchanged.
- **Price movers can be sorted.** Every section starts on "Most notable", which is what it always did, and you can switch to change, change %, price or name, ascending or descending. The choice sticks between visits; the filters deliberately don't, so you never come back to a list with holes in it.
- **Search now filters price movers in place.** Tapping the search bar on the movers screen offers a "Price movers" chip, on by default, exactly like the collection, tradelist and wishlist chips. Typing narrows the four sections instead of covering them, and full Scryfall syntax works: `t:land`, `c:r`, `o:"draw a card"`. Turn the chip off to search the whole database instead.
- **Sealed products can be filtered and sorted.** Filter by name, set, product type (booster box, bundle, deck, and so on) or whether a market price is known, and sort by name, price each, total value, copies, set, release date or date added. Each row now names its product type too, so the type filter has something to point at.

## 0.118.0

- **Sealed products are priced in euros too.** Last release could only quote them in US dollars, because the American market was the only sealed price we could get at. Cardmarket publishes its own daily price guide and permits open use of it, so European prices are in now: every sealed product carries both, and they follow the same "Show prices in" and base-currency settings as everything else. Sealed products no longer sit apart from the rest of your collection's value in a currency you don't shop in.
- **The two markets disagree, and now you can see it.** A Bloomburrow collector booster box trends around €783 on Cardmarket and around $1,173 on TCGplayer. Whichever your base currency is, that's the market you're quoted, with the source named beside the price. If a product is only listed on one of them, the other one fills in rather than showing nothing.
- Coverage is close to total: every sealed product Cardmarket lists has a price.

## 0.117.0

- **You can own a sealed booster box now.** "Add sealed product" was only ever a shortcut for the cards inside a precon, so anything with random contents — booster boxes, displays, collector boosters, a single pack — wasn't even in the list. Every sealed product Magic has ever had is in there now, and picking one asks what you actually mean: keep it sealed, or open it and put the cards in your collection. Products whose contents are random only offer the first, because nobody knows what's in an unopened pack.
- **Sealed products have pictures.** Box shots come from TCGplayer's product photos, so the shelf looks like a shelf. Products with no photo fall back to a box symbol.
- **A "Sealed products" screen, under More.** Everything you're keeping sealed, with a count you can nudge up and down as boxes come and go. It's a separate screen on purpose: a booster box isn't a card, and it has no edition, condition or language to sort by.
- **Sealed products are worth something.** Each one shows its TCGplayer market price, the screen totals them, and the collection's total value counts them too. Prices are in US dollars for now and labelled as such — there's no European sealed price feed we can use yet, and quietly converting a US price into euros would be worse than showing the dollar figure. Products with no market price are left out of the total and the screen says how many.
- **"Which precon was this card in?"** Open any card, tap ⋯, and "Find sealed products with this card" lists every fixed-content product that contains it — any printing of it, not just the one on screen. Cards that only ever came out of booster packs say so, since a random pack isn't an answer.
- **Fixed: a device transfer used to unfile every deck.** Deck folders were packed up and sent, then thrown away on arrival, so decks landed on the new device with their folders gone.

## 0.116.0

- **Everything that puts cards in your collection now asks where they live.** Scan a shoebox, paste a CSV, add a precon: all of them used to leave the cards floating in your collection, filed nowhere, and the only way to fix that was to walk back to the list, tap Select, tick every row again and use "File away". Each of those now ends with "Where do these live?" — pick a deck, binder or box (or make one on the spot), and it goes through the same "this copy is already somewhere else" question that filing has always asked. Or say "leave them unfiled" and nothing changes.
- **Importing a list no longer deletes more than it says.** The duplicate screen's "Replace" quietly removed *every* copy of that card you owned — a different printing, a foil, a played one, all of it — and put the file's copies in their place. It's now called **Update** and does exactly what the scanner's Update has always done: swap one copy you own for the imported printing, keeping your total the same, and ask which copy when you own the card in more than one version. Both screens run the same code now, so they can't drift apart again.
- **Importing into a binder or box registers the cards as yours.** Scanning a pile into one has always offered to also add it to your collection; pasting the same list didn't, so the container filled up with cards marked "you don't own this". Both now end with the same tick-list.
- **Importing to the tradelist can say "these are the ones I already have".** Scanning cards you own into the tradelist offers to mark those copies for trade instead of adding new ones. Importing the same list only offered "add another copy" or "delete mine". It now offers Trade as well, with Trade as the default.
- **Pasting the same list twice says so.** A decklist or wishlist import now counts what's already there and asks once for the whole list: add on top, skip the ones already there, or top up to the count the list asks for.
- **A pasted pile can say what it is.** Import screens now carry the scanner's pile pins: set the condition, finish and language once for the whole list. A CSV that names its own still wins, line by line. Sealed products get condition and language too, so a Japanese precon isn't 100 cards to correct by hand.
- **A wishlist import keeps the edition you asked for.** Every line used to become "any printing, Near Mint, nonfoil, English", even when the file said `1 Sol Ring (C21) 263 *F*`. A line that names an edition now wishes for that edition; the rest still mean "any printing".
- **Re-scanning a deck settles where the cards came from.** Scanning cards *into* a deck asks whether they moved out of wherever they were; re-scanning the same deck wrote its list straight out and left the old claim behind, which turned up later as a filing conflict. Re-scan now asks the same question — and it's the flow most likely to be moving cards between decks.
- **The tradelist can do what the collection can.** It's the same cards, and it offered half the actions. It now has File away and Unfile too. Unfiling also works from the collection at last, so "take these thirty out of that binder" no longer has to start inside the binder.
- **The wishlist has "I bought these".** Select the cards you picked up, and they move into your collection with the edition and traits they were wished for, come off the wishlist, and are offered a home — all in one go.
- **Select works everywhere it should.** Goblin mode now has one: tapping Select lays the heap out as a list while you pick, and the pile comes back when you're done. Search results have one too, so you can tick a page of cards and put the lot on your wishlist.
- **Every "are you sure" is the app asking, not the browser.** Deleting entries, emptying the tradelist, removing cards from a deck, deleting a deck or a folder or a tag, discarding a scan: all of them used to be a browser dialog that couldn't be styled, couldn't be tapped safely, and said as little as possible. They're now proper sheets that say what will actually happen. Reversible things — marking for trade, filing, unfiling — still just happen and tell you afterwards.
- **Scanning into a trade keeps the condition you picked.** The scanner's condition picker sat there through the whole scan and every card still entered the offer as Near Mint.

## 0.115.0

- **The card sheet stops depending on where you opened it.** The same sheet opens from twenty-odd places in the app, and it used to offer wildly different things depending on which one — a card you were only looking at couldn't flip through its printings, the screen called "Edit history" couldn't edit a price, and the pile view could only look at a card the list view let you edit. Now: every sheet lets you page through editions, in the dropdown and in the visual grid, because picking an edition is looking, not editing (the one exception is someone else's wish, where the printing is their answer, not yours). The History tab has its own "Fix prices" button wherever you open it, so a price you typed wrong is fixable from the card, not just from your collection. Long-pressing a card in goblin mode opens the same sheet a list row does. Searching from inside a deck, binder or box still offers your own collection and wishlist. And a card you own can be filed into a deck, binder or box straight from its sheet, with the same "it's already somewhere else" question the bulk filing asks.
- **"Add to collection" asks instead of guessing.** Adding a card from a sheet that isn't about your lists used to file one Near Mint, nonfoil, English copy without a word. It now opens the real add form — condition, finish, language, quantity, and the printing you were looking at — with a Back button that returns you to the card. The trade board's "you own 2 of this printing" notes are now readable too, instead of being printed into a dropdown that couldn't be opened.
- **The sheet fits on the screen.** The card art, its name, price and where your copies are filed now sit together at the top, the tabs and the buttons hold still, and only the middle moves. Rules text and history scroll inside their own boxes rather than pushing the buttons off the bottom, and the art shrinks on short screens instead of crowding out the form. A copy you own reads as one line ("NM · Nonfoil · EN · ×1") until you press Edit, instead of five greyed-out fields.
- **Fixed:** picking a card out of the collection value chart offered to add another copy of it instead of showing you the one you own.

## 0.114.3

- **Goblin mode stops bringing your phone to its knees.** The pile used to build every card in your collection at once, each one asking for full-size art, a blurred drop shadow and a graphics layer of its own. On Android that left thousands of cards fighting over memory and scrolling turned to treacle, while the same heap ran fine in Firefox. The pile now builds only the cards near what you are looking at and adds more as you scroll, using art sized for the small cards it actually draws, a cheaper shadow, and a back face only on the cards that have been turned over. The heap keeps its size and its shape, so your scroll position still means what it did, and cards you shove stay shoved and cards you flip stay flipped even after you scroll well past them and come back.

## 0.114.2

- **A sheet that opens under your thumb no longer answers for you.** Filing a scanned pile into a binder or box asks "already filed somewhere else?" when some of those cards are registered in another list, and that question put its Cancel button exactly where the "Add N cards to ..." button you had just pressed was. Press that button twice, the way anyone does when a press doesn't seem to register, and the second tap cancelled the whole scan without a word: nothing added, nothing said, and it happened again every time you tried. Sheets now ignore taps for a moment after they open, so a button that appears under your finger can't be worked by a tap aimed at something else. Backing out of that filing question now says nothing was added, and a scan that genuinely fails to save says so too, instead of leaving you pressing a button that looks dead.

## 0.114.1

- **The same chart, for the whole collection.** Tap "Total value" at the top of the Collection page and you get your pile's worth drawn out day by day. A card only counts from the day you actually got it, so a card you wished for all spring doesn't retroactively pad last month's total, and the line steps up when you buy and down when you sell. The second tab, "Since acquisition", drops the market noise and shows only what your cards have gained or lost since you got them, measured against what you paid — buying costs nothing on that line, so what's left is whether the cards you keep are earning their place. Pick any day on either chart and the list underneath fills with what came in and out that day; green and red dots mark the days worth picking. Printings you sell now keep their recorded price days instead of being forgotten, so the chart stops losing its own past.

## 0.114.0

- **Tap the price line for the whole story.** The little sparkline on a card is now a button. It opens a full chart of that printing's recorded price, with money on one axis and dates on the other, and your own history drawn onto it: a green dot where you picked copies up, a red one where you sold or traded them away, and a small tick under the plot for the quieter stuff (filed into a deck, wished for, marked for trade). A dashed line shows what you paid per copy, so you can see at a glance whether the card is above or below your buy-in. Drag across the chart (or use the arrow keys) to read any day's price, and tap a dot to open that event. Anything that happened before price tracking began is counted under the chart rather than pretending to sit on it.

## 0.113.1

- **Match notifications stop crying wolf.** If you wish for one particular printing of a card, the server was still counting every other printing of it as a match, so a notification could tell you someone wanted a card they'd never asked for. Notifications now use the same printing rule the Community page has always shown, so the two finally agree.
- **The same marks wherever you came from.** A user's trade and want lists used to swap their match symbols depending on whether you arrived from the bell or from the Community list, and a notification lit up matching cards in *both* their lists rather than the one the match was actually in. The marks are now the wishlist star, the trade arrows and the owned checkmark everywhere, and only the card the notification named is emphasized.

## 0.113.0

- **Tag the cards in a deck.** Give any card in a deck, binder or box your own labels: "Ramp", "Removal", "Turn-3 play", whatever you brew by. Open a card and add tags in its sheet, or hit "Select", pick a pile of cards and use "Tag…" to label them all at once — that sheet also renames or deletes a tag everywhere it's used. A new "Group: Tag" option in the sort row then breaks the list into one heading per tag, with everything else under "Untagged". A card can wear several tags, and it shows up under each of them (so those headings can add up to more than the deck — the board says as much when they do). Tags belong to the list they're written in and sync to your other devices along with it.

## 0.112.0

- **Trades now start on today's prices.** Both sides of a trade price the cards from their own device, so an app that had been open for a week could quietly value the deal differently from the person across the table. Opening a trade now pulls the day's prices first (just the prices, not the whole card database). If a card still can't be priced on your device, the trade bar says so and warns that your partner's total may not match, rather than silently counting that card as zero.

## 0.111.0

- **`or` and parentheses in search.** Search terms still AND together by default, but you can now write `t:goblin or t:elf` to get either, group with parentheses (`(t:goblin or t:elf) mv<=2`), and negate a whole group with a minus (`-(t:goblin or t:elf)`). `and` can be spelled out too, and AND binds tighter than OR, just like on Scryfall: `t:goblin or t:elf mv<=2` reads as "goblins, or elves that cost 2 or less". Works everywhere search does, including the filters on your collection, decks and wishlist. To search for the literal word "or", quote it: `"or"`.

## 0.110.1

- **Deck folder fixes.** The Decks screen's create fields are gone — tap "Add deck" or "Add folder" instead, and the name field is ready to type into as soon as you land. Each deck now has its own `⋯` menu (move to a folder, create one on the spot, or delete the deck) instead of a dropdown that used to bump you into the deck by mistake. A folder's own `⋯` menu no longer gets clipped when the folder list is short. On phones, folders now sit above the deck list at full width instead of squeezing it into a strip.

## 0.110.0

- **Sort and filter your decks.** The Decks screen now has a filter row: search by name, narrow to a format or a color, and sort by name, format, colors or owned value (with an ascending/descending toggle). Once you've made folders, an "All decks" checkbox flattens the list back to everything at once, ignoring which folder each deck is in.

## 0.109.0

- **Deck folders.** Group your decks into folders from the Decks screen. A folder column shows up on the right once you've created one; tap a folder to open it (decks inside swap in for the unorganized list), and "‹ Up a level" takes you back out. Rename or delete folders from their `⋯` menu — deleting a folder just unfiles its decks, it doesn't delete them. Move a deck between folders with the picker on its row. Folders sync across your devices like everything else.

## 0.108.0

- **`is:` search keywords.** Search now understands a big batch of `is:` filters: card structure (`is:transform`, `is:mdfc`, `is:split`, `is:saga`, `is:adventure`, `is:meld`, ...), classification (`is:permanent`, `is:vanilla`, `is:party`, `is:outlaw`, `is:commander`, `is:companion`, `is:partner`, ...), mana symbols (`is:hybrid`, `is:phyrexian`), the Reserved List and Commander Game Changers (`is:reserved`, `is:gamechanger`), printing availability (`is:foil`, `is:promo`, `is:reprint`, ...), and common land archetypes (`is:fetchland`, `is:shockland`, `is:painland`, `is:dual`, `is:triome`, ...). This is a one-time full re-download of the card database to pick up the new fields.

## 0.107.0

- **More Scryfall-style search syntax.** `set:znr` (or `s:`/`e:`) finds cards printed in a given set, `cmc:even`/`cmc:odd` filters by mana value parity, and `mana>={2}` (or `m:`) matches mana costs by symbol, with the same `>=`/`<=`/`=` comparisons colors already support.

## 0.106.0

- **Trade reconnects fixed.** Backgrounding the app mid-trade, or a spotty connection while rejoining, could leave a trade looking "no longer open," show "session full" for your own seat, or fail outright with "could not reach the trade server" — sometimes even when your partner was still there waiting. The app now reconnects the moment you bring it back to the foreground instead of waiting on a dead connection to time out, a rejoin that gets a lost reply no longer collides with your own seat, and a dropped connection retries with backoff instead of giving up (or hanging) immediately. Reconnect windows are also more consistent: they're no longer cut short near a trade's time limit, and if both sides step away at once, whoever left last still gets their full window back.

## 0.105.0

- **Trade screen scrolling fixed.** The value/Accept bar could end up floating over the Add/Scan buttons once a column filled up with cards. Now the title and menu stay put at the top, the value bar is docked at the bottom above the tab bar, and the two columns scroll their own card lists independently, so Add/Scan are always reachable.

## 0.104.0

- **A "This deck/binder/box" search scope.** Open a deck, binder or box and the search scope row now offers a pill for it, alongside Collection/Tradelist/Wishlist. Turn it on to search just that container's cards, and tap a result to edit its slot right there. Unlike the other three, it never turns itself on when you open search — you're often looking for cards to *add*, so it stays out of the way until you ask for it.

## 0.103.0

- **"In your collection" now opens a search instead of guessing a copy.** Tapping the badge on a card sheet takes you to Collection, scoped and searched for that exact card name, so you see every copy you own at once instead of being dropped onto one entry. This replaces the printing-navigation-arrows and copy-picker changes from 0.101.0/0.102.0, which didn't earn their keep in testing.

## 0.100.1

- **The "What's changed" popup actually shows up now.** 0.100.0 shipped the popup but got its own debut wrong: an install that predates the feature looked exactly like a fresh install to it, so it quietly noted "you're caught up" instead of showing what changed. It now tells the two apart properly and shows the full list to anyone updating for the first time since this landed.

## 0.100.0

- **A "What's changed" popup after an update.** Update the app and next launch shows what happened since the version you were on, in plain terms: added, changed, fixed, removed. Fresh installs don't get a backlog dumped on them; the popup only ever shows what you actually missed.

## 0.99.0

- **Scanning now files the exact card.** When you scan a card into a deck, binder or box, the app now treats it as you physically placing that specific copy there, not just adding a brewing slot. If the exact card (same printing, condition, finish and language) is already filed elsewhere, you get the same question you'd see filing it by hand: move it here or keep both copies filed? With no conflict, it files instantly, so unambiguous scans stay fast.

## 0.98.1

- **Trading away filed cards is now smarter.** When you trade away a copy that's filed in multiple places (a double-file conflict), the app now automatically removes it from filing if it can figure out which filed copy is gone. If the card was filed in two separate decks, you'll land on the conflict resolver to pick which one lost the copy.

## 0.98.0

- **Decks now have a Tokens section.** Add a card that makes tokens — The Necrobloom, say — and the deck view suggests the tokens it needs, spelled out the way you'd actually look for them ("0/1 Green Plant Creature Token", "2/2 Black Zombie Creature Token"). One tap files a suggestion into the deck's own Tokens board; you can also pick a token from your collection or search for one directly, same as any other card. Tokens carry the usual ownership checkmarks and collection badge, but never count toward your deck or sideboard size, and never trip a legality warning.

## 0.97.0

- **Assemble a deck from your collection.** New in a deck's ⋯ menu (and as "Fill from my collection" in a binder or box): it walks the list card by card and shows the copies you actually own, so you can point each slot at a real piece of cardboard instead of a vague "a Lightning Bolt". Only cards that still need one come up, so a list that's already sorted says so and doesn't waste your time. Pick a copy that lives in another deck and you get the usual "did you move it?" question, because that's exactly what building a deck out of another one is.
- **A copy that only covers part of a slot fills what it can.** Four Bolts wanted, two of that printing owned: it pins those two, leaves the other two as they were, and stays on the card so you can find a home for the rest.
- **"Your copies" says where each copy is.** The picker under Edition (and the assembler that reuses it) now shows a pill per copy: the deck, binder or box holding it, green when that's your actual card, or "On the shelf" when it's free. Foils shine there too, so you can tell your shiny one from the matte one without reading the fine print.

## 0.96.0

- **A tool for sorting out double-filed cards.** The amber ⚠ told you a card was in two places and then left you to it. There's now a walkthrough at More → Filing conflicts that deals with them one at a time: it shows the card, says "you own 1, but 2 are filed away", and offers the three things that can actually be true. It's in *this* deck (takes it out of the others), you own more copies than the app knew (adds them, with the acquisition logged), or it's gone — sold, traded, lost — which removes it from your collection and unfiles it everywhere. Skip anything you don't want to decide right now.
- **The bell tells you when there's filing to sort out.** It now shows up even when you're signed out, since this is about your own cards and nobody else's. Tapping the conflict row goes straight to the walkthrough, and the ⚠ pill in a card's sheet does the same.
- **"Filed: In too many places"** joins the collection's filed filter, so you can also browse the offenders normally, select them, and use the ordinary bulk actions.

## 0.95.0

- **Filing a card now asks whether you moved it.** Pull a Sol Ring out of your commander deck and put it in a box, and the app used to cheerfully list it in both — you'd notice weeks later via an amber warning. Filing a copy that's already filed somewhere else now stops and asks: move it here, or file it in both places? One question for the whole batch, however many cards you selected, and it names the cards in the way and where they currently live. Brewing is untouched: a decklist that hasn't picked editions claims no actual cardboard, so it never triggers the question.
- **Tick "always do this" and it stops asking.** The prompt's checkbox lands in Settings → Filing, where you can change your mind between asking each time, always moving, and always filing in both places.
- **Caveat for scanning:** cards scanned straight into a deck, binder or box still land as generic slots, so they don't claim a specific copy and don't raise the question. File from your collection (or a card's own sheet) when you want the app to track which physical card went where.

## 0.94.0

- **Your deck now shows which cards are *actually* in it.** A card can only be in one place at a time, but the app couldn't say which place. A double checkmark on a deck slot meant "you own this printing" — it never told you whether that copy was sitting in this deck or promised to another one. Slots holding one of your real cards now wear a filled green collection badge, one rung above the double check, and the "Filed in" pills in the card sheet fill in green for the deck, binder or box that's holding it. Only slots that name an actual copy of yours (printing, finish, condition and language, which is what filing from your collection writes) can earn it — a brewed decklist with no editions picked stays on the checkmarks, as it should.
- **The double-filed warning finally means something.** The amber ⚠ used to compare every copy listed anywhere against every copy you own in any printing, so a pasted decklist naming cards you were still shopping for could set it off, and a genuinely double-filed Spanish foil could hide behind copies of a different edition. It's now about one piece of cardboard: your NM English Sol Ring is filed in two decks, and you own one. If you just filed a card somewhere, that's the place that goes green — the deck it left is the one that starts complaining.

## 0.93.6

- **Foils sparkle inside decks, binders and boxes too.** A slot asking for a foil or etched copy looked exactly as matte as the nonfoil next to it, so the only way to tell your shiny Sol Ring from the beat-up one was to open it. The foil sheen now shows on those cards in both list and grid view, same as in your collection. Slots still on "any finish" stay matte, since they haven't picked a shiny card yet.

## 0.93.5

- **Only show the trade badge count when it is greater than 1.** The icon and outer badge wrapper still show up when quantityForTrade is 1 (or higher), maintaining the indicator while hiding the redundant number 1.

## 0.93.4

- **The "for trade" badge is a badge now, not an abbreviation.** Cards you've marked for trade used to wear a cryptic "2 FT" tag in the collection. It's now the tradelist symbol with the number of copies beside it, matching the deck/binder/box badge sitting right next to it, in filled purple so the two don't blur together.

## 0.93.3

- **Binders and boxes show their actual colors now.** A 300-card box that's mostly green with a handful of blue splashers used to light up all five color pips — when you sorted by color, even tiny "off-color" piles lit up WUBRG and a whole shelf looked identical. Binders and boxes now show the colors that make up at least 10% of the colored cards in there (weighted by copies), keeping your sort honest. Decks still get the full color-identity union, since illegal manabases are a feature, not a bug.

## 0.93.2

- **Mono-colored flip cards aren't multicolor anymore.** Sort a box by color and Hound Tamer, Nissa, Vastwood Seer and every other double-faced card landed in Multicolor, however green both sides were. A card that doesn't have one mana cost has one per face, so the app adds the faces' colors together — and "green plus green" was being counted as two colors. Werewolves go back to the Green pile, and `c:m` in search stops claiming them too. Genuinely two-colored flip cards are unaffected.

## 0.93.1

- **Filing from your collection files the actual cards.** "File away" from the collection multi-select used to drop a generic line into the box: right card, but printing aside, everything set to "Any" condition, finish and language, and only one copy no matter how many you own. Now the slot is a carbon copy of the entry you picked — all its copies, that printing, that finish, that condition, that language. Two editions of the same card stay two separate lines instead of collapsing into one, so your foil Japanese Forests and your beat-up English ones sit in the box as the different piles of cardboard they are. Same for "File these somewhere else too" from inside a deck, binder or box.

## 0.93.0

- **Find the cards you haven't filed anywhere.** Collection and tradelist get a "Filed" dropdown next to the sort control: leave it on *Any*, or narrow to *Nowhere* (nothing in a deck, binder or box) or *Somewhere*. It reads the same placement the little deck/binder/box badge shows, right down to finish and language, so what you filter for is what the badges say. Pair it with Select → Select all and every loose card is picked in two taps, ready to file away in one go. The dropdown turns purple while it's hiding rows, and resets when you leave the screen.

## 0.92.1

- **No more "download the card database" out of nowhere.** If a card-data update was cut short — you tapped "Update now" for a new app version, the phone put the app to sleep, the connection dropped — the app decided its database was broken and marched you back through first-run setup for the full ~17 MB. The database was fine the whole time; only its row tally was a few chunks behind. The tally no longer has a vote, and it quietly corrects itself.
- **An interrupted download picks up where it stopped.** Even when setup does have to run, it now only asks for the pieces that never arrived — a few hundred KB instead of starting the whole thing over. If everything already landed and only the final bookkeeping was missing, it just finishes silently.
- **Nightly builds ship less.** Two whole-database files were still being republished every night for app versions from long before the download-only-what-changed work, and superseded pieces were never cleaned up. Both are gone, which trims the daily update for everyone.

## 0.92.0

- **A solo trade waits for you now.** Leaving the trade screen mid-deal used to sweep both piles off the table. A solo trade is saved as you build it, and the trade screen offers to pick it back up ("You have an unfinished solo trade (7 cards)"). It's only let go when you complete it, cancel it, or discard it from that prompt.
- **Scanning into a trade survives an interruption too.** Scans into "You give" or "You get" are now saved like every other scan, per trade and per column, so a call coming in mid-binder doesn't cost you the pile. They're cleared once the trade is done or called off.
- **A deck re-scan and a deck scan no longer share a saved pile.** They do very different things — one appends, one reconciles the deck to exactly what you scanned — so an interrupted scan now only ever comes back to the one it was started for.

## 0.91.0

- **Tap the card art in a card sheet to blow it up.** The card fills the screen, nothing else on top of it, so you can actually read the rules text without squinting at a thumbnail. Tap anywhere (or press Escape, or use back) to drop it again. Double-faced cards keep their flip button, and foils keep their shimmer.

## 0.90.0

- **Auto-add gets out of the way when you add the card yourself.** With "Auto-add pinpointed edition" on, tapping +1 while the reader is still working out the printing no longer gets you a second copy a moment later: your tap wins and auto-add stands down for that card.
- **The scanner now says what auto-add is up to.** The little pill under the camera reads "Pinpointing edition…" while it works, "Auto-added this edition" when it lands one, "Edition unclear: tap to add" when it can't tell them apart, and "Auto-add stopped: you added this one" when you got there first. No more wondering whether something is still ticking away in the background.

## 0.89.0

- **Pick which camera the scanner uses.** Phones with several rear lenses (Pixel, recent Galaxy) decide for themselves which one to point at your card, and keep changing their mind mid-pile — usually to the ultrawide, which can't focus close enough to read a collector number. The scan settings cog now has a **Camera** picker: choose the lens that works and the scanner stays on it, this pile and every one after.
- Switching lenses mid-scan doesn't cost you anything: the session, the tray and your pile pins all stay put. Set it to **Automatic** to hand the choice back to the phone.
- The picker only appears when your device actually has more than one camera to pick from.

## 0.88.3

- **Prices are written the way the currency is actually written.** Pick kroner and you get "1 234,56 kr" — space between the thousands, comma before the øre — even if your browser is set to English. Before, an English browser forced English punctuation onto every currency ("kr 1,234.56").
- **Yen and won lose their decimals**, since neither has a subunit: ￥1 235, not ￥1 234,56.
- **Editing an acquisition price now happens in your currency.** The field is labelled with your currency's symbol, shows the converted amount, and takes a comma or a dot as the decimal mark. What gets stored is unchanged (euros), so switching currency later still never rewrites your history.
- The exchange rate on the settings screen follows the same rule: "1 EUR = 11,5 NOK".

## 0.88.2

- **"Filed in" tells your two copies apart.** Own a Mox Diamond in English and one in Spanish, put each in a different deck, and each copy's badge now names its own deck — instead of both claiming to be in both. The same goes for foil vs nonfoil, and for condition: whatever the deck slot says it wants of the copy filling it, only the copies that could fill it get the badge.
- A slot that names no edition and no preferences (a pasted decklist) still counts for every copy you own, as before. **Unfile…** follows the same rule, so what the badge showed is what comes off.

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
