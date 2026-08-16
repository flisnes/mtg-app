import type { Color, Finish, Format, LegalityStatus, Printing, PrintingVariant, Rarity } from '@mtg/shared';
import { FORMATS, PRINTING_VARIANTS, normalizeColors } from '@mtg/shared';

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
  promo?: boolean;
  /** Cosmetic frame treatments *and* functional frames, mixed together — see VARIANT_FRAME_EFFECTS. */
  frame_effects?: string[];
  /** 'black' | 'white' | 'borderless' | 'silver' | 'gold'. */
  border_color?: string;
  /** Frame generation: '1993' | '1997' | '2003' | '2015' | 'future'. */
  frame?: string;
  /** 'boosterfun', 'surgefoil', 'serialized', 'prerelease', … — see variantsOf. */
  promo_types?: string[];
  textless?: boolean;
  layout?: string;
  reserved?: boolean;
  game_changer?: boolean;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  rarity: string;
  power?: string;
  toughness?: string;
  finishes?: string[];
  games?: string[];
  digital?: boolean;
  image_uris?: { small?: string; normal?: string };
  card_faces?: Array<{
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    colors?: string[];
    power?: string;
    toughness?: string;
    image_uris?: { small?: string; normal?: string };
  }>;
  /** Tokens (and other closely-related cards) this card produces or pairs with. */
  all_parts?: Array<{ id: string; component: string }>;
  prices?: {
    eur?: string | null;
    usd?: string | null;
    eur_foil?: string | null;
    usd_foil?: string | null;
    usd_etched?: string | null;
  };
  legalities?: Record<string, string>;
}

const VALID_FINISHES = new Set(['nonfoil', 'foil', 'etched']);
const VALID_RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);

function finishes(values: string[] | undefined): Finish[] {
  const out = (values ?? []).filter((f): f is Finish => VALID_FINISHES.has(f));
  return out.length ? out : ['nonfoil'];
}

function rarity(value: string): Rarity {
  return (VALID_RARITIES.has(value) ? value : 'common') as Rarity;
}

// ---- Variant treatments (see PrintingVariant) ----
//
// Most of `frame_effects` describes a frame the card was *always* going to
// have — every Nyx enchantment is `enchantment`, every legend `legendary`,
// every Spree card `spree`. Only these four are a cosmetic alternative to the
// same card's plain version in the same set. Anything else Wizards dreams up
// (shattered glass, borderless-profile, …) still gets caught: those are all
// sold as Booster Fun, which carries its own promo type.
const VARIANT_FRAME_EFFECTS: Record<string, PrintingVariant> = {
  showcase: 'showcase',
  extendedart: 'extendedart',
  inverted: 'inverted',
  etched: 'etched',
};

/**
 * Chase foiling sold inside an otherwise ordinary set. Wizards names a new one
 * nearly every release (surge, galaxy, halo, ripple, fracture, mana, …), so
 * match the `…foil` suffix rather than listing them, plus the handful whose
 * name doesn't say "foil".
 */
const UNSUFFIXED_SPECIAL_FOILS = new Set([
  'oilslick',
  'neonink',
  'invisibleink',
  'textured',
  'doubleexposure',
  'doublerainbow',
  'stepandcompleat',
  'gilded',
]);

/**
 * Frames that stopped being current when the 2015 frame arrived with Magic
 * Origins. A set released after that printing a card in one of them is doing it
 * on purpose — the retro-frame treatment.
 */
const SUPERSEDED_FRAMES = new Set(['1993', '1997', '2003']);
const MODERN_FRAME_SINCE = '2015-07-17';

