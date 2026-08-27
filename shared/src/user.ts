// User data types. Stored locally in IndexedDB (Dexie). Never leaves the device
// except as the opaque TradeLine[] exchanged during a trade session.
//
// Invariants (enforced in the data-access layer, not the UI — beta plan §4):
//  - The tradelist is NOT a separate table: it is `quantityForTrade > 0` on a
//    CollectionEntry, with `quantityForTrade <= quantity`.
//  - Collection entries are unique on (scryfallId, condition, finish, lang);
//    adding a duplicate increments quantity.
//  - "Owned" (for deck checkmarks) = sum of quantity over all CollectionEntry
//    with a matching oracleId (any printing counts). A deck slot that pins an
//    edition/finish/condition/language only counts as *had* when some owned copy
//    meets those (the double check); otherwise it's the single check.

import type { Finish, Format } from './card.js';
import { sanitizeAvatar, type ProfileAvatar } from './profile.js';

export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export const CONDITIONS: readonly Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const FINISHES: readonly Finish[] = ['nonfoil', 'foil', 'etched'];

export interface CollectionEntry {
  id: string;
  oracleId: string;
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
  quantity: number;
  /** 0..quantity — this IS the tradelist. */
  quantityForTrade: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * An unopened sealed product you own: a booster box still in shrink, a precon
 * nobody has cracked, a bundle on the shelf. Deliberately NOT a CollectionEntry
 * — it has no oracleId or scryfallId, and every card join, sort, price history
 * and mover flag in the app assumes those exist. It lives in its own table and
 * its own view, and contributes to collection value as a separate line.
 *
 * The display fields are denormalized on purpose: the sealed catalog is a
 * lazily-fetched artifact that may be absent, stale, or drop a product between
 * builds, and "you own a box" should survive all three.
 */
export interface SealedItem {
  id: string;
  /** MTGJSON product uuid — joins to SealedProduct when the catalog is loaded. */
  productId: string;
  name: string;
  /** Lowercased set code, for the subtitle when the catalog isn't loaded. */
  set: string;
  setName?: string;
  /** TCGplayer product id: the box shot and the USD price key. */
  tcgplayerId?: string;
  quantity: number;
  createdAt: number;
  updatedAt: number;
}

export interface WishlistEntry {
  id: string;
  oracleId: string;
  /** null = "any printing". */
  scryfallId: string | null;
  /** Desired condition; undefined = "any". */
  condition?: Condition;
  /** Desired finish; undefined = "any". */
  finish?: Finish;
  /** Desired language; undefined = "any". */
  lang?: string;
  quantity: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 'commander' is the command zone: counts toward Commander's 100, sets the
 * color identity. 'token' holds the tokens a deck needs to play — never
 * counted toward deck/sideboard size or checked for format legality (see
 * deck/legality.ts), and never a wishlist candidate.
 */
export type DeckBoard = 'main' | 'side' | 'commander' | 'token';

/**
 * What a `Deck` row actually is. Decks are lists you brew (format, legality,
 * boards); binders and boxes are storage — the same slots, no format, one board,
 * used to mirror where the cards physically live. All three share the
 * decks/deckCards tables (and therefore sync, scanning, import and the event
 * log); the kind only changes what the UI offers. Absent = 'deck' (every row
 * written before storage existed).
 */
export type ContainerKind = 'deck' | 'binder' | 'box';

export const CONTAINER_KINDS: readonly ContainerKind[] = ['deck', 'binder', 'box'];

/**
 * What a deck, binder or box wears in the list instead of its generic kind
 * icon: a crop of a card's art (the same recipe a profile picture uses, see
 * ProfileAvatar), a symbol from the Mana font (a mana pip, the tap symbol, a
 * guild sigil), or a set symbol from Keyrune. Absent = the kind's icon.
 *
 * Stored as ids and a crop recipe, never pixels — the art variant resolves the
 * printing out of whichever device is looking, exactly like an avatar, so an
 * emblem costs a hundred-odd bytes in the synced row.
 */
export type ContainerEmblem =
  | { type: 'art'; art: ProfileAvatar }
  | { type: 'symbol'; symbol: string; color?: EmblemColor }
  | { type: 'set'; set: string; color?: EmblemColor };

/**
 * Optional tint for a symbol or set emblem; absent = the list's own text
 * colour. A fixed palette rather than a free hex value: the swatches have to
 * read on both themes, and the stored name goes straight into a style.
 */
export const EMBLEM_COLORS = [
  'gold',
  'red',
  'orange',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'plum',
  'slate',
] as const;

export type EmblemColor = (typeof EMBLEM_COLORS)[number];

const EMBLEM_COLOR_SET: ReadonlySet<string> = new Set(EMBLEM_COLORS);

// Both string variants end up in a CSS class name ("ms-guild-azorius",
// "ss-sth"), so the charsets are fenced in hard rather than trusted: a row can
// arrive from the server, a transfer file or an older build.
const EMBLEM_SYMBOL_RE = /^[a-z0-9-]{1,40}$/;
const EMBLEM_SET_RE = /^[a-z0-9]{1,10}$/;

/** Clean an emblem into the shape that gets stored; anything odd → undefined (no emblem). */
export function sanitizeContainerEmblem(raw: unknown): ContainerEmblem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type === 'art') {
    const art = sanitizeAvatar(r.art);
    return art ? { type: 'art', art } : undefined;
  }
  const color = EMBLEM_COLOR_SET.has(r.color as string) ? { color: r.color as EmblemColor } : {};
  if (r.type === 'symbol' && typeof r.symbol === 'string') {
    const symbol = r.symbol.toLowerCase();
    return EMBLEM_SYMBOL_RE.test(symbol) ? { type: 'symbol', symbol, ...color } : undefined;
  }
  if (r.type === 'set' && typeof r.set === 'string') {
    const set = r.set.toLowerCase();
    return EMBLEM_SET_RE.test(set) ? { type: 'set', set, ...color } : undefined;
  }
  return undefined;
}

