import { FORMATS, type Color, type Format, type OracleCard, type Rarity } from '@mtg/shared';

// Scryfall-style search syntax. A query is whitespace-separated terms, ANDed
// together; `-` prefixes negate a term. Bare words (or quoted phrases) match
// the card name; `field:value` terms match other card fields:
//
//   o:"draw a card"   oracle text (~ stands for the card's own name)
//   t:legendary       type line
//   c:ug  c<=w  c:m   colors (: means "at least"; m/multicolor, c/colorless)
//   id<=esper-ish     color identity (: means "at most", Commander-style)
//   r:rare  r>=rare   rarity
//   mv:2  cmc<=3      mana value
//   f:modern          legal in format (restricted counts as legal)
//
// Unknown or malformed terms fall back to plain name text so a typo narrows
// the search visibly instead of being silently dropped.

export type NumOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

export type QueryTerm = { negate: boolean } & (
  | { kind: 'name'; value: string }
  | { kind: 'oracle'; value: string }
  | { kind: 'type'; value: string }
  | { kind: 'colorset'; field: 'colors' | 'colorIdentity'; op: NumOp; set: Color[] | null; special: 'multicolor' | 'colorless' | null }
  | { kind: 'rarity'; op: NumOp; rank: number }
  | { kind: 'cmc'; op: NumOp; value: number }
  | { kind: 'format'; format: Format }
);

export interface ParsedQuery {
  terms: QueryTerm[];
  /** Non-negated name terms joined for ranking (exact/prefix beats scattered words). */
  namePhrase: string;
  hasNameTerms: boolean;
}

/** The pre-computed per-card strings a query term matches against. */
export interface SearchableEntry {
  card: OracleCard;
  normName: string;
  lowerType: string;
  normOracle: string;
  /** Oracle text with the card's own (face) names replaced by `~`. */
  normOracleTilde: string;
}

/** Diacritic-insensitive, lowercased (strips combining marks after NFD). */
const COMBINING_MARKS = /\p{M}/gu;
export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

const STRING_FIELDS: Record<string, 'name' | 'oracle' | 'type'> = {
  n: 'name',
  name: 'name',
  o: 'oracle',
  oracle: 'oracle',
  text: 'oracle',
  t: 'type',
  type: 'type',
};
const COLOR_FIELDS: Record<string, 'colors' | 'colorIdentity'> = {
  c: 'colors',
  color: 'colors',
  colors: 'colors',
  id: 'colorIdentity',
  identity: 'colorIdentity',
  ci: 'colorIdentity',
};
const CMC_FIELDS = new Set(['cmc', 'mv', 'manavalue']);
const FORMAT_FIELDS = new Set(['f', 'format', 'legal']);
const RARITY_FIELDS = new Set(['r', 'rarity']);

const KNOWN_FIELDS = new Set([
  ...Object.keys(STRING_FIELDS),
  ...Object.keys(COLOR_FIELDS),
  ...CMC_FIELDS,
  ...FORMAT_FIELDS,
  ...RARITY_FIELDS,
]);

const COLOR_LETTERS: Record<string, Color> = { w: 'W', u: 'U', b: 'B', r: 'R', g: 'G' };
const COLOR_WORDS: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

// Scryfall's rarity ordering for comparisons (r>=rare etc.).
const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, special: 3, mythic: 4, bonus: 5 };
const RARITY_ALIASES: Record<string, Rarity> = { c: 'common', u: 'uncommon', r: 'rare', s: 'special', m: 'mythic', b: 'bonus' };

const FORMAT_ALIASES: Record<string, Format> = { edh: 'commander' };

// token = [-]  [field  op]  quoted-or-bare-value
const TOKEN = /(-)?(?:([a-zA-Z]+)(!=|>=|<=|>|<|:|=))?("([^"]*)"|[^\s"]+)/g;

