// Card database types. Read-only on the client, replaced wholesale on version
// change. Sourced from the slimmed Scryfall bulk file (see beta plan §3).
//
// The oracle/printing distinction is load-bearing (ultraplan): search, decks
// and wishlists key off the oracle card; collections and trades reference a
// specific printing (scryfallId).

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

/** The five colors in canonical WUBRG order. */
export const COLORS: readonly Color[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * Valid colors only, deduplicated, in WUBRG order. Double-faced cards have no
 * top-level `colors`, so we union their faces — and a mono-green werewolf then
 * comes out as ['G','G'], which every "colors.length > 1" check reads as
 * multicolor. Producers and consumers of `colors` both go through this, so old
 * card DBs built before the fix still group and filter correctly.
 */
export function normalizeColors(values: readonly string[] | undefined): Color[] {
  if (!values || values.length === 0) return [];
  const seen = new Set(values);
  return COLORS.filter((c) => seen.has(c));
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus';

export type Finish = 'nonfoil' | 'foil' | 'etched';

/** Formats we track legality for (a curated subset of Scryfall's ~20). */
export type Format = 'standard' | 'pioneer' | 'modern' | 'legacy' | 'vintage' | 'pauper' | 'commander';

export type LegalityStatus = 'legal' | 'not_legal' | 'banned' | 'restricted';

export const FORMATS: readonly Format[] = [
  'standard',
  'pioneer',
  'modern',
  'legacy',
  'vintage',
  'pauper',
  'commander',
];

/** One functional card (one Scryfall oracle_id). Drives search / decks / wishlist. */
export interface OracleCard {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  oracleText: string | null;
  colors: Color[];
  colorIdentity: Color[];
  rarity: Rarity;
  imageSmall: string | null;
  imageNormal: string | null;
  /** Back-face images for double-faced cards (absent for single-faced ones and on card DBs built before this field). */
  imageBackSmall?: string | null;
  imageBackNormal?: string | null;
  /** A representative printing used when the user hasn't picked one. */
  defaultScryfallId: string;
  /** Legality per tracked format (oracle-invariant). May be absent on card DBs imported before this field existed. */
  legalities?: Partial<Record<Format, LegalityStatus>>;
  /** Power/toughness for creatures (incl. token creatures); absent for non-creatures and on card DBs built before this field. */
  power?: string | null;
  toughness?: string | null;
  /**
   * Oracle ids of the extra cardboard this card needs, deduplicated: tokens it
   * creates (Scryfall's `all_parts`, component `token`) plus the marker cards it
   * references (component `combo_piece` — emblems, Poison Counter, The Monarch,
   * dungeons, Day // Night, …; see isMarkerCard). Absent/empty when the card
   * needs none, or on card DBs built before this field existed. Drives the deck
   * view's "tokens you'll need" suggestions.
   */
  tokenOracleIds?: string[];
  /**
   * Scryfall's card `layout` (e.g. 'normal', 'transform', 'split', 'saga').
   * Absent on card DBs built before this field existed. Drives the `is:`
   * structural keywords (is:transform, is:mdfc, is:saga, ...).
   */
  layout?: string;
  /** On the Reserved List. Omitted (not false) when not reserved — nearly every card. */
  reserved?: boolean;
  /** A Commander Game Changer (per the Commander Rules Committee list). Omitted when not one. */
  gameChanger?: boolean;
  /**
   * Scryfall Tagger oracle tags — what the card *does* (removal, ramp, tutor,
   * combat trick, ...) as tagged by the Tagger community. Stored as sorted
   * indices into the tag dictionary artifact (manifest `v2.tags`) rather than
   * slugs, because the same few thousand strings repeated across 35k cards cost
   * twice what the numbers do. Absent when the card carries no tags (about 7%
   * of cards) and on card DBs built before this field existed. Drives `otag:`.
   */
  tags?: number[];
  /**
   * The kinds of mana this card can add, from Scryfall's `produced_mana`, as a
   * string in MANA_LETTERS order — `"WU"` for Hallowed Fountain, `"C"` for Sol
   * Ring, `"WUBRG"` for Birds of Paradise. Omitted for the ~93% of cards that
   * produce no mana, and absent on card DBs built before this field. Drives
   * `produces:` search and the deck analysis's colored-source counting.
   *
   * It says *which* colors, never *how much* or *when* — a card that taps for
   * two, or enters tapped, looks identical here. That's what `mana` is for.
   */
  produces?: string;
  /**
   * How this card feeds the mana system: what it adds, when, and whether it
   * arrives tapped. See ManaProfileTuple. Omitted for cards that neither
   * produce mana nor ramp, and absent on card DBs built before this field.
   */
  mana?: ManaProfileTuple;
  /**
   * A fetchland: the basic land types it searches out. See FetchProfileTuple.
   * Omitted for everything that isn't one (about 99.5% of cards), and absent on
   * card DBs built before this field.
   *
   * A fetch has no `produces` and no `mana` of its own, because it makes no
   * mana — it trades itself for a land. What colors it is worth is a fact about
   * the *deck* it is in, not about the card, so only the search terms live here
   * and the resolving happens where a decklist is in scope.
   */
  fetch?: FetchProfileTuple;
  /**
   * Colors this card gives to *every land you control*, as MANA_LETTERS —
   * Urborg `"B"`, Yavimaya `"G"`, Chromatic Lantern and Prismatic Omen
   * `"WUBRG"`. Omitted for everything that isn't one of the handful, and
   * absent on card DBs built before this field.
   *
   * These cards never add mana, they add a color *option*, which is why this is
   * a mask to union into other sources and not a `mana` profile of its own. An
   * Urborg in a deck with ten Mountains makes eleven black sources; counting it
   * as one black source (which is what its own `produces` says, and is true
   * about the card) is the one place the mana model *under*-counts.
   *
   * Deck-relative, like `fetch`: what it is worth depends on the lands around
   * it, so the resolving happens where a decklist is in scope.
   */
  grants?: string;
  /**
   * What the card does to your hand, library and graveyard when it resolves:
   * draw, discard, mill, surveil, scry and Treasure. See EffectProfileTuple.
   * Omitted for the ~96% of cards that do none of it unconditionally, and
   * absent on card DBs built before this field.
   *
   * `mana` says what a card puts into play; this says what it does to the rest
   * of the game. Between them the simulator can play a turn out rather than
   * only pay for one.
   */
  effect?: EffectProfileTuple;
}

/**
 * The mana letters, in the order `OracleCard.produces` writes them. WUBRG is
 * Magic's canonical color order; `C` (colorless) trails it, matching how
 * Scryfall sorts a mana cost.
 */
export const MANA_LETTERS = 'WUBRGC';

/**
 * How a card puts mana into play, coarse enough to be derivable and specific
 * enough to sequence a turn with:
 *
 *   land       a land that taps for mana
 *   rock       an artifact that taps for mana (Sol Ring, a Signet)
 *   dork       a creature that taps for mana (Llanowar Elves) — summoning sick
 *   landramp   fetches a land onto the battlefield (Rampant Growth, Cultivate)
 *   ritual     one-shot mana (Dark Ritual)
 *   extraland  lets you play additional lands (Exploration, Azusa)
 *
 * Stored as an index into MANA_KINDS.
 */
export type ManaKind = 'land' | 'rock' | 'dork' | 'landramp' | 'ritual' | 'extraland';

export const MANA_KINDS: readonly ManaKind[] = ['land', 'rock', 'dork', 'landramp', 'ritual', 'extraland'];

/** Arrives tapped every time (Jungle Hollow, Temple of Enlightenment). */
export const MANA_TAPPED = 1;
/**
 * Arrives tapped only sometimes — the checklands, shocklands, fastlands,
 * slowlands and battle lands, whose rules text says "enters tapped" inside a
 * sentence beginning "unless". Distinct from MANA_TAPPED because the two read
 * identically in oracle text and play nothing alike.
 */
export const MANA_MAYBE_TAPPED = 2;
/** The mana isn't available the turn it resolves (a creature's summoning sickness). */
export const MANA_SICK = 4;
/** Spends itself: a ritual adds mana once, not every turn. */
export const MANA_ONE_SHOT = 8;
/**
 * We could not work out how much mana it adds, so `adds` is a floor of 1.
 * Bloom Tender, Charmed Pendant, Astral Cornucopia: cards whose amount depends
 * on the board. Consumers should say so rather than quietly using the 1.
 */
export const MANA_UNKNOWN = 16;
/**
 * Every mana in `adds` has to be the *same* color, chosen from the profile's
 * colors. Lotus Field's "Add three mana of any one color" and Black Lotus's
 * are three mana or no mana, never one of each: expanded as independent
 * five-color units they pay {W}{U}{B}, which is a cost neither card can pay.
 * Only meaningful when `adds > 1` and more than one color is on offer.
 */
export const MANA_ONE_COLOR = 32;
/**
 * It goes away. `life` says after how many turns or activations — three for
 * Urza's Saga, two for the depletion lands. Without this the simulator credits
 * a Peat Bog with sixteen mana over an eight-turn game instead of four.
 */
export const MANA_EXPIRES = 64;
/**
 * `entry` lands go back to their owner's hand rather than to the graveyard:
 * the Karoos ("return a land you control to its owner's hand"). The difference
 * matters — a bounced land is a spare land drop, a sacrificed one is gone.
 */
export const MANA_BOUNCE = 128;
/**
 * Its colors are whatever an *opponent's* lands make (Exotic Orchard, Fellwar
 * Stone). A goldfish has no opponents, so there is no honest colored answer and
 * `colors` is empty: the mana pays generic and never a pip. That errs the right
 * way — it never claims a color the deck might not have, and it never pretends
 * the land is blank.
 */
export const MANA_OPPONENT = 256;
/**
 * The mana is real but spendable only on part of your deck: Ancient Ziggurat
 * and Pillar of the Paruns (creature spells, multicolored spells). Counted like
 * any other source, flagged so the UI can say what the count includes — how
 * much a Cavern is worth is a fact about how creature-dense the deck is.
 */
export const MANA_RESTRICTED = 512;
/**
 * Its colors are whatever the rest of *your* lands make (Reflecting Pool).
 * Unlike MANA_OPPONENT this is answerable, because your decklist is in scope:
 * it resolves against the deck the same way a fetchland's colors do.
 */
export const MANA_REFLECTS = 1024;

/**
 * `[kind, adds, flags, colors?, life?, entry?]`, positional for the same reason
 * PriceTuple is: this rides on several thousand oracle rows and the key names
 * would cost more than the values. Everything past `flags` is omitted on the
 * ~95% of profiles that don't need it.
 *
 *   kind   index into MANA_KINDS
 *   adds   mana it adds once available, the turn it's available (1 for a
 *          Forest, 2 for Sol Ring, 3 for Dark Ritual). For `landramp` this is
 *          lands fetched onto the battlefield, which is the same thing a turn
 *          later. A floor of 1 when MANA_UNKNOWN is set.
 *   flags  MANA_TAPPED | MANA_MAYBE_TAPPED | MANA_SICK | MANA_ONE_SHOT |
 *          MANA_UNKNOWN | MANA_ONE_COLOR | MANA_EXPIRES | MANA_BOUNCE |
 *          MANA_OPPONENT | MANA_RESTRICTED | MANA_REFLECTS
 *   colors what the ability we costed actually makes, when that is *narrower*
 *          than `produces`; null or absent when the two agree. See below.
 *   life   turns or activations before it is gone, with MANA_EXPIRES.
 *   entry  lands it costs you as it enters — sacrificed, or returned to hand
 *          with MANA_BOUNCE.
 *
 * `colors` exists because `produces` answers a different question. Scryfall's
 * `produced_mana` is the union over *every* ability at *any* price: Nykthos
 * comes out as a six-color source when the ability we costed at one mana is
 * "{T}: Add {C}" and nothing else. The profile costs one clause, so it has to
 * carry that clause's colors. An empty string is a real value and means the
 * mana has no color we can name (MANA_OPPONENT) — distinct from null, which
 * means "the same as `produces`".
 *
 * A `landramp` card has no `produces` and no `colors` at all: what it makes
 * depends on the land it fetches.
 */
export type ManaProfileTuple = [
  kind: number,
  adds: number,
  flags: number,
  colors?: string | null,
  life?: number,
  entry?: number,
];

/** ManaProfileTuple unpacked. */
export interface ManaProfile {
  kind: ManaKind;
  adds: number;
  /** 'never' | 'always' | 'maybe' — see MANA_TAPPED / MANA_MAYBE_TAPPED. */
  tapped: 'never' | 'always' | 'maybe';
  /** Summoning-sick: the mana is there from the *next* turn. */
  sick: boolean;
  oneShot: boolean;
  /** `adds` is a guess of 1; the real amount depends on the board. */
  unknown: boolean;
  /** All of `adds` is one color, chosen from `colors`. See MANA_ONE_COLOR. */
  oneColor: boolean;
  /** Colors depend on an opponent's lands, so `colors` is empty. See MANA_OPPONENT. */
  opponent: boolean;
  /** Colors are whatever your own lands make; resolve against the deck. See MANA_REFLECTS. */
  reflects: boolean;
  /** Spendable only on part of your deck. See MANA_RESTRICTED. */
  restricted: boolean;
  /** Turns or activations it lasts, or 0 when it is permanent. */
  life: number;
  /** Lands it costs you on the way in, or 0. */
  entry: number;
  /** Those lands go back to hand rather than to the graveyard. */
  bounce: boolean;
  /**
   * The colors the costed ability makes, or null to mean "whatever `produces`
   * says". Empty string means "mana with no nameable color", which is not the
   * same thing — see the tuple's docs.
   */
  colors: string | null;
}

export function decodeManaProfile(tuple: ManaProfileTuple | undefined): ManaProfile | null {
  if (!tuple) return null;
  const [kind, adds, flags, colors, life, entry] = tuple;
  return {
    kind: MANA_KINDS[kind] ?? 'land',
    adds,
    tapped: flags & MANA_TAPPED ? 'always' : flags & MANA_MAYBE_TAPPED ? 'maybe' : 'never',
    sick: !!(flags & MANA_SICK),
    oneShot: !!(flags & MANA_ONE_SHOT),
    unknown: !!(flags & MANA_UNKNOWN),
    oneColor: !!(flags & MANA_ONE_COLOR),
    opponent: !!(flags & MANA_OPPONENT),
    reflects: !!(flags & MANA_REFLECTS),
    restricted: !!(flags & MANA_RESTRICTED),
    life: life ?? 0,
    entry: entry ?? 0,
    bounce: !!(flags & MANA_BOUNCE),
    colors: colors ?? null,
  };
}

/**
 * The colors a source actually makes: the costed ability's, falling back to
 * `produced_mana` for the great majority where the two agree. Every consumer
 * wants this rather than `produces` on its own.
 */
export function sourceColors(profile: ManaProfile, produces: string | undefined): string {
  return profile.colors ?? produces ?? '';
}

/**
 * The amounts in the profile are per *turn*, not once: Phyrexian Arena's "At
 * the beginning of your upkeep, you draw a card". Every other profile fires
 * once, the turn the card resolves.
 */
export const EFFECT_REPEATABLE = 1;
/**
 * At least one amount is a guess of what we could read, the way MANA_UNKNOWN
 * is: "draw X cards", "mill cards equal to the number of Zombies you control".
 * The counts are a floor. Consumers should say so rather than use them flat.
 */
export const EFFECT_UNKNOWN = 2;
/**
 * The cards come off a *search*, not off the top: Diabolic Intent, Treasure
 * Mage. For hand size a tutor and a draw are the same card; for what ends up in
 * that hand they are not remotely the same, and a simulator that draws the top
 * card instead is under-selling every tutor in the deck. Flagged so it can say
 * which way it erred.
 */
export const EFFECT_TUTOR = 4;
/**
 * The discard is "discard your hand" — Faithless Looting's bigger cousins — so
 * `discard` is however many cards you are holding, not the number stored.
 */
export const EFFECT_WHOLE_HAND = 8;

/**
 * `[flags, draw, discard, mill, surveil, scry, treasure]`, positional for the
 * same reason ManaProfileTuple is, and trimmed to its last non-zero slot: a
 * cantrip is `[0, 1]` and that is most of the rows this field costs anything on.
 *
 *   flags     EFFECT_REPEATABLE | EFFECT_UNKNOWN | EFFECT_TUTOR |
 *             EFFECT_WHOLE_HAND
 *   draw      cards into your hand, tutors included
 *   discard   cards out of it, as part of the same effect (a loot, a rummage,
 *             an additional cost)
 *   mill      cards from the top of *your* library into your graveyard
 *   surveil   cards looked at, each of which may go to the graveyard
 *   scry      cards looked at, each of which may go to the bottom
 *   treasure  Treasure tokens created: one-shot mana of any color
 *
 * `flags` leads rather than trails so that a slot added later cannot move it,
 * which is the whole reason ManaProfileTuple keeps its optional tail at the end.
 *
 * Everything here is what the card does to *you*, on the turn it resolves,
 * unconditionally. An effect hanging off a combat trigger, an activated
 * ability, a kicker or an "if", and an effect aimed at an opponent, is absent
 * rather than guessed at — see the pipeline's derivation for why that direction
 * is the safe one.
 */
export type EffectProfileTuple = [
  flags: number,
  draw?: number,
  discard?: number,
  mill?: number,
  surveil?: number,
  scry?: number,
  treasure?: number,
];

/** EffectProfileTuple unpacked. */
export interface EffectProfile {
  /** Cards into hand. A tutor counts here too; see `tutor`. */
  draw: number;
  /** Cards out of hand as part of the same effect. See `wholeHand`. */
  discard: number;
  /** Cards from your library to your graveyard. */
  mill: number;
  /** Cards looked at, any of which may be binned. */
  surveil: number;
  /** Cards looked at, any of which may be bottomed. */
  scry: number;
  /** Treasure tokens: one-shot mana of any color. */
  treasure: number;
  /** The amounts are per turn rather than once. See EFFECT_REPEATABLE. */
  repeatable: boolean;
  /** At least one amount is a floor we could not read exactly. */
  unknown: boolean;
  /** The draw is a search of your library, not off the top. */
  tutor: boolean;
  /** `discard` means "your whole hand", whatever that is at the time. */
  wholeHand: boolean;
}

export function decodeEffectProfile(tuple: EffectProfileTuple | undefined): EffectProfile | null {
  if (!tuple) return null;
  const [flags, draw, discard, mill, surveil, scry, treasure] = tuple;
  return {
    draw: draw ?? 0,
    discard: discard ?? 0,
    mill: mill ?? 0,
    surveil: surveil ?? 0,
    scry: scry ?? 0,
    treasure: treasure ?? 0,
    repeatable: !!(flags & EFFECT_REPEATABLE),
    unknown: !!(flags & EFFECT_UNKNOWN),
    tutor: !!(flags & EFFECT_TUTOR),
    wholeHand: !!(flags & EFFECT_WHOLE_HAND),
  };
}

/** The fetch can only find a *basic* land, so a shockland sharing the type is out of reach. */
export const FETCH_BASIC_ONLY = 4;

/**
 * `[types, flags]` — a fetchland, in the only two facts that aren't already
 * derivable from the deck it sits in.
 *
 *   types  the basic land types it searches for, written as the letter of the
 *          color that type taps for: Scalding Tarn "UR" (Island or Mountain),
 *          Windswept Heath "WG", Evolving Wilds "WUBRG" (any basic land).
 *          Matching happens on the *type*, not the color, which is why the
 *          letters have to be read back through MANA_LETTERS rather than
 *          compared against `produces` — a Scalding Tarn in a deck with a
 *          Hallowed Fountain is a white source, because a Hallowed Fountain is
 *          an Island.
 *   flags  MANA_TAPPED (the land arrives tapped — Evolving Wilds, the
 *          panoramas, the slow fetches) | MANA_MAYBE_TAPPED (arrives tapped
 *          and may untap — Fabled Passage) | FETCH_BASIC_ONLY
 *
 * The flags describe the land it *puts down*, not the fetch itself. Every fetch
 * worth the name enters untapped; what costs you a turn is what it finds.
 */
export type FetchProfileTuple = [types: string, flags: number];

/** FetchProfileTuple unpacked. */
export interface FetchProfile {
  /** Basic land types it can search for, as MANA_LETTERS letters. */
  types: string;
  /** How the land it finds arrives. */
  tapped: 'never' | 'always' | 'maybe';
  /** Basics only: it can't find a shockland or a triome that shares the type. */
  basicOnly: boolean;
}

export function decodeFetchProfile(tuple: FetchProfileTuple | undefined): FetchProfile | null {
  if (!tuple) return null;
  const [types, flags] = tuple;
  return {
    types,
    tapped: flags & MANA_TAPPED ? 'always' : flags & MANA_MAYBE_TAPPED ? 'maybe' : 'never',
    basicOnly: !!(flags & FETCH_BASIC_ONLY),
  };
}

/**
 * The basic land types, in MANA_LETTERS order, so a letter and a type line can
 * be matched without a second alphabet.
 */
export const BASIC_LAND_TYPES: Readonly<Record<string, string>> = {
  W: 'Plains',
  U: 'Island',
  B: 'Swamp',
  R: 'Mountain',
  G: 'Forest',
};

/**
 * A "marker" card: the printed reminder cardboard a mechanic asks you to keep
 * next to the battlefield rather than a token you put onto it — Poison Counter,
 * Energy Reserve, Experience, The Monarch, Undercity // The Initiative, the AFR
 * dungeons, planeswalker emblems, Day // Night, The Ring // The Ring Tempts You,
 * On an Adventure, Plot, Radiation, Start Your Engines! // Max Speed, and the
 * face-down helpers (Morph, Manifest, A Mysterious Creature).
 *
 * Scryfall links every one of these off the cards that use them, but as
 * `all_parts` component `combo_piece` — the same component it uses for a card's
 * self-reference, its Alchemy rebalance and its meld partners. Those are all
 * real cards, and no real card's type line is bare "Card", "Emblem", "Dungeon"
 * or "Creature", so the type line is what tells them apart. Checklist and
 * substitute cards clear that bar too (every DFC links one), but they're a
 * sleeving aid, not part of the deck — hence the name check.
 */
export function isMarkerCard(name: string, typeLine: string): boolean {
  if (/\b(Checklist|Substitute Card)\b/i.test(name)) return false;
  const faces = typeLine.split('//').map((f) => f.trim()).filter(Boolean);
  if (faces.length === 0) return false;
  return faces.every((f) => f === 'Card' || f === 'Creature' || /^(Emblem|Dungeon)\b/.test(f));
}

/**
 * A cosmetic treatment that makes a printing a *variant* of a set's plain
 * version rather than the card you'd pull from an ordinary pack. Modern sets
 * print the same card four or five ways, and "the newest printing" is useless
 * if it lands on a serialized borderless surge-foil showcase.
 *
 * Derived in the pipeline from Scryfall's `frame_effects`, `border_color`,
 * `frame` and `promo_types`:
 *
 *   borderless   art runs to the card edge (border_color: borderless)
 *   showcase     the set's alternate art-style frame
 *   extendedart  normal frame, art extended into the side borders
 *   inverted     inverted-colour frame treatment
 *   etched       foil-etched treatment
 *   retro        an old frame in a set released after the 2015 frame — the
 *                retro treatment, and also the faithful old-frame reprints in
 *                The List, which "the normal printing" shouldn't land on either
 *   serialized   numbered 1/500 and the like
 *   specialfoil  chase foiling: surge, galaxy, halo, ripple, textured, …
 *   textless     printed without its rules text
 *   boosterfun   Wizards' own "this is a Booster Fun variant" flag, which
 *                catches treatments the list above doesn't name yet
 */
export type PrintingVariant =
  | 'borderless'
  | 'showcase'
  | 'extendedart'
  | 'inverted'
  | 'etched'
  | 'retro'
  | 'serialized'
  | 'specialfoil'
  | 'textless'
  | 'boosterfun';

/**
 * Canonical order for `Printing.variants`. The pipeline emits tags in this
 * order so a printing's row — and therefore its chunk's content hash — doesn't
 * churn just because Scryfall reordered an array.
 */
export const PRINTING_VARIANTS: readonly PrintingVariant[] = [
  'borderless',
  'showcase',
  'extendedart',
  'inverted',
  'etched',
  'retro',
  'serialized',
  'specialfoil',
  'textless',
  'boosterfun',
];

/**
 * Is this printing a variant rather than a set's plain version? False for card
 * DBs built before `variants` existed, which is the safe failure: the user
 * still gets a real printing until the next nightly card-data update.
 */
export function isVariantPrinting(p: { variants?: readonly PrintingVariant[] }): boolean {
  return !!p.variants?.length;
}

/** One physical printing (one Scryfall card id). Drives the edition picker + collection editing. */
export interface Printing {
  scryfallId: string;
  oracleId: string;
  set: string;
  setName: string;
  collectorNumber: string;
  lang: string;
  finishes: Finish[];
  releasedAt: string; // ISO date
  /**
   * Scryfall's `promo` flag: prerelease/buy-a-box/promo-pack stampings and the
   * like. Omitted (not false) for the overwhelming majority of printings, which
   * aren't promos — same sparse convention as the back-face images. Absent on
   * card DBs built before this field, so treat missing as "not known to be a
   * promo" rather than "definitely normal". Set-wide promo products are better
   * identified by set type (see SetTypeMap); this covers the handful of promos
   * that live inside an ordinary set's own numbering.
   */
  promo?: boolean;
  /**
   * Cosmetic treatments this printing carries, in PRINTING_VARIANTS order.
   * Omitted (not empty) for the plain version of a card — same sparse
   * convention as `promo`. Absent on card DBs built before this field, so
   * treat missing as "not known to be a variant"; see isVariantPrinting.
   */
  variants?: PrintingVariant[];
  imageSmall: string | null;
  imageNormal: string | null;
  /** Back-face images for double-faced cards (absent for single-faced ones and on card DBs built before this field). */
  imageBackSmall?: string | null;
  imageBackNormal?: string | null;
}

// Prices are versioned and shipped separately from the card data: they churn
// daily (which used to force a full 14 MB re-download + re-import), while the
// card data itself only changes when Scryfall's underlying data does.

/**
 * A card row enriched with its current prices (joined at read time on the
 * client). `priceEur`/`priceUsd` are the nonfoil prices; the foil/etched
 * variants are present when the price artifact carries them (`priceHasFoil`),
 * and consumers pick the right one for an entry's finish via `pricedForFinish`.
 */
export type Priced<T> = T & {
  priceEur: number | null;
  priceUsd: number | null;
  priceEurFoil?: number | null;
  priceUsdFoil?: number | null;
  priceUsdEtched?: number | null;
  /** True when the price artifact this row was joined against carried foil slots. */
  priceHasFoil?: boolean;
};

/**
 * scryfallId → price tuple `[eur, usd, eurFoil, usdFoil, usdEtched]`. Trailing
 * nulls are trimmed, so a nonfoil-only card is just `[eur, usd]`; a tuple
 * longer than 2 means foil/etched prices are authoritative (a null slot then
 * means "no such price", not "unknown"). Scryfall has no EUR etched price, so
 * etched EUR reuses the foil EUR. Entries with every price null are omitted.
 */
export type PriceMap = Record<string, PriceTuple>;

/** `[eur, usd, eurFoil?, usdFoil?, usdEtched?]` — see PriceMap. */
export type PriceTuple =
  | [number | null, number | null]
  | [number | null, number | null, number | null]
  | [number | null, number | null, number | null, number | null]
  | [number | null, number | null, number | null, number | null, number | null];

/** One stored shard of the price map (sharded by first hex char of scryfallId). */
export interface PriceShard {
  key: string;
  prices: PriceMap;
}

/** Served alongside the slim artifacts; drives DB-refresh + app-update prompts (beta plan §3.1). */
export interface CardDbManifest {
  /**
   * Legacy card-DB version = Scryfall bulk `updated_at`. Pre-chunking clients
   * key their full re-download off this; new clients use `v2`.
   */
  cardDbVersion: string;
  /** Latest published app build version; client compares to its embedded version. */
  latestAppVersion: string;
  /** Optional hard floor: clients below this get the trade view blocked. */
  minSupportedVersion?: string;
  /**
   * Legacy whole-file artifacts (prices embedded), for clients older than the
   * chunked scheme (v0.45). No longer emitted: prices ride inside them, so they
   * churned in full every night — ~14 MB republished daily for a client
   * generation that no longer exists.
   */
  artifacts?: {
    oracle: CardDbArtifactMeta;
    printings: CardDbArtifactMeta;
  };
  /** ISO timestamp prices were captured; shown as "prices updated <date>". */
  pricesUpdatedAt: string;
  /** Chunked artifacts + separate prices: clients download only what changed. */
  v2?: {
    /** Identity of the price-less card data (hash over the chunk hashes). */
    dataVersion: string;
    chunks: {
      oracle: CardDbChunkMeta[];
      printings: CardDbChunkMeta[];
    };
    prices: CardDbArtifactMeta;
    /**
     * Sealed products expanded against this build's printings. Lazily fetched
     * by the client only when the "Add sealed product" UI opens. Absent on
     * builds made before the feature (and on runs where the MTGJSON fetch fails).
     */
    sealed?: CardDbArtifactMeta;
    /**
     * USD market prices for the sealed products above, keyed by product id.
     * Split out because it churns daily while the catalog doesn't. Absent when
     * the TCGplayer price fetch fails — the catalog still works, just priceless.
     */
    sealedPrices?: CardDbArtifactMeta;
    /**
     * Set code → Scryfall set type, for telling a normal set apart from a promo
     * product, Secret Lair, token sheet or memorabilia set. Tiny (~4 KB gzipped
     * for every set ever printed) and fetched lazily like `sealed`. Absent on
     * builds made before the preferred-printing setting existed.
     */
    sets?: CardDbArtifactMeta;
    /**
     * The oracle-tag vocabulary the numbers in `OracleCard.tags` index into.
     * Its own artifact because it's per-vocabulary, not per-card, and tiny
     * (~25 KB gzipped for every tag Scryfall has). Fetched lazily like `sets`.
     * Absent on builds made before `otag:` search existed, and on runs where
     * the tag fetch failed — in which case `otag:` simply finds nothing.
     */
    tags?: CardDbArtifactMeta;
  };
}

/**
 * One oracle tag, positional to keep the artifact small: `[slug]`, or
 * `[slug, parentIndices]`, or `[slug, parentIndices, aliasSlugs]`. The array's
 * own index is what `OracleCard.tags` refers to.
 *
 * Parents matter more than they look. Scryfall's tags are a hierarchy and a
 * search matches the whole subtree: `otag:removal` finds 6,690 cards even
 * though the `removal` tag itself is tagged on exactly zero — every hit comes
 * from one of its 55 descendants. Drop the edges and the broadest, most useful
 * tags all return nothing.
 */
export type OracleTagEntry =
  | [slug: string]
  | [slug: string, parents: number[]]
  | [slug: string, parents: number[], aliases: string[]];

/** The whole tag vocabulary, indexed by the numbers in `OracleCard.tags`. */
export type OracleTagDictionary = OracleTagEntry[];

/**
 * Set code → Scryfall `set_type`. The client uses this to resolve the "latest
 * non-promo printing" preference; see PROMO_SET_TYPES.
 */
export type SetTypeMap = Record<string, string>;

/**
 * Set types whose printings are promos or novelties rather than a normal
 * release: promo packs and judge/FNM foils (`promo`), Secret Lair and other
 * boxed oddities (`box`), token sheets, oversized/art-series memorabilia,
 * premium inserts like Kaladesh Inventions (`masterpiece`), Un-sets (`funny`),
 * and the digital-only or novelty remainder.
 *
 * A denylist rather than an allowlist on purpose: if Scryfall adds a set type we
 * haven't seen, treating it as a normal set is the safer failure — the user
 * still gets a real printing, just possibly a promo one.
 */
export const PROMO_SET_TYPES: ReadonlySet<string> = new Set([
  'promo',
  'token',
  'memorabilia',
  'box',
  'funny',
  'masterpiece',
  'minigame',
  'vanguard',
  'treasure_chest',
  'arsenal',
  'spellbook',
  'alchemy',
]);

/** One chunk of an artifact: all rows whose id starts with `key` (one hex char). */
export interface CardDbChunkMeta extends CardDbArtifactMeta {
  key: string;
}

// --- Sealed products (see sealed-products feature) -------------------------
// Every sealed product MTGJSON knows: precon decks, Secret Lairs and gift boxes
// (whose contents are fixed, so the client can add "one of everything in this
// product" to a collection) *and* booster boxes, displays and packs (whose
// contents are random, so all the client can do is record that you own the
// unopened box). Shipped as a lazily-fetched artifact keyed off the card-DB
// `dataVersion` — the scryfallIds only make sense against that build's
// printings. Prices ride in a separate artifact; see SealedPriceMap.

/** One resolved card slot in a sealed product. */
export interface SealedCardRef {
  scryfallId: string;
  qty: number;
  finish: Finish;
}

/**
 * Marketplace ids for a sealed product, straight from MTGJSON. `tcgplayer` is
 * both the box shot (their CDN serves product photos off it, keylessly) and the
 * USD price key; the others are kept for future price sources. Coverage is
 * uneven — cases and oddities often carry only one or two.
 */
export interface SealedIdentifiers {
  tcgplayer?: string;
  cardKingdom?: string;
  /** Cardmarket. */
  mcm?: string;
}

/** A sealed product and whatever of its contents we can pin down. */
export interface SealedProduct {
  /** MTGJSON product uuid — stable id for caching/selection. */
  id: string;
  name: string;
  /** MTGJSON category (e.g. 'deck', 'box_set', 'bundle') — for grouping/labels. */
  category?: string;
  /** MTGJSON subtype (e.g. 'commander', 'planeswalker') — for labels. */
  subtype?: string;
  /** Set code (lowercased) the product belongs to. */
  set: string;
  setName?: string;
  /** ISO release date, when known. */
  releaseDate?: string;
  /**
   * Deterministic cards this product contains (deduped by scryfallId+finish).
   * Empty for a pure booster box or pack — everything in it is random, so the
   * only thing the client can offer is adding it unopened.
   */
  cards: SealedCardRef[];
  /** Count of random components (booster packs / variable) omitted from `cards`. */
  omittedRandom?: number;
  /** Count of referenced cards that could not be matched to a printing in this build. */
  unresolved?: number;
  /** Marketplace ids; absent when MTGJSON lists none. */
  identifiers?: SealedIdentifiers;
}

/**
 * `[usd, eur]` for one sealed product; a trailing null is trimmed, so a
 * USD-only product is just `[usd]`. Mirrors PriceTuple's shape and reason.
 */
export type SealedPriceTuple = [number | null] | [number | null, number | null];

/**
 * Sealed product id (the MTGJSON uuid, i.e. `SealedProduct.id`) → its prices.
 * Shipped separately from the catalog for the same reason card prices are:
 * prices churn daily while the product list barely moves, and a combined
 * artifact would re-download in full every night.
 *
 * Two sources, because no single one covers both markets: TCGplayer market
 * prices via TCGCSV for USD, and Cardmarket's own published price guide for
 * EUR. Neither MTGJSON nor Scryfall prices sealed product at all — MTGJSON's
 * feed is singles-only and Scryfall has no sealed object. A product may have
 * one, both or neither, so consumers must handle a missing side.
 */
export type SealedPriceMap = Record<string, SealedPriceTuple>;

export interface CardDbArtifactMeta {
  url: string;
  bytes: number;
  /** Hex sha256 of the uncompressed JSON, for integrity + change detection. */
  sha256: string;
  /** Number of entries, for the download progress bar. */
  count: number;
}
