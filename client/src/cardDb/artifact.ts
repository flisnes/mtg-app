import type { CardDbArtifactMeta } from '@mtg/shared';
import { sha256Hex } from '../util/sha256.js';
import { CARD_DB_BASE } from './config.js';

// The card DB's side artifacts (set types, oracle tags, Cardmarket ids, the
// sealed catalog and its prices) all ship the same way: a gzipped JSON file
// next to the manifest, named by content hash, with the hash of the
// uncompressed text in the manifest entry. This is the one download for all
// of them: fetch, gunzip on the platform, check the hash, hand back the text.

/** The artifact's decompressed text, verified against the manifest's hash. */
export async function fetchArtifactText(meta: CardDbArtifactMeta, what: string): Promise<string> {
  const res = await fetch(new URL(meta.url, CARD_DB_BASE!).href, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`${what} download HTTP ${res.status}`);
  // Cast around a DOM-lib variance quirk (see import.worker.ts): the
  // transform's writable is typed for BufferSource, not Uint8Array.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const text = await new Response(res.body.pipeThrough(gunzip)).text();
  if ((await sha256Hex(text)) !== meta.sha256) throw new Error(`${what} checksum mismatch: download corrupt`);
  return text;
}
