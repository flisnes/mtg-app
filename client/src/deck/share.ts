import type { DeckFormat } from '@mtg/shared';
import { formatLabel } from './legality.js';

// Sharing a favorited deck. The shareable page is the existing read-only
// deck view (/profile/:username/deck/:deckId), so a "link" is just that
// route — no server work. Anyone SIGNED IN can open it; the deck must be
// favorited by its owner (that's what makes the server serve it).

/** Build the deep link to a favorited deck. HashRouter keeps the route in the
 *  URL fragment, so preserve origin+pathname and append the hash ourselves. */
export function deckShareUrl(username: string, deckId: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/profile/${encodeURIComponent(username)}/deck/${encodeURIComponent(deckId)}`;
}

export type ShareResult = 'shared' | 'copied' | 'failed';

/** Native share sheet where available (mobile PWA), clipboard copy elsewhere.
 *  A dismissed native sheet counts as 'shared' — nothing broke, so no toast. */
export async function shareDeckLink(deck: {
  username: string;
  deckId: string;
  name: string;
  format?: string;
}): Promise<ShareResult> {
  const url = deckShareUrl(deck.username, deck.deckId);
  if (navigator.share) {
    try {
      await navigator.share({
        title: deck.name,
        text: `${deck.name} — ${formatLabel((deck.format ?? 'casual') as DeckFormat)} deck`,
        url,
      });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared'; // user backed out
      // any other failure (permission, unsupported payload): fall back to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'failed';
  }
}
