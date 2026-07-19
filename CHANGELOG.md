# Changelog

Testers: the app shows an "Update now" banner when a new version is published.

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
