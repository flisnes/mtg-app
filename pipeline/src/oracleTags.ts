import { Readable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip, gzipSync, gunzipSync } from 'node:zlib';
import jsonlMod from 'stream-json/jsonl/Parser.js';
const { parser: jsonlParser } = jsonlMod;
import type { OracleTagDictionary, OracleTagEntry } from '@mtg/shared';
import { getBulkEntry, openBulkStream } from './scryfall.js';

// Scryfall Tagger oracle tags — what a card *does* (removal, ramp, tutor,
// combat trick, …), community-tagged and published as its own bulk file.
// Feeds the client's `otag:` search.
//
// Two things about this data drive the whole design:
//
//  1. It is a hierarchy, and a search means the whole subtree. `removal` is
//     tagged on exactly zero cards; all 6,690 hits come from its 55
//     descendants. So the dictionary must ship the parent edges, and the client
//     expands the closure at query time. Flattening it here instead would mean
//     writing every ancestor onto every card — the same cards over and over.
//
//  2. It churns. Tagger is community-edited continuously, and with 256
//     content-hashed chunks over random UUIDs even a few dozen retagged cards
//     scatter across ~45 of them. Left on the nightly build that would turn
//     "card data changes rarely" into a megabyte a day of re-downloads for
//     everyone. So tags refresh WEEKLY, from a cache in OUT_DIR (which CI keeps
//     between runs), and the other six nights reuse the cached copy verbatim so
//     the chunk hashes don't move.

/** Bump when the cache's shape changes, so old caches are refetched not misread. */
const CACHE_FORMAT = 1;
const CACHE_FILE = 'oracle-tags.cache.gz';
const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * Tag families that describe the card as a *design artifact* rather than as
 * something you cast: how its name scans, whether its type line is unique,
 * whether the rules manager was being funny in a ruling. Excluded with their
 * descendants — they'd be 10k taggings of pure noise in autocomplete, and
 * `alliteration` alone matches 4,418 cards.
 *
 * Deliberately narrow. The obvious next candidate, the 1,339-tag `cycle`
 * subtree, is NOT here: those tags look like trivia ("the Ravnica shocklands")
 * but they're how the land cards actually hang off `dual-land`, `tapland` and
 * `fetchland`, so excluding them takes `otag:dual-land` from 443 cards to 5.
 * `type-errata` is out for the same reason (it carries `deprecated-card-types`).
 * The saving would have been ~25 KB either way — this list is about result
 * quality, not bytes.
 */
export const EXCLUDED_TAG_ROOTS = [
  'alliteration',
  'namesake-spell',
  'unique-type-line',
  'unique-token',
  'unique-token-type',
  'fun-ruling',
  'potentially-black-border',
  'art-matters',
  'artist-matters',
  'flavor-matters',
  'flavor-text-matters',
  'rules-text-matters',
  'reminder-text-matters',
  'un-set-mechanics',
  'un-design',
];

/** The fields we read off a bulk tag row; Scryfall sends a good deal more. */
interface RawTag {
  id: string;
  slug?: string;
  label?: string;
  type?: string;
  parent_ids?: string[];
  child_ids?: string[];
  aliases?: string[];
  taggings?: Array<{ oracle_id?: string; weight?: string }>;
}

export interface OracleTagsBuild {
  dictionary: OracleTagDictionary;
  /** Oracle id → sorted dictionary indices. Only cards that carry a tag appear. */
  byOracleId: Map<string, number[]>;
  stats: { source: 'network' | 'cache'; fetchedAt: string; tags: number; excluded: number; cards: number; taggings: number };
}

interface CacheFile {
  v: number;
  excludeKey: string;
  fetchedAt: string;
  dictionary: OracleTagDictionary;
  byOracleId: Record<string, number[]>;
}

/** Slugs are `[a-z0-9-]`, but a couple hundred aliases are written with spaces. */
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Identifies the exclusion list, so editing it invalidates the cache. */
function excludeKey(): string {
  return createHash('sha256').update([...EXCLUDED_TAG_ROOTS].sort().join(',')).digest('hex').slice(0, 12);
}

async function downloadTags(): Promise<RawTag[]> {
  const entry = await getBulkEntry('oracle_tags');
  const webStream = await openBulkStream(entry.jsonl_download_uri);
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  const gunzip = createGunzip();
  const pipeline = nodeStream.pipe(gunzip).pipe(jsonlParser());
  const out: RawTag[] = [];
  await new Promise<void>((resolve, reject) => {
    pipeline.on('data', ({ value }: { value: RawTag }) => {
      // The file is oracle tags only, but the `type` field is there and cheap
      // to honour — an art tag would key off illustration_id, not oracle_id.
      if (value?.id && (value.type ?? 'oracle') === 'oracle') out.push(value);
    });
    pipeline.on('end', () => resolve());
    pipeline.on('error', reject);
    gunzip.on('error', reject);
    nodeStream.on('error', reject);
  });
  return out;
}

