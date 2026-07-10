# Changelog

Testers: the app shows an "Update now" banner when a new version is published.

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
