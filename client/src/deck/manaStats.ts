import { decodeManaProfile, type DeckBoard, type DeckFormat, type OracleCard } from '@mtg/shared';

// Deck mana statistics: the curve, what the lands cost you in tempo, and
// whether there are enough of them. Pure arithmetic over the deck's rows and
// the per-card mana profile the pipeline derives (OracleCard.mana / .produces);
// no probability, no simulation, nothing async.
//
// Every number here is a *goldfish* number: it assumes you make a land drop
// every turn and nobody interacts with you. That is the honest scope of
// arithmetic, and the UI says so rather than implying more.

/** Bucket 7 holds everything that costs 7 or more, which is where the tail goes. */
export const CURVE_MAX = 7;

/** Turns the tapland tax is measured over — the window where a turn of mana still decides games. */
export const TAX_TURNS = 4;

export interface CurveBucket {
  /** Mana value; CURVE_MAX means "this much or more". */
  mv: number;
  count: number;
}

export type LandTone = 'ok' | 'light' | 'heavy';

export interface LandVerdict {
  /** Karsten's rule of thumb, rounded to whole lands. */
  recommended: number;
  /** Lands held minus lands suggested. */
  diff: number;
  tone: LandTone;
  /** One clause, for the inline line under the legality panel. */
  short: string;
  /** The full sentence, for the sheet. */
  text: string;
}

export interface DeckManaStats {
  /** Cards counted: mainboard plus command zone. Sideboard and tokens are out. */
  total: number;
  /** Cards with a land face, modal backs included. */
  lands: number;
  /** Of those, the ones whose front face is a spell — they are in `spells` too. */
  modalLands: number;
  spells: number;
  curve: CurveBucket[];
  /** Mean mana value across the spells. */
  avgMv: number;
  tappedAlways: number;
  tappedMaybe: number;
  /** Expected mana lost to lands entering tapped over the first TAX_TURNS turns. */
  taplandTax: number;
  /** Ramp costing 2 or less: Karsten's correction term. */
  cheapRamp: number;
  /** Cards whose mana output depends on the board, so we refuse to put a number on it. */
  unknown: number;
  land: LandVerdict;
  /**
   * False when the card DB predates the mana profile (v0.148.2), which reads
   * identically to "no tapped lands" and isn't. The tapland section hides
   * rather than reporting a confident zero.
   */
  hasManaData: boolean;
}

export interface StatsRow {
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

const faces = (typeLine: string) => typeLine.split('//').map((f) => f.trim());
const isLandFace = (face: string) => /\bLand\b/.test(face);
/** Tokens, emblems and art cards are in the list but aren't deck cards. */
const isNotACard = (o: OracleCard) => {
  const t = o.typeLine.toLowerCase();
  return t.startsWith('token') || t.includes('emblem') || t === 'card';
};

/**
 * How many lands Frank Karsten's regressions suggest for a deck of this shape:
 * a base, plus three-and-a-bit lands per point of average mana value, minus a
 * little for cheap acceleration. The Commander figure is his 99-card one; every
 * other format scales his 60-card figure by the deck's actual size, which
 * leaves a normal 60 exactly where he put it.
 *
 * He corrects for cheap card draw *and* ramp; we can see the ramp (it has a
 * mana profile) and not the draw, so the correction is slightly conservative.
 * The verdict's one-land tolerance is wider than that error.
 */
function recommendedLands(format: DeckFormat | undefined, size: number, avgMv: number, cheapRamp: number): number {
  if (format === 'commander') return 31.42 + 3.13 * avgMv - 0.28 * cheapRamp;
  return (16.35 + 3.14 * avgMv - 0.28 * cheapRamp) * (size > 0 ? size / 60 : 1);
}

function verdict(lands: number, recommended: number): LandVerdict {
  const rec = Math.round(recommended);
  const diff = lands - rec;
  // Within a land either way is inside the noise of a rule of thumb, and a tool
  // that quibbles over one land teaches you to ignore it.
  const tone: LandTone = Math.abs(diff) <= 1 ? 'ok' : diff < 0 ? 'light' : 'heavy';
  const short =
    tone === 'ok' ? 'about right for this curve' : tone === 'light' ? `${-diff} short of the curve` : `${diff} more than the curve needs`;
  const text =
    tone === 'ok'
      ? `About right. Karsten's rule of thumb puts this curve at about ${rec}.`
      : tone === 'light'
        ? `On the light side. Karsten's rule of thumb puts this curve at about ${rec}.`
        : `On the heavy side. Karsten's rule of thumb puts this curve at about ${rec}.`;
  return { recommended: rec, diff, tone, short, text };
}

/**
 * Deck stats for the mainboard and command zone. The commander counts: it is a
 * card you cast, out of a zone you always have it in, and leaving it out of a
 * 99-card deck's curve and average understates both.
 */
export function deckManaStats(rows: readonly StatsRow[], format: DeckFormat | undefined): DeckManaStats {
  const curve: CurveBucket[] = Array.from({ length: CURVE_MAX + 1 }, (_, mv) => ({ mv, count: 0 }));
  let total = 0;
  let lands = 0;
  let modalLands = 0;
  let spells = 0;
  let mvSum = 0;
  let tappedAlways = 0;
  let tappedMaybe = 0;
  let cheapRamp = 0;
  let unknown = 0;
  let profiledLands = 0;

  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o)) continue;
    const qty = r.quantity;
    total += qty;

    const parts = faces(o.typeLine);
    const landFront = isLandFace(parts[0] ?? '');
    const landAnywhere = parts.some(isLandFace);
    const profile = decodeManaProfile(o.mana);

    if (landAnywhere) {
      lands += qty;
      if (!landFront) modalLands += qty;
      if (profile?.kind === 'land') {
        profiledLands += qty;
        if (profile.tapped === 'always') tappedAlways += qty;
        else if (profile.tapped === 'maybe') tappedMaybe += qty;
      }
    }
    // A modal back is a land *and* a spell, and belongs on both sides of the
    // ledger: you can cast the front for its printed cost. The sheet says so.
    if (!landFront) {
      spells += qty;
      mvSum += o.cmc * qty;
      curve[Math.min(Math.round(o.cmc), CURVE_MAX)]!.count += qty;
      if (o.cmc <= 2 && profile && !profile.unknown && profile.kind !== 'land' && profile.kind !== 'extraland') {
        cheapRamp += qty;
      }
    }
    if (profile?.unknown) unknown += qty;
  }

  const avgMv = spells > 0 ? mvSum / spells : 0;
  // A tapland costs you a mana on the turn it enters and nothing afterwards, so
  // the tax is one turn's loss times the odds each of the first four land drops
  // is one of them. Conditional taplands are deliberately left out: a shockland
  // is untapped whenever you want it to be, and averaging that in would be the
  // kind of hidden fudge factor this whole feature exists to avoid.
  const taplandTax = lands > 0 ? (TAX_TURNS * tappedAlways) / lands : 0;

  return {
    total,
    lands,
    modalLands,
    spells,
    curve,
    avgMv,
    tappedAlways,
    tappedMaybe,
    taplandTax,
    cheapRamp,
    unknown,
    land: verdict(lands, recommendedLands(format, total, avgMv, cheapRamp)),
    hasManaData: profiledLands > 0 || lands === 0,
  };
}
