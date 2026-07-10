import type { Color, Finish, Format, LegalityStatus, Printing, Rarity } from '@mtg/shared';
import { FORMATS } from '@mtg/shared';

// Map a raw Scryfall card object down to our slim Printing, tolerating unknown
// and added fields (beta plan handoff note). Also carries the oracle-invariant
// fields so the pipeline can pick a representative printing per oracle_id.

// Loose shape of the ~80-field Scryfall card. Only the fields we read.
export interface RawCard {
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
  games?: string[];
  digital?: boolean;
  image_uris?: { small?: string; normal?: string };
  card_faces?: Array<{
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    colors?: string[];
    image_uris?: { small?: string; normal?: string };
  }>;
  prices?: { eur?: string | null; usd?: string | null };
  legalities?: Record<string, string>;
}

const VALID_COLORS = new Set(['W', 'U', 'B', 'R', 'G']);
const VALID_FINISHES = new Set(['nonfoil', 'foil', 'etched']);
const VALID_RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);

function colors(values: string[] | undefined): Color[] {
  return (values ?? []).filter((c): c is Color => VALID_COLORS.has(c));
}

function finishes(values: string[] | undefined): Finish[] {
  const out = (values ?? []).filter((f): f is Finish => VALID_FINISHES.has(f));
  return out.length ? out : ['nonfoil'];
}

function rarity(value: string): Rarity {
  return (VALID_RARITIES.has(value) ? value : 'common') as Rarity;
}

function price(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const VALID_LEGALITY = new Set(['legal', 'not_legal', 'banned', 'restricted']);

function legalities(raw: Record<string, string> | undefined): Partial<Record<Format, LegalityStatus>> {
  const out: Partial<Record<Format, LegalityStatus>> = {};
  if (!raw) return out;
  for (const f of FORMATS) {
    const v = raw[f];
    if (v && VALID_LEGALITY.has(v)) out[f] = v as LegalityStatus;
  }
  return out;
}

/** Front-face-aware image extraction (handles double-faced / split cards). */
function images(card: RawCard): { small: string | null; normal: string | null } {
  if (card.image_uris) {
    return { small: card.image_uris.small ?? null, normal: card.image_uris.normal ?? null };
  }
  const face = card.card_faces?.find((f) => f.image_uris);
  if (face?.image_uris) {
    return { small: face.image_uris.small ?? null, normal: face.image_uris.normal ?? null };
  }
  return { small: null, normal: null };
}

/** Oracle-invariant text fields, joining faces for DFC/split cards. */
function oracleFields(card: RawCard): {
  manaCost: string | null;
  typeLine: string;
  oracleText: string | null;
  colors: Color[];
} {
  const faces = card.card_faces ?? [];
  const manaCost = card.mana_cost || faces.map((f) => f.mana_cost).filter(Boolean).join(' // ') || null;
  const typeLine = card.type_line || faces.map((f) => f.type_line).filter(Boolean).join(' // ') || '';
  const oracleText =
    card.oracle_text ?? (faces.length ? faces.map((f) => f.oracle_text ?? '').join('\n//\n') : null);
  const faceColors = faces.flatMap((f) => f.colors ?? []);
  return {
    manaCost,
    typeLine,
    oracleText: oracleText || null,
    colors: colors(card.colors ?? (faceColors.length ? faceColors : undefined)),
  };
}

export interface SlimResult {
  printing: Printing;
  /** Current prices, kept out of the printing so card data and prices version independently. */
  prices: { eur: number | null; usd: number | null };
  /** Fields for building the representative OracleCard (rarity is the rep printing's). */
  oracle: {
    name: string;
    manaCost: string | null;
    cmc: number;
    typeLine: string;
    oracleText: string | null;
    colors: Color[];
    colorIdentity: Color[];
    rarity: Rarity;
    legalities: Partial<Record<Format, LegalityStatus>>;
  };
}

/** Returns null for cards we deliberately drop (no oracle_id, non-paper, digital-only). */
export function slimCard(card: RawCard): SlimResult | null {
  if (!card.oracle_id || !card.name) return null;
  // Paper collection app: skip Arena/MTGO-only cards.
  if (card.digital) return null;
  if (card.games && !card.games.includes('paper')) return null;

  const img = images(card);
  const of = oracleFields(card);

  const printing: Printing = {
    scryfallId: card.id,
    oracleId: card.oracle_id,
    set: card.set,
    setName: card.set_name,
    collectorNumber: card.collector_number,
    lang: card.lang,
    finishes: finishes(card.finishes),
    releasedAt: card.released_at,
    imageSmall: img.small,
    imageNormal: img.normal,
  };

  return {
    printing,
    prices: { eur: price(card.prices?.eur), usd: price(card.prices?.usd) },
    oracle: {
      name: card.name,
      manaCost: of.manaCost,
      cmc: card.cmc ?? 0,
      typeLine: of.typeLine,
      oracleText: of.oracleText,
      colors: of.colors,
      colorIdentity: colors(card.color_identity),
      rarity: rarity(card.rarity),
      legalities: legalities(card.legalities),
    },
  };
}