/** A deck's format; 'casual' means no legality checks. */
export type DeckFormat = Format | 'casual';

export const DECK_FORMATS: readonly DeckFormat[] = [
  'casual',
  'standard',
  'pioneer',
  'modern',
  'legacy',
  'vintage',
  'pauper',
  'commander',
];

export interface Deck {
  id: string;
  name: string;
  /** Deck, binder or box. Missing on rows written before storage existed → 'deck'. */
  kind?: ContainerKind;
  /** Missing on decks created before formats existed → treat as 'casual'.
   *  Meaningless (and unset) on binders and boxes. */
  format?: DeckFormat;
  description?: string;
  /** Groups decks into a DeckFolder. Deck-only; unset = not in a folder. */
  folderId?: string;
  /** The picture or symbol this one wears in the list; unset = the kind icon. */
  emblem?: ContainerEmblem;
  createdAt: number;
  updatedAt: number;
}

/**
 * A folder that groups decks in the deck list. Deck-only (binders/boxes don't
 * use these) — a flat name, no nesting. Same shape/lifecycle as a Deck: LWW on
 * updatedAt, synced by its own table.
 */
export interface DeckFolder {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeckCard {
  id: string;
  deckId: string;
  oracleId: string;
  /** Preferred printing for display (image/price). Undefined = "any edition". */
  scryfallId?: string;
  quantity: number;
  board: DeckBoard;
  /**
   * What the slot wants of the copy filling it, in the same shape (and with the
   * same "undefined = any" rule) as a WishlistEntry: pick a copy out of your
   * collection and the slot remembers its finish, condition and language, so the
   * ownership check knows whether you really have *that* card. Condition is a
   * minimum, like a wish — see wishPrefsMet.
   */
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  /**
   * "Any printing" basic land — the ones you grab from the lands box, whatever
   * edition is on top. The slot is deliberately detached from the collection:
   * it never consumes owned copies, adds no money to the deck's worth, and
   * always counts as had (nobody wants to scan 24 Islands). Never carries a
   * scryfallId; display falls back to the card's default printing.
   */
  anyBasic?: boolean;
  /**
   * The slot still wants this copy, but the cardboard isn't in the container
   * right now — you pulled the card out of the deck and left the list alone.
   * Everything the slot names (printing, finish, condition, language) stays, it
   * simply stops *claiming* one of your copies: no green collection badge, no
   * filing conflict, and the copy is free for another deck. Filing it back
   * (assemble, a re-scan, or "File back here") clears the flag. Only ever set on
   * a slot that names one physical copy; an "any printing" basic never has one.
   */
  unfiled?: boolean;
  /**
   * User-defined labels for this slot — "Ramp", "Turn-3 play", "Wincon". They
   * live on the slot rather than in a table of their own, so a tag belongs to
   * the container it was written in, travels with it through sync, and cannot
   * leak into another list. The set of tags a deck has is simply the set its
   * slots carry (no orphans to garbage-collect). Always stored through
   * normalizeCardTags; absent = untagged.
   */
  tags?: string[];
  updatedAt: number;
}

/**
 * Longest a deck/binder/box name (deck folders share it). Enforced in three
 * places that used to disagree: the name input, the row sanitizer on receive,
 * and — via SYNC_MAX_ROW_BYTES.decks — the server. Nothing capped the write
 * path before, so a pasted wall of text synced in full and was only truncated
 * on the way back out.
 */
export const MAX_DECK_NAME_LENGTH = 200;
/** Longest a deck description. Set by import, not typed in the UI today. */
export const MAX_DECK_DESCRIPTION_LENGTH = 2_000;

/** Longest a card tag can be; anything longer is truncated, not rejected. */
export const MAX_CARD_TAG_LENGTH = 30;
/** Most tags one slot can carry — a guard rail, not a design target. */
export const MAX_CARD_TAGS = 12;

/** Case-insensitive tag order, used for storage and for group headings alike. */
export function compareCardTags(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

/**
 * Clean tags into the shape that gets stored: trimmed, inner whitespace
 * collapsed, truncated, deduped case-insensitively (first spelling wins),
 * sorted and capped. Sorting matters for sync — two devices that tagged the
 * same slot in a different order should end up with the same row rather than
 * fighting over it. Nothing left → undefined, so an untagged slot carries no
 * field at all.
 */
export function normalizeCardTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Map<string, string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const tag = v.replace(/\s+/g, ' ').trim().slice(0, MAX_CARD_TAG_LENGTH).trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }
  if (seen.size === 0) return undefined;
  return [...seen.values()].sort(compareCardTags).slice(0, MAX_CARD_TAGS);
}