/** Every tag in an excluded root's subtree (the root included). */
function excludedIds(raw: RawTag[]): Set<string> {
  const byId = new Map(raw.map((t) => [t.id, t]));
  const bySlug = new Map(raw.map((t) => [t.slug ?? slugify(t.label ?? ''), t]));
  const out = new Set<string>();
  const stack = EXCLUDED_TAG_ROOTS.map((s) => bySlug.get(s)?.id).filter((id): id is string => !!id);
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of byId.get(id)?.child_ids ?? []) if (byId.has(child)) stack.push(child);
  }
  return out;
}

function compile(raw: RawTag[]): Omit<OracleTagsBuild, 'stats'> & { excluded: number } {
  const excluded = excludedIds(raw);
  // Sorted by slug so the dictionary indices — and therefore every card's
  // `tags` array, and therefore every oracle chunk hash — depend only on the
  // tag set, not on the order Scryfall happened to stream it in.
  const kept = raw
    .filter((t) => !excluded.has(t.id) && (t.slug ?? t.label))
    .sort((a, b) => ((a.slug ?? a.label!) < (b.slug ?? b.label!) ? -1 : 1));

  const indexOf = new Map(kept.map((t, i) => [t.id, i]));
  const dictionary: OracleTagDictionary = kept.map((t) => {
    const slug = t.slug ?? slugify(t.label!);
    const parents = (t.parent_ids ?? []).map((p) => indexOf.get(p)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
    const aliases = [...new Set((t.aliases ?? []).map(slugify).filter((a) => a && a !== slug))].sort();
    if (aliases.length) return [slug, parents, aliases] as OracleTagEntry;
    if (parents.length) return [slug, parents] as OracleTagEntry;
    return [slug] as OracleTagEntry;
  });

  const byOracleId = new Map<string, number[]>();
  for (const t of kept) {
    const i = indexOf.get(t.id)!;
    for (const tagging of t.taggings ?? []) {
      const oracleId = tagging.oracle_id;
      if (!oracleId) continue;
      const list = byOracleId.get(oracleId);
      if (list) list.push(i);
      else byOracleId.set(oracleId, [i]);
    }
  }
  for (const list of byOracleId.values()) list.sort((a, b) => a - b);

  return { dictionary, byOracleId, excluded: excluded.size };
}

function readCache(outDir: string): CacheFile | null {
  const path = join(outDir, CACHE_FILE);
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as CacheFile;
    if (cache.v !== CACHE_FORMAT || cache.excludeKey !== excludeKey()) return null;
    if (!Array.isArray(cache.dictionary) || !cache.byOracleId) return null;
    return cache;
  } catch {
    return null; // truncated / unreadable cache — just refetch
  }
}

function writeCache(outDir: string, cache: CacheFile): void {
  // Note the extension: pruneUnreferenced() deletes every unreferenced
  // `.json.gz` in OUT_DIR, and the Pages job copies `*.json.gz` into the site.
  // This is a build cache, not an artifact, so it must match neither.
  writeFileSync(join(outDir, CACHE_FILE), gzipSync(Buffer.from(JSON.stringify(cache)), { level: 9 }));
}

function ageInDays(iso: string, now: number): number {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? (now - then) / 86_400_000 : Infinity;
}

/**
 * The oracle-tag vocabulary plus each card's tags, from the weekly cache when
 * it's still fresh and from Scryfall when it isn't.
 *
 * Env knobs: TAGS_MAX_AGE_DAYS (default 7), FORCE_TAGS=1 to refetch now.
 */
export async function buildOracleTags(outDir: string, now = Date.now()): Promise<OracleTagsBuild> {
  const maxAge = process.env.TAGS_MAX_AGE_DAYS ? Number(process.env.TAGS_MAX_AGE_DAYS) : DEFAULT_MAX_AGE_DAYS;
  const cached = process.env.FORCE_TAGS ? null : readCache(outDir);

  if (cached && ageInDays(cached.fetchedAt, now) < maxAge) {
    const byOracleId = new Map(Object.entries(cached.byOracleId));
    let taggings = 0;
    for (const list of byOracleId.values()) taggings += list.length;
    return {
      dictionary: cached.dictionary,
      byOracleId,
      stats: {
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        tags: cached.dictionary.length,
        excluded: 0,
        cards: byOracleId.size,
        taggings,
      },
    };
  }

  const raw = await downloadTags();
  const { dictionary, byOracleId, excluded } = compile(raw);
  const fetchedAt = new Date(now).toISOString();
  writeCache(outDir, {
    v: CACHE_FORMAT,
    excludeKey: excludeKey(),
    fetchedAt,
    dictionary,
    byOracleId: Object.fromEntries(byOracleId),
  });
  let taggings = 0;
  for (const list of byOracleId.values()) taggings += list.length;
  return {
    dictionary,
    byOracleId,
    stats: { source: 'network', fetchedAt, tags: dictionary.length, excluded, cards: byOracleId.size, taggings },
  };
}
