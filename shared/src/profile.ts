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

/** A denormalized deck summary — decks themselves stay private, only this brag line is shared. */
export interface FavoriteDeck {
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
      favoriteDecks.push({
        name,
        format: cleanStr(d.format, 20) ?? 'casual',
        colors,
        cards: Math.floor(clamp(d.cards, 0, 100_000) ?? 0),
      });
    }
  }

  return { avatar: sanitizeAvatar(r.avatar), favoriteCards, favoriteDecks };
}