/** Whether two normalized tag lists are the same (no write needed). */
export function sameCardTags(a: string[] | undefined, b: string[] | undefined): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  return (a ?? []).every((t, i) => t === b![i]);
}

/**
 * A completed local trade record. `partner` is the other side's account
 * username when both parties were signed in and shared identities during the
 * session; null = anonymous ("Other User").
 */
export interface Trade {
  id: string;
  completedAt: number;
  partner: string | null;
  given: TradeLine[];
  received: TradeLine[];
}

/** A single card line inside an offer. Self-contained (carries name) so history renders without the card DB. */
export interface TradeLine {
  oracleId: string;
  scryfallId: string;
  name: string;
  quantity: number;
  condition: Condition;
  finish: Finish;
  lang: string;
}

/**
 * A single wishlist line shared during a trade or published to the community
 * (for wishlist⇄tradelist match highlighting). Self-contained (carries name)
 * like TradeLine. The condition/finish/lang preferences are optional: undefined
 * means "any", and condition is a *minimum* (a card at least that good matches).
 */
export interface WishLine {
  oracleId: string;
  /** null = "any printing". */
  scryfallId: string | null;
  name: string;
  quantity: number;
  /** Minimum acceptable condition; undefined = any. */
  condition?: Condition;
  /** Desired finish; undefined = any. */
  finish?: Finish;
  /** Desired language; undefined = any. */
  lang?: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Event log: an append-mostly per-user history of what happened to the
// collection. Powers the card History tab ("owned since", value while owned,
// decks tried, wishlist journey). Events are emitted by the device where the
// change originates; sync copies them verbatim. Only the user-editable fields
// (priceEurCents, reason) ever change after emission — updatedAt is the
// last-write-wins comparator for those edits.
// ---------------------------------------------------------------------------

/**
 * Why copies left the collection. Removals default to 'sold'; user-editable.
 * 'corrected' is the bookkeeping one: the copies never went anywhere, the entry
 * describing them was wrong (finish, language, edition) and got fixed.
 */
export type RemovalReason = 'sold' | 'traded' | 'lost' | 'corrected' | 'other';

export const REMOVAL_REASONS: readonly RemovalReason[] = ['sold', 'traded', 'lost', 'corrected', 'other'];

export type UserEventKind =
  | 'collection.add'
  | 'collection.remove'
  | 'deck.add'
  | 'deck.remove'
  | 'wish.add'
  | 'wish.fulfilled'
  | 'wish.remove'
  /** Copies already owned were marked for trade (e.g. a tradelist scan). */
  | 'tradelist.mark';

export const USER_EVENT_KINDS: readonly UserEventKind[] = [
  'collection.add',
  'collection.remove',
  'deck.add',
  'deck.remove',
  'wish.add',
  'wish.fulfilled',
  'wish.remove',
  'tradelist.mark',
];

/**
 * How a change was made. Distinguishes an ordinary edit from a bulk import, a
 * sealed-product add, a trade, or a scan — the edit-history view uses it to
 * pick the row's icon and to group the lines of one operation into a single
 * entry. Absent on pre-feature events (they render as 'manual').
 */
export type EventSource = 'manual' | 'import' | 'sealed' | 'trade' | 'scan';

export const EVENT_SOURCES: readonly EventSource[] = ['manual', 'import', 'sealed', 'trade', 'scan'];

export interface UserEvent {
  id: string;
  /** When it happened (ms epoch). */
  ts: number;
  /** LWW comparator; equals ts until the user edits price/reason. */
  updatedAt: number;
  kind: UserEventKind;
  oracleId: string;
  /** Printing involved; null on "any printing" wish events. */
  scryfallId?: string | null;
  /** Copies involved (always positive; the kind carries the direction). */
  qty?: number;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  /**
   * Market price per copy in EUR cents at event time (collection.add =
   * acquisition price, collection.remove = exit price). null = unknown at the
   * time. User-editable afterwards.
   */
  priceEurCents?: number | null;
  /** collection.remove only. */
  reason?: RemovalReason;
  deckId?: string;
  /** Denormalized so history still renders after the deck is deleted. */
  deckName?: string;
  /** Set only when the container was a binder or box, so the history line picks
   *  the right glyph. Absent = a deck (every event written before storage). */
  deckKind?: ContainerKind;
  board?: DeckBoard;
  /** Trade session id for trade-driven changes (also the grouping key). */
  tradeId?: string;
  /**
   * collection.add only: this add didn't bring a card in, it backfills the
   * ledger for a card given away in a trade that was never registered as owned
   * (so the history reads "added, then traded away" instead of a dangling
   * removal). No collection row is written for it; it nets against the paired
   * removal. Rendered as a plain "Added to collection", not "Received in trade".
   */
  reconcile?: boolean;
  /** How the change was made; drives the edit-history icon + grouping. */
  source?: EventSource;
  /** Groups the events of one bulk operation (an import or sealed add). */
  batchId?: string;
  /** Human label for a batch (e.g. the sealed product's name). */
  batchLabel?: string;
}

/**
 * A run of daily price readings, whatever they're readings of. `eur[i]`/`usd[i]`
 * are integer cents for the day `startDay + i` (UTC); days with no reading (app
 * not opened, no price) are null, and the two arrays are the same length. The
 * pure helpers in price/history.ts work on this shape alone, so cards and sealed
 * products share them.
 */
export interface DayReadings {
  startDay: string; // YYYY-MM-DD (UTC) of index 0
  eur: (number | null)[]; // integer cents per day
  usd: (number | null)[]; // integer cents per day; same length as eur
}

/**
 * Compact price history for one collection printing (every printing in the
 * collection is tracked automatically): one row per card, not one per
 * card-day. A few bytes per card per day, so tracking a whole collection stays
 * ~20 MB/year instead of ~1 GB with row-per-day snapshot objects.
 */
export interface PriceHistory extends DayReadings {
  scryfallId: string;
}

/**
 * The same, for one unopened sealed product on the shelf. Keyed by the MTGJSON
 * product uuid (`SealedItem.productId`), because that's what the sealed price
 * map is keyed by — a box has no scryfallId to hang a history on.
 */
export interface SealedPriceHistory extends DayReadings {
  productId: string;
}