export function parseSearchQuery(raw: string): ParsedQuery {
  // Close an unfinished quote so a half-typed phrase parses as that phrase.
  let source = raw;
  if ((raw.match(/"/g)?.length ?? 0) % 2 === 1) source += '"';

  const terms: QueryTerm[] = [];
  for (const m of source.matchAll(TOKEN)) {
    const negate = !!m[1];
    const field = m[2]?.toLowerCase();
    const op = m[3];
    const value = m[5] ?? m[4]!;

    // A known field with the value still unwritten ("o:", "mv>=") matches
    // everything rather than becoming name text mid-keystroke.
    if (!field) {
      const half = /^([a-zA-Z]+)(!=|>=|<=|>|<|:|=)$/.exec(value);
      if (half && KNOWN_FIELDS.has(half[1]!.toLowerCase())) continue;
    }

    const term = field && op ? fieldTerm(field, op, value, negate) : null;
    if (term) terms.push(term);
    else if (!field) terms.push({ kind: 'name', value: normalize(value), negate });
    else terms.push({ kind: 'name', value: normalize(m[0]!.replace(/^-/, '').replaceAll('"', '')), negate });
  }

  const nameValues = terms.filter((t) => t.kind === 'name' && !t.negate).map((t) => (t as { value: string }).value);
  return { terms, namePhrase: nameValues.join(' '), hasNameTerms: nameValues.length > 0 };
}

function fieldTerm(field: string, op: string, value: string, negate: boolean): QueryTerm | null {
  const stringKind = STRING_FIELDS[field];
  if (stringKind) {
    if (op !== ':' && op !== '=') return null;
    return { kind: stringKind, value: normalize(value), negate };
  }

  const colorField = COLOR_FIELDS[field];
  if (colorField) {
    const spec = parseColorValue(value);
    if (!spec) return null;
    // Scryfall: c:RG means "at least red and green"; id:RG means "fits in a
    // red-green identity" (at most those colors).
    const numOp: NumOp = op === ':' ? (colorField === 'colors' ? '>=' : '<=') : (op as NumOp);
    return { kind: 'colorset', field: colorField, op: numOp, ...spec, negate };
  }

  if (CMC_FIELDS.has(field)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return { kind: 'cmc', op: op === ':' ? '=' : (op as NumOp), value: n, negate };
  }

  if (RARITY_FIELDS.has(field)) {
    const v = value.toLowerCase();
    const rarity = RARITY_ALIASES[v] ?? (v in RARITY_RANK ? (v as Rarity) : undefined);
    if (!rarity) return null;
    return { kind: 'rarity', op: op === ':' ? '=' : (op as NumOp), rank: RARITY_RANK[rarity], negate };
  }

  if (FORMAT_FIELDS.has(field)) {
    if (op !== ':' && op !== '=') return null;
    const v = value.toLowerCase();
    const format = FORMAT_ALIASES[v] ?? (FORMATS.includes(v as Format) ? (v as Format) : undefined);
    if (!format) return null;
    return { kind: 'format', format, negate };
  }

  return null;
}

function parseColorValue(value: string): { set: Color[] | null; special: 'multicolor' | 'colorless' | null } | null {
  const v = value.toLowerCase();
  if (v === 'c' || v === 'colorless') return { set: null, special: 'colorless' };
  if (v === 'm' || v === 'multi' || v === 'multicolor' || v === 'multicolored') return { set: null, special: 'multicolor' };
  const word = COLOR_WORDS[v];
  if (word) return { set: [word], special: null };
  const set = new Set<Color>();
  for (const ch of v) {
    const c = COLOR_LETTERS[ch];
    if (!c) return null;
    set.add(c);
  }
  return set.size ? { set: [...set], special: null } : null;
}

// ---- Matching ----

export function matchesQuery(entry: SearchableEntry, q: ParsedQuery): boolean {
  for (const t of q.terms) {
    if (termMatches(entry, t) === t.negate) return false;
  }
  return true;
}

function termMatches(entry: SearchableEntry, t: QueryTerm): boolean {
  switch (t.kind) {
    case 'name':
      return entry.normName.includes(t.value);
    case 'oracle':
      return entry.normOracle.includes(t.value) || entry.normOracleTilde.includes(t.value);
    case 'type':
      return entry.lowerType.includes(t.value);
    case 'colorset': {
      const colors = entry.card[t.field];
      if (t.special === 'colorless') return t.op === '!=' ? colors.length > 0 : colors.length === 0;
      if (t.special === 'multicolor') return t.op === '!=' ? colors.length <= 1 : colors.length > 1;
      return matchColorSet(colors, t.op, t.set!);
    }
    case 'rarity':
      return compareNum(RARITY_RANK[entry.card.rarity], t.op, t.rank);
    case 'cmc':
      return compareNum(entry.card.cmc, t.op, t.value);
    case 'format': {
      const status = entry.card.legalities?.[t.format];
      return status === 'legal' || status === 'restricted';
    }
  }
}

function matchColorSet(cardColors: readonly Color[], op: NumOp, set: Color[]): boolean {
  const have = new Set(cardColors);
  const allWanted = set.every((c) => have.has(c)); // card ⊇ query
  const onlyWanted = cardColors.every((c) => set.includes(c)); // card ⊆ query
  switch (op) {
    case '=':
      return allWanted && onlyWanted;
    case '!=':
      return !(allWanted && onlyWanted);
    case '>=':
      return allWanted;
    case '<=':
      return onlyWanted;
    case '>':
      return allWanted && !onlyWanted;
    case '<':
      return onlyWanted && !allWanted;
  }
}

function compareNum(a: number, op: NumOp, b: number): boolean {
  switch (op) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
  }
}
