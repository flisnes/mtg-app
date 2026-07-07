// Scryfall bulk-data access (beta plan §3). Scryfall asks clients to send a
// descriptive User-Agent and an Accept header, and to prefer bulk data over
// hammering the per-card API — which is exactly what we do.

const BULK_INDEX = 'https://api.scryfall.com/bulk-data';

const HEADERS = {
  'User-Agent': 'mtg-pwa-minimal/0.1 (collection & trading beta)',
  Accept: 'application/json',
};

export interface BulkEntry {
  type: string;
  download_uri: string;
  updated_at: string;
  size: number;
}

/** Look up a bulk-data entry by type (e.g. 'default_cards', 'oracle_cards'). */
export async function getBulkEntry(type: string): Promise<BulkEntry> {
  const res = await fetch(BULK_INDEX, { headers: HEADERS });
  if (!res.ok) throw new Error(`bulk-data index HTTP ${res.status}`);
  const json = (await res.json()) as { data: BulkEntry[] };
  const entry = json.data.find((d) => d.type === type);
  if (!entry) throw new Error(`no bulk-data entry of type '${type}'`);
  return entry;
}

/** Open the bulk file as a byte stream. fetch transparently gunzips the transfer. */
export async function openBulkStream(downloadUri: string): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(downloadUri, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(`bulk download HTTP ${res.status}`);
  return res.body;
}