/** Cosmetic treatments this printing carries, in PRINTING_VARIANTS order (stable hashes). */
function variantsOf(card: RawCard): PrintingVariant[] {
  const found = new Set<PrintingVariant>();

  if (card.border_color === 'borderless') found.add('borderless');
  for (const effect of card.frame_effects ?? []) {
    const tag = VARIANT_FRAME_EFFECTS[effect];
    if (tag) found.add(tag);
  }
  if (card.frame && SUPERSEDED_FRAMES.has(card.frame) && card.released_at >= MODERN_FRAME_SINCE) {
    found.add('retro');
  }
  for (const type of card.promo_types ?? []) {
    if (type === 'serialized') found.add('serialized');
    else if (type === 'boosterfun') found.add('boosterfun');
    else if (type.endsWith('foil') || UNSUFFIXED_SPECIAL_FOILS.has(type)) found.add('specialfoil');
  }
  if (card.textless) found.add('textless');

  return PRINTING_VARIANTS.filter((v) => found.has(v));
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

/**
 * Back-face images. Only truly double-faced cards (transform, modal DFC,
 * reversible, …) have per-face image_uris and no card-level ones; split /
 * adventure / flip cards share one image and get no back.
 */
function backImages(card: RawCard): { small: string | null; normal: string | null } | null {
  if (card.image_uris) return null;
  const back = card.card_faces?.[1]?.image_uris;
  if (!back) return null;
  return { small: back.small ?? null, normal: back.normal ?? null };
}

/** Oracle-invariant text fields, joining faces for DFC/split cards. */
function oracleFields(card: RawCard): {
  manaCost: string | null;
  typeLine: string;
  oracleText: string | null;
  colors: Color[];
  power: string | null;
  toughness: string | null;
} {
  const faces = card.card_faces ?? [];
  const manaCost = card.mana_cost || faces.map((f) => f.mana_cost).filter(Boolean).join(' // ') || null;
  const typeLine = card.type_line || faces.map((f) => f.type_line).filter(Boolean).join(' // ') || '';
  const oracleText =
    card.oracle_text ?? (faces.length ? faces.map((f) => f.oracle_text ?? '').join('\n//\n') : null);
  // DFCs carry colors per face, so union them — normalizeColors dedupes, or a
  // mono-colored DFC would look multicolored.
  const faceColors = faces.flatMap((f) => f.colors ?? []);
  // Front-face power/toughness (mirrors images()) — plenty for tokens, which
  // are virtually always single-faced.
  const face = faces.find((f) => f.power != null || f.toughness != null);
  return {
    manaCost,
    typeLine,
    oracleText: oracleText || null,
    colors: normalizeColors(card.colors ?? faceColors),
    power: card.power ?? face?.power ?? null,
    toughness: card.toughness ?? face?.toughness ?? null,
  };
}

export interface SlimResult {
  printing: Printing;
  /**
   * Current prices, kept out of the printing so card data and prices version
   * independently. Nonfoil (eur/usd) plus foil/etched variants (Scryfall has no
   * eur_etched, so etched EUR is left to the consumer's foil-EUR fallback).
   */
  prices: {
    eur: number | null;
    usd: number | null;
    eurFoil: number | null;
    usdFoil: number | null;
    usdEtched: number | null;
  };
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
    power: string | null;
    toughness: string | null;
    layout?: string;
    reserved?: boolean;
    gameChanger?: boolean;
  };
  /** Scryfall ids of tokens this printing's `all_parts` says the card creates. */
  tokenPartIds: string[];
  /**
   * Scryfall ids of this printing's `combo_piece` parts. Mostly real cards (the
   * self-reference, Alchemy rebalances, meld partners) — slim.ts keeps only the
   * ones that resolve to a marker card (see isMarkerCard).
   */
  comboPartIds: string[];
}

/** Returns null for cards we deliberately drop (no oracle_id, non-paper, digital-only). */
export function slimCard(card: RawCard): SlimResult | null {
  if (!card.oracle_id || !card.name) return null;
  // Paper collection app: skip Arena/MTGO-only cards.
  if (card.digital) return null;
  if (card.games && !card.games.includes('paper')) return null;

  const img = images(card);
  const back = backImages(card);
  const of = oracleFields(card);
  const variants = variantsOf(card);

  const printing: Printing = {
    scryfallId: card.id,
    oracleId: card.oracle_id,
    set: card.set,
    setName: card.set_name,
    collectorNumber: card.collector_number,
    lang: card.lang,
    finishes: finishes(card.finishes),
    releasedAt: card.released_at,
    // Omitted (not false) when it's a normal printing — that's the vast
    // majority, and the flag would otherwise cost bytes on every row.
    ...(card.promo ? { promo: true } : {}),
    // Same sparse convention: ~85% of printings are the plain version and carry
    // no tags at all, so an empty array on every one of them is pure weight.
    ...(variants.length ? { variants } : {}),
    imageSmall: img.small,
    imageNormal: img.normal,
    // Omitted (not null) for single-faced cards to keep the artifacts slim.
    ...(back ? { imageBackSmall: back.small, imageBackNormal: back.normal } : {}),
  };

  const tokenPartIds = (card.all_parts ?? [])
    .filter((p) => p.component === 'token' && p.id !== card.id)
    .map((p) => p.id);
  const comboPartIds = (card.all_parts ?? [])
    .filter((p) => p.component === 'combo_piece' && p.id !== card.id)
    .map((p) => p.id);

  return {
    printing,
    prices: {
      eur: price(card.prices?.eur),
      usd: price(card.prices?.usd),
      eurFoil: price(card.prices?.eur_foil),
      usdFoil: price(card.prices?.usd_foil),
      usdEtched: price(card.prices?.usd_etched),
    },
    oracle: {
      name: card.name,
      manaCost: of.manaCost,
      cmc: card.cmc ?? 0,
      typeLine: of.typeLine,
      oracleText: of.oracleText,
      colors: of.colors,
      colorIdentity: normalizeColors(card.color_identity),
      rarity: rarity(card.rarity),
      legalities: legalities(card.legalities),
      power: of.power,
      toughness: of.toughness,
      ...(card.layout ? { layout: card.layout } : {}),
      ...(card.reserved ? { reserved: true } : {}),
      ...(card.game_changer ? { gameChanger: true } : {}),
    },
    tokenPartIds,
    comboPartIds,
  };
}
