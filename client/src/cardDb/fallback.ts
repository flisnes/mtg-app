import type { Color, Finish, OracleCard, PriceMap, Printing, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { deleteSetting, setSetting } from '../db/settings.js';
import { SCRYFALL_BULK_INDEX } from './config.js';
import { buildPriceShards } from './prices.js';

// Documented fallback (beta plan §3): if our VM is unreachable and there's no
// local DB yet, fetch Scryfall's `oracle_cards` bulk directly and slim it
// client-side. This is a degraded path — `oracle_cards` has one printing per
// card, so the edition picker is limited until the VM is reachable again.
// Runs on the main thread (rare path); the primary path uses the worker.

const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);
const FINISHES = new Set(['nonfoil', 'foil', 'etched']);
const RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);

interface RawCard {
  id: string;
  oracle_id?: string;
  name: string;
  lang: string;
  released_at: string;
  set: string;
  set_name: string;
  collector_number: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  rarity: string;
  finishes?: string[];
  digital?: boolean;
  games?: string[];
  image_uris?: { small?: string; normal?: string };
  card_faces?: Array<{ mana_cost?: string; type_line?: string; oracle_text?: string; image_uris?: { small?: string; normal?: string } }>;
  prices?: { eur?: string | null; usd?: string | null };
}

const asColors = (v?: string[]): Color[] => (v ?? []).filter((c): c is Color => COLORS.has(c));
const asFinishes = (v?: string[]): Finish[] => {
  const f = (v ?? []).filter((x): x is Finish => FINISHES.has(x));
  return f.length ? f : ['nonfoil'];
};
const asRarity = (v: string): Rarity => (RARITIES.has(v) ? v : 'common') as Rarity;
const asPrice = (v?: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function image(card: RawCard): { small: string | null; normal: string | null } {
  const u = card.image_uris ?? card.card_faces?.find((f) => f.image_uris)?.image_uris;
  return { small: u?.small ?? null, normal: u?.normal ?? null };
}

function slim(card: RawCard): { oracle: OracleCard; printing: Printing; prices: [number | null, number | null] } | null {
  if (!card.oracle_id || !card.name || card.digital) return null;
  if (card.games && !card.games.includes('paper')) return null;
  const faces = card.card_faces ?? [];
  const img = image(card);
  const printing: Printing = {
    scryfallId: card.id,
    oracleId: card.oracle_id,
    set: card.set,
    setName: card.set_name,
    collectorNumber: card.collector_number,
    lang: card.lang,
    finishes: asFinishes(card.finishes),
    releasedAt: card.released_at,
    imageSmall: img.small,
    imageNormal: img.normal,
  };
  const oracle: OracleCard = {
    oracleId: card.oracle_id,
    name: card.name,
    manaCost: card.mana_cost || faces.map((f) => f.mana_cost).filter(Boolean).join(' // ') || null,
    cmc: card.cmc ?? 0,
    typeLine: card.type_line || faces.map((f) => f.type_line).filter(Boolean).join(' // ') || '',
    oracleText: card.oracle_text ?? (faces.length ? faces.map((f) => f.oracle_text ?? '').join('\n//\n') : null),
    colors: asColors(card.colors),
    colorIdentity: asColors(card.color_identity),
    rarity: asRarity(card.rarity),
    imageSmall: img.small,
    imageNormal: img.normal,
    defaultScryfallId: card.id,
  };
  return { oracle, printing, prices: [asPrice(card.prices?.eur), asPrice(card.prices?.usd)] };
}

export async function runScryfallFallback(onProgress: (fraction: number, label: string) => void): Promise<void> {
  onProgress(0.02, 'Contacting Scryfall…');
  const idx = await fetch(SCRYFALL_BULK_INDEX, { headers: { Accept: 'application/json' } });
  if (!idx.ok) throw new Error(`Scryfall bulk index HTTP ${idx.status}`);
  const entry = ((await idx.json()) as { data: Array<{ type: string; download_uri: string; updated_at: string }> }).data.find(
    (d) => d.type === 'oracle_cards',
  );
  if (!entry) throw new Error('no oracle_cards bulk entry');

  onProgress(0.08, 'Downloading cards from Scryfall…');
  const res = await fetch(entry.download_uri);
  if (!res.ok) throw new Error(`Scryfall download HTTP ${res.status}`);
  const raw = (await res.json()) as RawCard[];

  onProgress(0.6, 'Preparing cards…');
  const oracle: OracleCard[] = [];
  const printings: Printing[] = [];
  const prices: PriceMap = {};
  for (const card of raw) {
    const s = slim(card);
    if (s) {
      oracle.push(s.oracle);
      printings.push(s.printing);
      if (s.prices[0] != null || s.prices[1] != null) prices[s.printing.scryfallId] = s.prices;
    }
  }

  onProgress(0.85, 'Saving…');
  // One transaction so an interrupted rebuild can't leave the tables cleared
  // but unfilled (the worker path replaces chunks transactionally too).
  await db.transaction('rw', [db.oracleCards, db.printings, db.priceShards], async () => {
    await db.oracleCards.clear();
    await db.printings.clear();
    await db.oracleCards.bulkPut(oracle);
    await db.printings.bulkPut(printings);
    await db.priceShards.bulkPut(buildPriceShards(prices));
  });

  await setSetting('cardDbVersion', `${entry.updated_at} (scryfall-fallback)`);
  await setSetting('cardDbUpdatedAt', entry.updated_at);
  await setSetting('pricesUpdatedAt', entry.updated_at);
  await setSetting('cardDbCounts', { oracle: oracle.length, printings: printings.length });
  // Reset chunk/price bookkeeping so the next successful VM sync replaces everything.
  await deleteSetting('cardDbChunks');
  await setSetting('pricesSha256', '(scryfall-fallback)');
  onProgress(1, 'Done');
}
