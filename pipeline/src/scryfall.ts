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
  // Scryfall migrated bulk data to JSONL (2026-07): the old `download_uri`
  // (a JSON array) and `size` fields are gone, replaced by these.
  jsonl_download_uri: string;
  updated_at: string;
  compressed_size: number;
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

const SETS_INDEX = 'https://api.scryfall.com/sets';

/**
 * Every set's code → `set_type`, from the (single, paginated-but-small) sets
 * endpoint. Used to tell a normal release apart from a promo product, Secret
 * Lair, token sheet or memorabilia set, which the bulk card rows don't say.
 */
export async function getSetTypes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let url: string | undefined = SETS_INDEX;
  while (url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`sets index HTTP ${res.status}`);
    const json = (await res.json()) as {
      data: { code?: string; set_type?: string }[];
      has_more?: boolean;
      next_page?: string;
    };
    for (const s of json.data) {
      if (s.code && s.set_type) out[s.code] = s.set_type;
    }
    url = json.has_more ? json.next_page : undefined;
  }
  if (Object.keys(out).length === 0) throw new Error('sets index returned no usable sets');
  return out;
}

/**
 * Open the bulk file as a byte stream. The JSONL bulk files are served as
 * `application/gzip` with NO `Content-Encoding`, so fetch does NOT decompress
 * them — the caller must pipe this through a gunzip step.
 */
export async function openBulkStream(downloadUri: string): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(downloadUri, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(`bulk download HTTP ${res.status}`);
  return res.body;
}
