// Where the slimmed card-DB artifacts live. In production this is the VM's
// Caddy URL (HTTPS, CORS for the github.io origin). In dev/local testing set
// VITE_CARD_DB_URL to a static server serving pipeline/out. Trailing slash
// normalised so new URL(artifact.url, base) resolves correctly.
const raw = import.meta.env.VITE_CARD_DB_URL as string | undefined;

export const CARD_DB_BASE: string | null = raw ? raw.replace(/\/?$/, '/') : null;

// Scryfall bulk endpoint for the documented fallback (beta plan §3) when the
// VM is unreachable and there's no local DB yet.
export const SCRYFALL_BULK_INDEX = 'https://api.scryfall.com/bulk-data';
