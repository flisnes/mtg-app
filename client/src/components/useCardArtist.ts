import { useEffect, useState } from 'react';

// The profile art credit needs the card artist's name, but the slimmed card DB
// drops Scryfall's `artist` field (it'd bloat every printing row for a single
// string). The profile page is already online-only — it fetches the profile
// from the server — so we look the artist up live from Scryfall by the avatar's
// printing id. Cached per session so revisiting a profile costs no extra fetch.

const cache = new Map<string, string | null>();

/** Artist who illustrated the given printing, or null while loading / unknown. */
export function useCardArtist(scryfallId: string | null | undefined): string | null {
  const [artist, setArtist] = useState<string | null>(() =>
    scryfallId ? cache.get(scryfallId) ?? null : null,
  );

  useEffect(() => {
    if (!scryfallId) {
      setArtist(null);
      return;
    }
    if (cache.has(scryfallId)) {
      setArtist(cache.get(scryfallId) ?? null);
      return;
    }
    let cancelled = false;
    fetch(`https://api.scryfall.com/cards/${encodeURIComponent(scryfallId)}`, {
      headers: { Accept: 'application/json' },
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ artist?: string }>) : null))
      .then((card) => {
        const name = card?.artist?.trim() || null;
        cache.set(scryfallId, name); // a hit or a stable 404 both cache
        if (!cancelled) setArtist(name);
      })
      .catch(() => {
        // Transient (offline) failure: leave uncached so a revisit retries.
        if (!cancelled) setArtist(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scryfallId]);

  return artist;
}
