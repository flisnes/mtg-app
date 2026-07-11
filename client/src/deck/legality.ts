import type { Color, DeckBoard, DeckFormat, Format, OracleCard } from '@mtg/shared';

// Deck legality checking. Covers per-card format legality (banned / not-legal /
// restricted), the common construction rules (deck size, copy limits, singleton
// for Commander), Commander color identity against the command zone, partner
// pairing (Partner, Partner with, Partner—restriction, Friends forever,
// Backgrounds, Doctor's companion), and companion deckbuilding restrictions.

interface FormatRule {
  label: string;
  /** Minimum mainboard size (constructed). */
  minMain?: number;
  /** Exact total deck size incl. command zone (Commander = 100). */
  exactTotal?: number;
  maxCopies?: number;
  maxSideboard?: number;
  /** Requires a commander in the command zone (and enforces color identity). */
  commander?: boolean;
}

const RULES: Record<DeckFormat, FormatRule> = {
  casual: { label: 'Casual' },
  standard: { label: 'Standard', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  pioneer: { label: 'Pioneer', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  modern: { label: 'Modern', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  legacy: { label: 'Legacy', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  vintage: { label: 'Vintage', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  pauper: { label: 'Pauper', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  commander: { label: 'Commander', exactTotal: 100, maxCopies: 1, commander: true },
};

export function formatLabel(format: DeckFormat | undefined): string {
  return RULES[format ?? 'casual']?.label ?? 'Casual';
}

/** Legendary creature, or a card whose text grants commander-hood ("can be your commander"). */
export function canBeCommander(oracle: OracleCard): boolean {
  if (/\bLegendary\b/.test(oracle.typeLine) && /\bCreature\b/.test(oracle.typeLine)) return true;
  return !!oracle.oracleText && /can be your commander/i.test(oracle.oracleText);
}

// ---- Two-card command zones ----
// A keyword line like "Partner" may carry reminder text in parens; "Partner
// with Name" and "Partner—Restriction" must not be mistaken for it.

const text = (o: OracleCard) => o.oracleText ?? '';

const hasPlainPartner = (o: OracleCard) => /^Partner(?: *\(|$)/m.test(text(o));
const hasFriendsForever = (o: OracleCard) => /^Friends forever/m.test(text(o));
const hasDoctorsCompanion = (o: OracleCard) => /^Doctor's companion/m.test(text(o));
const hasChooseABackground = (o: OracleCard) => /Choose a Background/.test(text(o));
const isBackground = (o: OracleCard) => /\bBackground\b/.test(o.typeLine);
const isDoctor = (o: OracleCard) => /\bTime Lord\b/.test(o.typeLine) && /\bDoctor\b/.test(o.typeLine);

function partnerWithName(o: OracleCard): string | null {
  const m = /^Partner with ([^(\n]+)/m.exec(text(o));
  return m ? m[1]!.trim() : null;
}

/** "Partner—Survivors" and friends: both cards must carry the same restriction. */
function restrictedPartnerLabel(o: OracleCard): string | null {
  const m = /^Partner *[—–-] *([^(\n]+)/m.exec(text(o));
  return m ? m[1]!.trim() : null;
}

export function isValidCommanderPair(a: OracleCard, b: OracleCard): boolean {
  if (hasPlainPartner(a) && hasPlainPartner(b)) return true;
  if (partnerWithName(a) === b.name && partnerWithName(b) === a.name) return true;
  if (hasFriendsForever(a) && hasFriendsForever(b)) return true;
  const ra = restrictedPartnerLabel(a);
  if (ra !== null && ra === restrictedPartnerLabel(b)) return true;
  if (hasChooseABackground(a) && isBackground(b)) return true;
  if (hasChooseABackground(b) && isBackground(a)) return true;
  if (isDoctor(a) && hasDoctorsCompanion(b)) return true;
  if (isDoctor(b) && hasDoctorsCompanion(a)) return true;
  return false;
}

// ---- Companions ----
// The companion starts the game outside the deck — in this model, in the
// sideboard — so it is checked against the starting deck (main + command zone)
// without being part of it. Any sideboard card with a Companion ability is
// treated as the deck's chosen companion.

const COMPANION_RE = /^Companion *[—–-] /m;

interface StartingDeck {
  /** Main + command zone slots whose oracle data is present. */
  cards: Array<{ qty: number; oracle: OracleCard }>;
  mainCount: number;
  rule: FormatRule;
}

const isLandCard = (o: OracleCard) => /\bLand\b/.test(o.typeLine);
const isPermanentCard = (o: OracleCard) => /\b(Creature|Artifact|Enchantment|Land|Planeswalker|Battle)\b/.test(o.typeLine);

/** Per-companion deckbuilding restriction → description of the first violation, or null. */
const COMPANION_CHECKS: Record<string, (deck: StartingDeck) => string | null> = {
  'Gyruda, Doom of Depths': ({ cards }) => {
    const bad = cards.find(({ oracle }) => oracle.cmc % 2 !== 0);
    return bad ? `${bad.oracle.name} has an odd mana value` : null;
  },
  'Jegantha, the Wellspring': ({ cards }) => {
    const repeats = (cost: string) => {
      const seen = new Set<string>();
      for (const sym of cost.match(/\{[^}]+\}/g) ?? []) {
        if (seen.has(sym)) return true;
        seen.add(sym);
      }
      return false;
    };
    const bad = cards.find(({ oracle }) => (oracle.manaCost ?? '').split(' // ').some(repeats));
    return bad ? `${bad.oracle.name} repeats a mana symbol in its cost` : null;
  },
  'Kaheera, the Orphanguard': ({ cards }) => {
    const bad = cards.find(
      ({ oracle }) =>
        /\bCreature\b/.test(oracle.typeLine) &&
        !/\b(Cat|Elemental|Nightmare|Dinosaur|Beast)\b/.test(oracle.typeLine) &&
        !/\bchangeling\b/i.test(text(oracle)),
    );
    return bad ? `${bad.oracle.name} isn't a Cat, Elemental, Nightmare, Dinosaur, or Beast` : null;
  },
  'Keruga, the Macrosage': ({ cards }) => {
    const bad = cards.find(({ oracle }) => !isLandCard(oracle) && oracle.cmc < 3);
    return bad ? `${bad.oracle.name} has mana value less than 3` : null;
  },
  'Lurrus of the Dream-Den': ({ cards }) => {
    const bad = cards.find(({ oracle }) => isPermanentCard(oracle) && oracle.cmc > 2);
    return bad ? `${bad.oracle.name} is a permanent with mana value greater than 2` : null;
  },
  'Lutri, the Spellchaser': ({ cards }) => {
    const counts = new Map<string, number>();
    for (const { qty, oracle } of cards) {
      if (!/\b(Instant|Sorcery)\b/.test(oracle.typeLine)) continue;
      const n = (counts.get(oracle.name) ?? 0) + qty;
      if (n > 1) return `more than one copy of ${oracle.name}`;
      counts.set(oracle.name, n);
    }
    return null;
  },
  'Obosh, the Preypiercer': ({ cards }) => {
    const bad = cards.find(({ oracle }) => !isLandCard(oracle) && oracle.cmc % 2 === 0);
    return bad ? `${bad.oracle.name} has an even mana value` : null;
  },
  'Umori, the Collector': ({ cards }) => {
    const TYPES = ['Creature', 'Artifact', 'Enchantment', 'Instant', 'Sorcery', 'Planeswalker', 'Battle'];
    let shared: string[] | null = null;
    for (const { oracle } of cards) {
      if (isLandCard(oracle)) continue;
      const mine = TYPES.filter((t) => new RegExp(`\\b${t}\\b`).test(oracle.typeLine));
      shared = shared === null ? mine : shared.filter((t) => mine.includes(t));
      if (shared.length === 0) return `the nonland cards don't all share a card type (${oracle.name} breaks the match)`;
    }
    return null;
  },
  'Yorion, Sky Nomad': ({ mainCount, rule }) => {
    if (rule.exactTotal != null) return `${rule.label} decks are exactly ${rule.exactTotal} cards, so the "+20 over minimum" requirement can't be met`;
    if (rule.minMain != null && mainCount < rule.minMain + 20) return `the mainboard needs at least ${rule.minMain + 20} cards (20 over minimum)`;
    return null;
  },
  'Zirda, the Dawnwaker': ({ cards }) => {
    // Heuristic: an activated ability shows as "cost: effect" or a keyword
    // activated ability; basic lands qualify via their intrinsic mana ability.
    const KEYWORDS = /\b(equip|cycling|crew|level up|reconfigure|unearth|fortify|outlast|adapt|monstrosity|embalm|eternalize)\b/i;
    const bad = cards.find(({ oracle }) => {
      if (!isPermanentCard(oracle) || /\bBasic\b/.test(oracle.typeLine)) return false;
      const t = text(oracle);
      return !t.includes(':') && !KEYWORDS.test(t);
    });
    return bad ? `${bad.oracle.name} is a permanent with no activated ability` : null;
  },
};

const COLOR_NAMES: Record<Color, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

function describeIdentity(identity: ReadonlySet<Color>): string {
  if (identity.size === 0) return 'colorless';
  return [...identity].map((c) => COLOR_NAMES[c]).join('/');
}

export interface LegalityCard {
  oracleId: string;
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

export interface LegalityReport {
  /** false for Casual (no checks run). */
  checked: boolean;
  legal: boolean;
  problems: string[];
  /** oracleId → short reason, for per-card markers. */
  issues: Map<string, string>;
}

export function checkDeckLegality(format: DeckFormat | undefined, cards: LegalityCard[]): LegalityReport {
  const fmt = format ?? 'casual';
  const rule = RULES[fmt];
  if (fmt === 'casual') return { checked: false, legal: true, problems: [], issues: new Map() };
  const key = fmt as Format;

  const problems: string[] = [];
  const issues = new Map<string, string>();

  // Aggregate quantities per oracle card across boards.
  const agg = new Map<string, { qty: number; oracle?: OracleCard }>();
  let mainCount = 0;
  let sideCount = 0;
  let commanderCount = 0;
  for (const c of cards) {
    if (c.board === 'main') mainCount += c.quantity;
    else if (c.board === 'side') sideCount += c.quantity;
    else commanderCount += c.quantity;
    const a = agg.get(c.oracleId) ?? { qty: 0, oracle: c.oracle };
    a.qty += c.quantity;
    a.oracle = c.oracle ?? a.oracle;
    agg.set(c.oracleId, a);
  }

  let missingData = false;
  for (const [oracleId, { qty, oracle }] of agg) {
    if (!oracle) continue;
    const name = oracle.name;
    const isBasic = /\bBasic\b/.test(oracle.typeLine);
    const status = oracle.legalities?.[key];

    if (!status) {
      missingData = true;
      continue;
    }
    if (status === 'banned') {
      problems.push(`${name} is banned in ${rule.label}.`);
      issues.set(oracleId, 'banned');
    } else if (status === 'not_legal') {
      problems.push(`${name} is not legal in ${rule.label}.`);
      issues.set(oracleId, 'not legal');
    } else if (status === 'restricted' && qty > 1) {
      problems.push(`${name} is restricted (max 1) in ${rule.label}.`);
      issues.set(oracleId, 'restricted');
    } else if (rule.maxCopies && !isBasic && status !== 'restricted' && qty > rule.maxCopies) {
      problems.push(`${qty}× ${name} exceeds the ${rule.maxCopies}-copy limit.`);
      issues.set(oracleId, `max ${rule.maxCopies}`);
    }
  }

  let commanderIdentity: Set<Color> | null = null;
  if (rule.commander) {
    const commanders = cards.filter((c) => c.board === 'commander');
    if (commanderCount === 0) {
      problems.push('No commander — mark a legendary creature as your commander.');
    } else if (commanderCount > 2) {
      problems.push(`${commanderCount} commanders; a deck has one (or two that can share the command zone).`);
    } else if (commanderCount === 2 && commanders.length === 2) {
      // Two copies of one card (commanders.length === 1) is left to the
      // singleton check; here both slots exist, so validate the pairing.
      const [a, b] = commanders;
      if (a!.oracle && b!.oracle && !isValidCommanderPair(a!.oracle, b!.oracle)) {
        problems.push(
          `${a!.oracle.name} and ${b!.oracle.name} can't share the command zone (needs Partner, Friends forever, a Background, or a Doctor pairing).`,
        );
        issues.set(a!.oracleId, 'invalid pair');
        issues.set(b!.oracleId, 'invalid pair');
      }
    } else if (commanderCount === 1) {
      const c = commanders[0]!;
      if (c.oracle && !canBeCommander(c.oracle)) {
        problems.push(`${c.oracle.name} can't be your commander (not a legendary creature).`);
        issues.set(c.oracleId, 'invalid commander');
      }
    }

    // Color identity: every card must fit within the commanders' combined
    // identity. Sideboard is treated as scratch space and skipped (companions
    // are checked separately below).
    if (commanderCount > 0 && commanders.every((c) => c.oracle)) {
      commanderIdentity = new Set<Color>(commanders.flatMap((c) => c.oracle!.colorIdentity));
      let offenders = 0;
      for (const c of cards) {
        if (c.board !== 'main' || !c.oracle) continue;
        if (c.oracle.colorIdentity.some((col) => !commanderIdentity!.has(col))) {
          offenders += 1;
          issues.set(c.oracleId, 'outside identity');
          if (offenders <= 5) problems.push(`${c.oracle.name} is outside the commander's ${describeIdentity(commanderIdentity)} identity.`);
        }
      }
      if (offenders > 5) problems.push(`…and ${offenders - 5} more cards outside the commander's color identity.`);
    }
  }

  // Companions: a sideboard card with a Companion ability is validated as the
  // deck's chosen companion — color identity (Commander) plus its deckbuilding
  // restriction over the starting deck it would accompany.
  const startingDeck: StartingDeck = {
    cards: cards.filter((c) => c.board !== 'side' && c.oracle).map((c) => ({ qty: c.quantity, oracle: c.oracle! })),
    mainCount,
    rule,
  };
  for (const c of cards) {
    if (c.board !== 'side' || !c.oracle || !COMPANION_RE.test(text(c.oracle))) continue;
    if (commanderIdentity && c.oracle.colorIdentity.some((col) => !commanderIdentity!.has(col))) {
      problems.push(`${c.oracle.name} (companion) is outside the commander's ${describeIdentity(commanderIdentity)} identity.`);
      issues.set(c.oracleId, 'outside identity');
    }
    const detail = COMPANION_CHECKS[c.oracle.name]?.(startingDeck);
    if (detail) {
      problems.push(`${c.oracle.name}'s companion requirement isn't met: ${detail}.`);
      if (!issues.has(c.oracleId)) issues.set(c.oracleId, 'companion unmet');
    }
  }

  // The sideboard is scratch space in Commander; only main + command zone count.
  const deckTotal = mainCount + commanderCount;
  if (rule.exactTotal != null) {
    if (deckTotal < rule.exactTotal) problems.push(`Deck has ${deckTotal} cards; ${rule.label} needs ${rule.exactTotal}.`);
    else if (deckTotal > rule.exactTotal) problems.push(`Deck has ${deckTotal} cards; ${rule.label} allows ${rule.exactTotal}.`);
  } else if (rule.minMain != null && mainCount < rule.minMain) {
    problems.push(`Mainboard has ${mainCount} cards; ${rule.label} needs at least ${rule.minMain}.`);
  }
  if (rule.maxSideboard != null && sideCount > rule.maxSideboard) {
    problems.push(`Sideboard has ${sideCount} cards; max ${rule.maxSideboard}.`);
  }
  if (missingData) problems.push('Some cards have no legality data yet — refresh the card database from About.');

  return { checked: true, legal: problems.length === 0, problems, issues };
}
