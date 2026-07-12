# Changelog

Testers: the app shows an "Update now" banner when a new version is published.

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
