import type { CardDbArtifactMeta, CardDbManifest, OracleTagDictionary } from '@mtg/shared';
import { db } from '../db/schema.js';
import { sha256Hex } from '../util/sha256.js';
import { CARD_DB_BASE } from './config.js';
import { setOracleTagResolver } from './querySyntax.js';

// The Scryfall Tagger oracle-tag vocabulary behind `otag:` search. Each oracle
// card row carries sorted indices into this list (OracleCard.tags); the list
// itself ships separately because it's per-vocabulary, not per-card.
//
// Same lifecycle as the set-type map (setTypes.ts): not part of the startup
// sync, fetched the first time a search needs it, cached in one IndexedDB row,
// refreshed only when the served hash moves. Best-effort throughout — with no
// dictionary `otag:` resolves nothing and falls back to plain name text, which
// is the same thing a typo does.
//
// The hierarchy is the whole point of holding the dictionary rather than a flat
// slug list. Scryfall's tags form a DAG and a search means the entire subtree:
// `otag:removal` finds thousands of cards even though the `removal` tag itself
// is tagged on none of them — every hit comes from a descendant.

export interface OracleTagsRow {
  key: 'current';
  /** sha256 of the uncompressed JSON, matched against the manifest. */
  sha256: string;
  dictionary: OracleTagDictionary;
}

/** Slug (and alias) → dictionary index, plus the parent→children edges. */
interface TagIndex {
  dictionary: OracleTagDictionary;
  bySlug: Map<string, number>;
  children: Map<number, number[]>;
  /** Memoised subtree closures, keyed by the tag index the query resolved to. */
  closures: Map<number, ReadonlySet<number>>;
}

function buildIndex(dictionary: OracleTagDictionary): TagIndex {
  const bySlug = new Map<string, number>();
  const children = new Map<number, number[]>();
  dictionary.forEach((entry, i) => {
    const [slug, parents, aliases] = entry;
    bySlug.set(slug, i);
    // An alias never displaces a real slug — two tags could disagree, and the
    // canonical name has to win.
    for (const alias of aliases ?? []) if (!bySlug.has(alias)) bySlug.set(alias, i);
    for (const parent of parents ?? []) {
      const kids = children.get(parent);
      if (kids) kids.push(i);
      else children.set(parent, [i]);
    }
  });
  return { dictionary, bySlug, children, closures: new Map() };
}

/**
 * A tag and everything beneath it. Iterative and `seen`-guarded because the
 * hierarchy is a DAG, not a tree — hundreds of tags have more than one parent,
 * so the same node is reached by several paths and a naive walk would not
 * terminate on a cycle.
 */
function closure(index: TagIndex, root: number): ReadonlySet<number> {
  const memo = index.closures.get(root);
  if (memo) return memo;
  const out = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of index.children.get(id) ?? []) stack.push(child);
  }
  index.closures.set(root, out);
  return out;
}

let index: TagIndex | null = null;
/** Set once the load has run, dictionary or not — a miss must not refetch per keystroke. */
let loaded = false;
let inFlight: Promise<void> | null = null;

/** Wired into the (dependency-free) query parser so `otag:` can resolve slugs. */
function register(dictionary: OracleTagDictionary | null): void {
  index = dictionary ? buildIndex(dictionary) : null;
  loaded = true;
  const current = index;
  setOracleTagResolver(
    current
      ? (slug) => {
          const id = current.bySlug.get(slug);
          return id === undefined ? null : closure(current, id);
        }
      : null,
  );
}

async function fetchManifest(): Promise<CardDbManifest> {
  const res = await fetch(new URL('manifest.json', CARD_DB_BASE!).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return (await res.json()) as CardDbManifest;
}

async function download(meta: CardDbArtifactMeta): Promise<OracleTagDictionary> {
  const res = await fetch(new URL(meta.url, CARD_DB_BASE!).href, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`oracle-tags download HTTP ${res.status}`);
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const text = await new Response(res.body.pipeThrough(gunzip)).text();
  if ((await sha256Hex(text)) !== meta.sha256) throw new Error('oracle-tags checksum mismatch: download corrupt');
  const dictionary = JSON.parse(text) as OracleTagDictionary;
  await db.oracleTags.put({ key: 'current', sha256: meta.sha256, dictionary });
  return dictionary;
}

/**
 * Make sure `otag:` can resolve. Resolves immediately once loaded, so callers
 * can await it on every search without paying for it more than once.
 */
export async function loadOracleTags(): Promise<void> {
  if (loaded) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const installed = await db.oracleTags.get('current');
    if (CARD_DB_BASE) {
      try {
        const meta = (await fetchManifest()).v2?.tags;
        if (meta && installed?.sha256 !== meta.sha256) {
          register(await download(meta));
          return;
        }
      } catch {
        // Offline, or a card DB built before `otag:` existed — use what's cached.
      }
    }
    register(installed?.dictionary ?? null);
  })();
  const pending = inFlight;
  try {
    return await pending;
  } finally {
    inFlight = null;
  }
}

/**
 * Forget the loaded vocabulary so the next search fetches it again. Called
 * after a card-DB import: the tags artifact only appeared in the manifest with
 * v0.145.0, so a client that looked before the rebuilt DB was published cached
 * "there is no vocabulary" for the rest of the session and kept resolving
 * `otag:` to nothing even once the data was there.
 */
export function invalidateOracleTags(): void {
  index = null;
  loaded = false;
  setOracleTagResolver(null);
}

/** How many tags a slug stands for, itself included. Ranks the suggestions. */
function subtreeSize(id: number): number {
  return index ? closure(index, id).size : 1;
}

/** The `otag:` fragment being typed at the end of the query, if there is one. */
const OTAG_TAIL = /(?:^|[\s(])-?(?:otag|oracletag|function)[:=]([a-z0-9-]*)$/i;

/** How many slugs the dropdown offers. It's a starting point, not the vocabulary. */
const MAX_COMPLETIONS = 40;

export interface OtagCompletions {
  /** Query text up to and including `otag:` — prepend to a slug to complete it. */
  head: string;
  slugs: string[];
}

/**
 * Tag slugs worth offering for a half-typed `otag:` term. Four thousand slugs
 * are undiscoverable without this: nothing in the UI would ever tell you that
 * `otag:pinger` or `otag:group-slug` exist.
 *
 * With nothing typed after the colon the broadest tags come first — a tag that
 * stands for a hundred others is a better opening move than the alphabetically
 * first one. Once there's a fragment, slugs that start with it beat slugs that
 * merely contain it, and breadth breaks the tie.
 */
export function otagCompletions(query: string): OtagCompletions | null {
  if (!index) return null;
  const m = OTAG_TAIL.exec(query);
  if (!m) return null;
  const partial = m[1]!.toLowerCase();
  const head = query.slice(0, query.length - partial.length);

  const scored: Array<{ slug: string; rank: number; size: number }> = [];
  index.dictionary.forEach(([slug], id) => {
    // The slug already typed in full is a wasted row — same rule the recent
    // searches use. Narrower tags containing it are still worth offering.
    if (slug === partial) return;
    if (!partial || slug.startsWith(partial)) scored.push({ slug, rank: 0, size: subtreeSize(id) });
    else if (slug.includes(partial)) scored.push({ slug, rank: 1, size: subtreeSize(id) });
  });
  scored.sort((a, b) => a.rank - b.rank || b.size - a.size || (a.slug < b.slug ? -1 : 1));
  return { head, slugs: scored.slice(0, MAX_COMPLETIONS).map((s) => s.slug) };
}
