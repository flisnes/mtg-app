// Public user profiles (the Community's face card): a profile picture cropped
// from a card's art plus up to three favorite cards and decks. Stored server-
// side as one JSON blob per user and visible to every signed-in user, so —
// like the published trade/wishlists — everything here is self-contained
// (names, colors, counts travel with the profile) and viewers resolve images
// from their own local card DB by id.

import type { Color } from './card.js';

export const MAX_FAVORITES = 3;
/** Serialized-profile cap; a full profile is well under 2 KB. */
export const MAX_PROFILE_JSON_CHARS = 20_000;

/**
 * Profile picture: a printing's cropped artwork plus a pan/zoom into it.
 * (x, y) is the crop center in normalized art coordinates (0..1 of the art's
 * width/height); zoom ≥ 1 scales the visible circle, whose diameter covers
 * min(artWidth, artHeight) / zoom source pixels. Storing the recipe instead of
 * pixels keeps profiles tiny and lets every client render at any size.
 */
export interface ProfileAvatar {
  scryfallId: string;
  x: number;
  y: number;
  zoom: number;
}

export const AVATAR_MAX_ZOOM = 8;

/** Self-contained like TradeLine: the name renders even if the viewer's card DB misses the printing. */
export interface FavoriteCard {
  oracleId: string;
  scryfallId: string;
  name: string;
}

/**
 * A denormalized deck summary. When `deckId` is present the deck is browsable:
 * the server reads the owner's synced deck rows live (GET /api/users/:u/decks/:id)
 * and refreshes name/format/count on profile reads, so renames never go stale.
 * Favorites saved before deckId existed keep showing their snapshot only.
 */
export interface FavoriteDeck {
  /** The owner's synced deck row id; absent on pre-v0.38 favorites (summary only). */
  deckId?: string;
  name: string;
  /** DeckFormat as a plain string ('casual' | a Format). */
  format: string;
  /** Color identity, WUBRG order; empty = colorless. */
  colors: Color[];
  /** Mainboard card count. */
  cards: number;
}

export interface UserProfile {
  avatar: ProfileAvatar | null;
  favoriteCards: FavoriteCard[];
  favoriteDecks: FavoriteDeck[];
}

export const EMPTY_PROFILE: UserProfile = { avatar: null, favoriteCards: [], favoriteDecks: [] };

export interface ProfileResponse {
  username: string;
  /** 0 = the user has never saved a profile. */
  updatedAt: number;
  profile: UserProfile;
}

export interface ProfilePutRequest {
  profile: UserProfile;
}

export interface ProfilePutResponse {
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Sanitization — shared by the server (on upload) and clients (on display,
// same trust model as trade shares: another user's profile is untrusted input).
// ---------------------------------------------------------------------------

const COLOR_ORDER: readonly Color[] = ['W', 'U', 'B', 'R', 'G'];

function cleanStr(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

function clamp(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

export function sanitizeAvatar(v: unknown): ProfileAvatar | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const scryfallId = cleanStr(r.scryfallId, 64);
  const x = clamp(r.x, 0, 1);
  const y = clamp(r.y, 0, 1);
  const zoom = clamp(r.zoom, 1, AVATAR_MAX_ZOOM);
  if (!scryfallId || x === null || y === null || zoom === null) return null;
  return { scryfallId, x, y, zoom };
}

export function sanitizeProfile(v: unknown): UserProfile {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;

  const favoriteCards: FavoriteCard[] = [];
  if (Array.isArray(r.favoriteCards)) {
    for (const raw of r.favoriteCards.slice(0, MAX_FAVORITES)) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const oracleId = cleanStr(c.oracleId, 64);
      const scryfallId = cleanStr(c.scryfallId, 64);
      if (!oracleId || !scryfallId) continue;
      favoriteCards.push({ oracleId, scryfallId, name: cleanStr(c.name, 200) ?? '(unknown card)' });
    }
  }

  const favoriteDecks: FavoriteDeck[] = [];
  if (Array.isArray(r.favoriteDecks)) {
    for (const raw of r.favoriteDecks.slice(0, MAX_FAVORITES)) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      const name = cleanStr(d.name, 80);
      if (!name) continue;
      const colors = Array.isArray(d.colors)
        ? COLOR_ORDER.filter((c) => (d.colors as unknown[]).includes(c))
        : [];
      const deckId = cleanStr(d.deckId, 64);
      favoriteDecks.push({
        ...(deckId ? { deckId } : {}),
        name,
        format: cleanStr(d.format, 20) ?? 'casual',
        colors,
        cards: Math.floor(clamp(d.cards, 0, 100_000) ?? 0),
      });
    }
  }

  return { avatar: sanitizeAvatar(r.avatar), favoriteCards, favoriteDecks };
}

// ---------------------------------------------------------------------------
// Browsable favorite decks (GET /api/users/:username/decks/:deckId)
// ---------------------------------------------------------------------------
//
// Favoriting a deck makes its list public: the server reads the owner's synced
// deck/deckCards rows on demand (the one deliberate exception to "sync rows are
// opaque"), so viewers always see the current list — nothing extra to publish
// and nothing to go stale. Lines carry no names; viewers resolve cards from
// their own local card DB by id, like every other shared list.

/** Per-deck line cap (a Commander deck is ~100; this is just a sanity bound). */
export const MAX_DECK_LINES = 1_000;

const DECK_BOARDS = new Set(['main', 'side', 'commander']);

export interface PublicDeckLine {
  oracleId: string;
  /** Preferred printing for display; absent = the card's default printing. */
  scryfallId?: string;
  quantity: number;
  /** DeckBoard as a plain string ('main' | 'side' | 'commander'). */
  board: string;
}

export interface UserDeckResponse {
  username: string;
  name: string;
  format: string;
  description?: string;
  /** When the deck row last changed. */
  updatedAt: number;
  lines: PublicDeckLine[];
}

/** Shared by the server (reading raw sync rows) and clients (untrusted input on display). */
export function sanitizeDeckLines(v: unknown): PublicDeckLine[] {
  if (!Array.isArray(v)) return [];
  const lines: PublicDeckLine[] = [];
  for (const raw of v.slice(0, MAX_DECK_LINES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const oracleId = cleanStr(r.oracleId, 64);
    const quantity = Math.floor(clamp(r.quantity, 0, 9_999) ?? 0);
    if (!oracleId || quantity < 1) continue;
    const scryfallId = cleanStr(r.scryfallId, 64);
    lines.push({
      oracleId,
      ...(scryfallId ? { scryfallId } : {}),
      quantity,
      board: DECK_BOARDS.has(r.board as string) ? (r.board as string) : 'main',
    });
  }
  return lines;
}
