import {
  FORMATS,
  normalizeColors,
  type Color,
  type Finish,
  type Format,
  type OracleCard,
  type PrintingVariant,
  type Rarity,
} from '@mtg/shared';

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
//   cmc:even          mana value parity (even/odd)
//   mana>={2}  m:uu   mana cost symbols (: means "at least", like colors)
//   set:znr  s:znr    printed in this set (in the card search: any printing of
//                     the card; in a list of copies: the copy's own printing)
//   f:modern          legal in format (restricted counts as legal)
//   is:transform  is:reserved  is:foil  is:borderless   see IS_KEYWORDS below
//
// Terms combine like they do on Scryfall: whitespace means AND, `or` means OR
// (`and` may be spelled out too), parentheses group, and `-` negates either a
// single term or a whole group. AND binds tighter than OR, so
// `t:goblin or t:elf mv<=2` reads as `t:goblin or (t:elf and mv<=2)`.
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
  | { kind: 'cmcParity'; even: boolean }
  | { kind: 'mana'; op: NumOp; generic: number; symbols: Map<string, number> }
  | { kind: 'set'; value: string }
  | { kind: 'format'; format: Format }
  | { kind: 'is'; test: (entry: SearchableEntry) => boolean }
);

/** A term, or a boolean combination of them. */
export type QueryNode =
  | { kind: 'and'; children: QueryNode[] }
  | { kind: 'or'; children: QueryNode[] }
  | { kind: 'not'; child: QueryNode }
  | QueryTerm;

export interface ParsedQuery {
  /** The parsed expression; null when nothing in the query filters anything out. */
  root: QueryNode | null;
  /**
   * Non-negated name text for ranking (exact/prefix beats scattered words), one
   * entry per OR branch: `bolt or shock` ranks against either.
   */
  namePhrases: string[];
}

/** The pre-computed per-card strings a query term matches against. */
export interface SearchableEntry {
  card: OracleCard;
  normName: string;
  lowerType: string;
  normOracle: string;
  /** Oracle text with the card's own (face) names replaced by `~`. */
  normOracleTilde: string;
  /** Lowercased set codes this card has a printing in. Empty when the caller has no printings to offer, in which case `set:` never matches. */
  sets: ReadonlySet<string>;
  /** Finishes available across every printing (union). Empty when the caller has no printings to offer. */
  finishes: ReadonlySet<Finish>;
  /** Any printing is a promo (Scryfall's per-printing `promo` flag). */
  hasPromo: boolean;
  /** Cosmetic treatments available across every printing (union). Drives is:borderless, is:showcase, … */
  variants: ReadonlySet<PrintingVariant>;
  /** Has more than one printing. */
  reprint: boolean;
}

/** Diacritic-insensitive, lowercased (strips combining marks after NFD). */
const COMBINING_MARKS = /\p{M}/gu;
export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/**
 * Pre-normalise a card's match fields into a `SearchableEntry`. Shared by the
 * full-DB search index (search.ts) and the owned-list filters (collection /
 * wishlist), so every search bar matches identically.
 */
/** The printings-derived facts a search entry needs; absent when the caller has no printings to offer. */
export interface PrintingSummary {
  sets?: Iterable<string>;
  finishes?: Iterable<Finish>;
  hasPromo?: boolean;
  variants?: Iterable<PrintingVariant>;
  reprint?: boolean;
}

/** The printing fields an owned row carries; a sparse `Printing` is one. */
export interface RowPrinting {
  set: string;
  finishes?: readonly Finish[];
  promo?: boolean;
  variants?: readonly PrintingVariant[];
}

/**
 * The printing summary for a row of a *list of copies* — collection, tradelist,
 * wishlist, a deck/binder/box, someone's published list — where the row already
 * names the printing it's about. `set:znr` there means "this copy is from
 * Zendikar Rising", not "some printing of this card was in Zendikar Rising",
 * which is the only reading that makes sense of a list of physical cards.
 * Likewise `is:foil` matches the finish the row is in, not the finishes the
 * printing was sold in.
 *
 * Rows that pin no printing ("any printing" wishes, unpinned deck slots) can
 * only offer their finish, so `set:` correctly doesn't match them. `is:reprint`
 * never matches here either — how many times a card was printed isn't something
 * a single row knows.
 */
export function rowPrintingSummary(printing: RowPrinting | undefined, finish?: Finish): PrintingSummary {
  return {
    sets: printing ? [printing.set] : [],
    finishes: finish ? [finish] : (printing?.finishes ?? []),
    hasPromo: printing?.promo,
    variants: printing?.variants,
  };
}

export function toSearchableEntry(card: OracleCard, printings: PrintingSummary = {}): SearchableEntry {
  const normOracle = card.oracleText ? normalize(card.oracleText) : '';
  // Self-references in oracle text become ~ so o:"whenever ~ enters" works.
  let normOracleTilde = normOracle;
  if (normOracle) {
    for (const face of card.name.split(' // ')) {
      const normFace = normalize(face);
      if (normFace) normOracleTilde = normOracleTilde.split(normFace).join('~');
    }
  }
  const sets = new Set<string>();
  for (const s of printings.sets ?? []) sets.add(s.toLowerCase());
  return {
    card,
    normName: normalize(card.name),
    lowerType: card.typeLine.toLowerCase(),
    normOracle,
    normOracleTilde,
    sets,
    finishes: new Set(printings.finishes ?? []),
    hasPromo: !!printings.hasPromo,
    variants: new Set(printings.variants ?? []),
    reprint: !!printings.reprint,
  };
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
const MANA_FIELDS = new Set(['m', 'mana']);
const SET_FIELDS = new Set(['set', 's', 'e', 'edition']);
const IS_FIELDS = new Set(['is']);

const KNOWN_FIELDS = new Set([
  ...Object.keys(STRING_FIELDS),
  ...Object.keys(COLOR_FIELDS),
  ...CMC_FIELDS,
  ...FORMAT_FIELDS,
  ...RARITY_FIELDS,
  ...MANA_FIELDS,
  ...SET_FIELDS,
  ...IS_FIELDS,
]);

const COLOR_LETTERS: Record<string, Color> = { w: 'W', u: 'U', b: 'B', r: 'R', g: 'G' };
const COLOR_WORDS: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

// Scryfall's rarity ordering for comparisons (r>=rare etc.).
const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, special: 3, mythic: 4, bonus: 5 };
const RARITY_ALIASES: Record<string, Rarity> = { c: 'common', u: 'uncommon', r: 'rare', s: 'special', m: 'mythic', b: 'bonus' };

const FORMAT_ALIASES: Record<string, Format> = { edh: 'commander' };

// ---- Lexing ----

type LexToken = { t: 'lparen' | 'rparen' | 'and' | 'or' | 'not' } | { t: 'term'; term: QueryTerm };

// token = [-]  [field  op]  quoted-or-bare-value. A bare value stops at quotes
// and parens as well as whitespace, so `(t:goblin or t:elf)` lexes as a group
// rather than one term with brackets glued on.
const TOKEN = /^(-)?(?:([a-zA-Z]+)(!=|>=|<=|>|<|:|=))?("([^"]*)"|[^\s"()]+)/;
const HALF_TYPED_FIELD = /^([a-zA-Z]+)(!=|>=|<=|>|<|:|=)$/;

function lex(source: string): LexToken[] {
  const out: LexToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ t: ch === '(' ? 'lparen' : 'rparen' });
      i++;
      continue;
    }
    // `-` only negates a group here; a leading `-` on a term is part of the term.
    if (ch === '-' && source[i + 1] === '(') {
      out.push({ t: 'not' });
      i++;
      continue;
    }
    const m = TOKEN.exec(source.slice(i));
    if (!m) {
      i++; // a lone `-` or other stray punctuation with no value after it
      continue;
    }
    i += m[0].length;

    const negate = !!m[1];
    const field = m[2]?.toLowerCase();
    const op = m[3];
    const quoted = m[5] !== undefined;
    const value = m[5] ?? m[4]!;

    if (!quoted) {
      // Bare `or` / `and` are operators; quote them to search for the words.
      const word = value.toLowerCase();
      if (!field && !negate && (word === 'or' || word === 'and')) {
        out.push({ t: word });
        continue;
      }
      // A known field with the value still unwritten ("o:", "mv>=") matches
      // everything rather than becoming name text mid-keystroke.
      const half = !field && HALF_TYPED_FIELD.exec(value);
      if (half && KNOWN_FIELDS.has(half[1]!.toLowerCase())) continue;
    }

    const term = field && op ? fieldTerm(field, op, value, negate) : null;
    if (term) out.push({ t: 'term', term });
    else if (!field) out.push({ t: 'term', term: { kind: 'name', value: normalize(value), negate } });
    else
      out.push({
        t: 'term',
        term: { kind: 'name', value: normalize(m[0]!.replace(/^-/, '').replaceAll('"', '')), negate },
      });
  }
  return out;
}

// ---- Parsing ----
//
// expr := and ( 'or' and )*      and := unary+      unary := '-'? ( '(' expr ')' | term )
//
// Every rule tolerates half-typed input, because this runs on each keystroke: a
// dangling `or`, an unclosed `(`, a stray `)` and an empty group are all just
// dropped instead of failing the parse.

interface Cursor {
  toks: LexToken[];
  i: number;
}

const peek = (c: Cursor): LexToken | undefined => c.toks[c.i];

function parseOr(c: Cursor): QueryNode | null {
  const branches: QueryNode[] = [];
  const first = parseAnd(c);
  if (first) branches.push(first);
  while (peek(c)?.t === 'or') {
    c.i++;
    // A branch that filters nothing (`bolt or `, mid-typing) is dropped rather
    // than widening the whole query back to every card.
    const next = parseAnd(c);
    if (next) branches.push(next);
  }
  if (branches.length <= 1) return branches[0] ?? null;
  return { kind: 'or', children: branches };
}

function parseAnd(c: Cursor): QueryNode | null {
  const children: QueryNode[] = [];
  for (;;) {
    const t = peek(c);
    if (!t || t.t === 'or' || t.t === 'rparen') break;
    if (t.t === 'and') {
      c.i++; // explicit `and` is just a separator; whitespace already means AND
      continue;
    }
    const node = parseUnary(c);
    if (node) children.push(node);
  }
  if (children.length <= 1) return children[0] ?? null;
  return { kind: 'and', children };
}

/** Always consumes at least one token, so the AND loop can't spin. */
function parseUnary(c: Cursor): QueryNode | null {
  const t = c.toks[c.i]!;
  if (t.t === 'not') {
    c.i++;
    const child = parseUnary(c);
    return child ? { kind: 'not', child } : null;
  }
  if (t.t === 'lparen') {
    c.i++;
    const inner = parseOr(c);
    if (peek(c)?.t === 'rparen') c.i++; // an unclosed group just runs to the end
    return inner;
  }
  c.i++;
  return t.t === 'term' ? t.term : null;
}

export function parseSearchQuery(raw: string): ParsedQuery {
  // Close an unfinished quote so a half-typed phrase parses as that phrase.
  let source = raw;
  if ((raw.match(/"/g)?.length ?? 0) % 2 === 1) source += '"';

  const c: Cursor = { toks: lex(source), i: 0 };
  const parts: QueryNode[] = [];
  while (c.i < c.toks.length) {
    const before = c.i;
    const node = parseOr(c);
    if (node) parts.push(node);
    // Only a stray `)` can stop parseOr short; skip it and keep reading.
    if (c.i < c.toks.length && (c.i === before || peek(c)!.t === 'rparen')) c.i++;
  }

  const root: QueryNode | null = parts.length <= 1 ? (parts[0] ?? null) : { kind: 'and', children: parts };
  return { root, namePhrases: namePhrasesOf(root).filter(Boolean) };
}

/** Cap on the OR branches we rank against; ranking degrades, matching doesn't. */
const MAX_NAME_PHRASES = 8;

/**
 * The name text of each OR branch, joined in query order ('' when a branch has
 * none). Negated terms and anything inside a `-(…)` group don't rank.
 */
function namePhrasesOf(node: QueryNode | null): string[] {
  if (!node) return [''];
  switch (node.kind) {
    case 'not':
      return [''];
    case 'or': {
      const alts = new Set<string>();
      for (const child of node.children) for (const phrase of namePhrasesOf(child)) if (phrase) alts.add(phrase);
      return alts.size ? [...alts].slice(0, MAX_NAME_PHRASES) : [''];
    }
    case 'and': {
      let alts = [''];
      for (const child of node.children) {
        const childAlts = namePhrasesOf(child);
        const next = new Set<string>();
        for (const a of alts) for (const b of childAlts) next.add(a && b ? `${a} ${b}` : a || b);
        alts = [...next].slice(0, MAX_NAME_PHRASES);
      }
      return alts;
    }
    default:
      return [node.kind === 'name' && !node.negate ? node.value : ''];
  }
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
    const v = value.toLowerCase();
    if (v === 'even' || v === 'odd') {
      if (op !== ':' && op !== '=') return null;
      return { kind: 'cmcParity', even: v === 'even', negate };
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return { kind: 'cmc', op: op === ':' ? '=' : (op as NumOp), value: n, negate };
  }

  if (MANA_FIELDS.has(field)) {
    const want = parseManaCost(value);
    if (!want) return null;
    return { kind: 'mana', op: op === ':' ? '>=' : (op as NumOp), ...want, negate };
  }

  if (SET_FIELDS.has(field)) {
    if (op !== ':' && op !== '=') return null;
    return { kind: 'set', value: value.toLowerCase(), negate };
  }

  if (IS_FIELDS.has(field)) {
    if (op !== ':' && op !== '=') return null;
    const test = IS_KEYWORDS[value.toLowerCase()];
    if (!test) return null;
    return { kind: 'is', test, negate };
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

// One symbol per {brace group}, or shorthand for a single letter/number outside
// braces (Scryfall: "G is the same as {G}"). Numbers (bare or braced) add to
// `generic`; everything else (colors, X, hybrid like "2/W", phyrexian "W/P",
// snow "S") is counted as its own symbol, matching how mana>= actually compares
// costs: the numeral pip is a magnitude, every other symbol must be present as-is.
const MANA_TOKEN = /\{([^}]+)\}|([wubrgcxsp])|(\d+)/gi;

function parseManaCost(raw: string): { generic: number; symbols: Map<string, number> } | null {
  // Split/adventure/room cards store both faces' costs joined by " // "
  // (slimCard's oracleFields); a card's real mana value is the sum of its
  // faces (CR 202.3), so the same convention applies here.
  if (raw.includes(' // ')) {
    let generic = 0;
    const symbols = new Map<string, number>();
    for (const face of raw.split(' // ')) {
      const parsed = parseManaCost(face);
      if (!parsed) return null;
      generic += parsed.generic;
      for (const [sym, count] of parsed.symbols) symbols.set(sym, (symbols.get(sym) ?? 0) + count);
    }
    return { generic, symbols };
  }

  let generic = 0;
  const symbols = new Map<string, number>();
  let end = 0;
  for (const m of raw.matchAll(MANA_TOKEN)) {
    if (m.index !== end) return null; // a gap means an unrecognized character
    end = m.index + m[0].length;
    const token = (m[1] ?? m[2] ?? m[3])!.toUpperCase();
    if (/^\d+$/.test(token)) generic += Number(token);
    else symbols.set(token, (symbols.get(token) ?? 0) + 1);
  }
  if (end !== raw.length) return null;
  return { generic, symbols };
}

function hasAllSymbols(have: ReadonlyMap<string, number>, want: ReadonlyMap<string, number>): boolean {
  for (const [sym, count] of want) if ((have.get(sym) ?? 0) < count) return false;
  return true;
}

function manaSymbolsOf(card: OracleCard): string[] {
  const parsed = card.manaCost ? parseManaCost(card.manaCost) : null;
  return parsed ? [...parsed.symbols.keys()] : [];
}

// ---- is: keywords ----
//
// Most of these are heuristics over type line / oracle text rather than a
// Scryfall-tagged field, so an odd card can slip through the cracks — treat
// them as "close enough for search," not rules-accurate. Land archetypes and
// format-eligibility checks (commander/brawler/duelcommander) are the
// fuzziest: they don't consult a banned list, that's what f:/legal: is for.
//
// Deliberately not implemented: is:newinpauper (needs historical banlist-change
// data we don't have), is:frenchvanilla (would need a parameterized
// keyword-ability parser to avoid misfiring constantly), and the printing
// cosmetics that say nothing about which copy you'd want to own (is:hires,
// is:default, is:atypical, is:oversized, is:universesbeyond). The ones that do
// — borderless, showcase, extended art, retro frames, chase foils — ride on
// Printing.variants; see the variant block at the end of IS_KEYWORDS.

const BASIC_LAND_TYPES = ['plains', 'island', 'swamp', 'mountain', 'forest'];

function basicLandTypeCount(lowerType: string): number {
  return BASIC_LAND_TYPES.filter((t) => lowerType.includes(t)).length;
}

function isPermanentType(lowerType: string): boolean {
  return /artifact|battle|creature|enchantment|land|planeswalker|kindred|tribal/.test(lowerType);
}

function isManland(e: SearchableEntry): boolean {
  return e.lowerType.includes('land') && /\bbecomes? [^.]*creature/.test(e.normOracle);
}

function isCommanderEligible(e: SearchableEntry): boolean {
  return (
    (e.lowerType.includes('creature') && e.lowerType.includes('legendary')) ||
    e.normOracle.includes('can be your commander')
  );
}

// True duals (Tundra, Volcanic Island, ...) print their mana ability as oracle
// text too — just as a parenthetical reminder, e.g. "({T}: Add {W} or {U}.)" —
// so "no oracle text" would wrongly exclude every one of them. Strip every
// parenthetical and check nothing else is printed.
function hasOnlyReminderText(oracleText: string | null | undefined): boolean {
  if (!oracleText?.trim()) return true;
  return oracleText.replace(/\([^)]*\)/g, '').trim() === '';
}

const IS_KEYWORDS: Record<string, (e: SearchableEntry) => boolean> = {
  // Structure — needs OracleCard.layout (absent on card DBs from before it existed).
  split: (e) => e.card.layout === 'split',
  flip: (e) => e.card.layout === 'flip',
  transform: (e) => e.card.layout === 'transform',
  meld: (e) => e.card.layout === 'meld',
  leveler: (e) => e.card.layout === 'leveler',
  adventure: (e) => e.card.layout === 'adventure',
  saga: (e) => e.card.layout === 'saga',
  class: (e) => e.card.layout === 'class',
  case: (e) => e.card.layout === 'case',
  mdfc: (e) => e.card.layout === 'modal_dfc',
  modal_dfc: (e) => e.card.layout === 'modal_dfc',
  dfc: (e) => ['transform', 'modal_dfc', 'meld', 'reversible_card'].includes(e.card.layout ?? ''),
  battle: (e) => e.card.layout === 'battle' || e.lowerType.includes('battle'),

  // Classification.
  spell: (e) => !e.lowerType.includes('land'),
  permanent: (e) => isPermanentType(e.lowerType),
  historic: (e) =>
    e.lowerType.includes('artifact') ||
    e.lowerType.includes('saga') ||
    (e.lowerType.includes('legendary') && isPermanentType(e.lowerType)),
  party: (e) => e.lowerType.includes('creature') && ['cleric', 'rogue', 'warrior', 'wizard'].some((t) => e.lowerType.includes(t)),
  outlaw: (e) =>
    e.lowerType.includes('creature') &&
    ['assassin', 'mercenary', 'pirate', 'rogue', 'warlock'].some((t) => e.lowerType.includes(t)),
  vanilla: (e) => e.lowerType.includes('creature') && !e.card.oracleText?.trim(),
  bear: (e) => e.lowerType.includes('creature') && e.card.cmc === 2 && e.card.power === '2' && e.card.toughness === '2',
  modal: (e) => /choose[^.\n]*—/.test(e.normOracle),
  manland: isManland,
  creatureland: isManland,
  companion: (e) => /\bcompanion\b/.test(e.normOracle),
  partner: (e) => /\bpartner\b/.test(e.normOracle),
  commander: isCommanderEligible,
  brawler: isCommanderEligible,
  duelcommander: isCommanderEligible,
  oathbreaker: (e) => e.lowerType.includes('planeswalker'),

  // Land archetypes: heuristics on oracle text, not a tagged list.
  dual: (e) => e.lowerType.includes('land') && basicLandTypeCount(e.lowerType) >= 2 && hasOnlyReminderText(e.card.oracleText),
  triome: (e) => e.lowerType.includes('land') && basicLandTypeCount(e.lowerType) >= 3,
  fetchland: (e) =>
    e.lowerType.includes('land') && e.normOracle.includes('search your library for') && e.normOracle.includes('sacrifice'),
  shockland: (e) => e.lowerType.includes('land') && /pay 2 life\. if you don.t, it enters tapped/.test(e.normOracle),
  painland: (e) => e.lowerType.includes('land') && e.normOracle.includes(' deals 1 damage to you'),
  checkland: (e) => e.lowerType.includes('land') && e.normOracle.includes('unless you control a'),
  fastland: (e) => e.lowerType.includes('land') && e.normOracle.includes('control two or fewer other lands'),
  slowland: (e) => e.lowerType.includes('land') && e.normOracle.includes('control two or more other lands'),
  bounceland: (e) => e.lowerType.includes('land') && e.normOracle.includes("return a land you control to its owner's hand"),

  // Mana symbols — reuses the mana: parser.
  hybrid: (e) => manaSymbolsOf(e.card).some((s) => s.includes('/') && !s.endsWith('/P')),
  phyrexian: (e) => manaSymbolsOf(e.card).some((s) => s.endsWith('/P')),

  // Curated flags — need OracleCard.reserved/gameChanger (absent on older card DBs).
  reserved: (e) => !!e.card.reserved,
  gamechanger: (e) => !!e.card.gameChanger,
  'game-changer': (e) => !!e.card.gameChanger,

  // Printing availability — any printing, via the printings join in search.ts.
  foil: (e) => e.finishes.has('foil'),
  nonfoil: (e) => e.finishes.has('nonfoil'),
  etched: (e) => e.finishes.has('etched'),
  promo: (e) => e.hasPromo,
  reprint: (e) => e.reprint,

  // Variant treatments — likewise "any printing of this card is one". See
  // PrintingVariant for what each tag means and how the pipeline derives it.
  // `is:variant` is the catch-all, so `-is:variant` asks for cards that only
  // ever came in the plain version.
  variant: (e) => e.variants.size > 0,
  borderless: (e) => e.variants.has('borderless'),
  showcase: (e) => e.variants.has('showcase'),
  extendedart: (e) => e.variants.has('extendedart'),
  extended: (e) => e.variants.has('extendedart'),
  inverted: (e) => e.variants.has('inverted'),
  retro: (e) => e.variants.has('retro'),
  serialized: (e) => e.variants.has('serialized'),
  specialfoil: (e) => e.variants.has('specialfoil'),
  textless: (e) => e.variants.has('textless'),
  boosterfun: (e) => e.variants.has('boosterfun'),
};

// ---- Matching ----

/**
 * Compile a query string into a matcher for the owned-list filters (collection /
 * wishlist). Callers pre-index their rows with `toSearchableEntry` once per data
 * change, then run `matches` per keystroke (parsing is cheap; normalising isn't).
 * `isEmpty` lets a blank query short-circuit and keep rows whose card is missing
 * from the DB — which otherwise can't produce a `SearchableEntry` to match.
 */
export function compileCardQuery(query: string): { isEmpty: boolean; matches: (entry: SearchableEntry) => boolean } {
  const parsed = parseSearchQuery(query.trim());
  return { isEmpty: parsed.root === null, matches: (entry) => matchesQuery(entry, parsed) };
}

export function matchesQuery(entry: SearchableEntry, q: ParsedQuery): boolean {
  return q.root === null || nodeMatches(entry, q.root);
}

function nodeMatches(entry: SearchableEntry, node: QueryNode): boolean {
  switch (node.kind) {
    case 'and':
      return node.children.every((child) => nodeMatches(entry, child));
    case 'or':
      return node.children.some((child) => nodeMatches(entry, child));
    case 'not':
      return !nodeMatches(entry, node.child);
    default:
      return termMatches(entry, node) !== node.negate;
  }
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
      // Normalized: pre-dedupe card DBs repeat a DFC's face colors, which would
      // otherwise read as multicolor and break exact (=) matches.
      const colors = normalizeColors(entry.card[t.field]);
      if (t.special === 'colorless') return t.op === '!=' ? colors.length > 0 : colors.length === 0;
      if (t.special === 'multicolor') return t.op === '!=' ? colors.length <= 1 : colors.length > 1;
      return matchColorSet(colors, t.op, t.set!);
    }
    case 'rarity':
      return compareNum(RARITY_RANK[entry.card.rarity], t.op, t.rank);
    case 'cmc':
      return compareNum(entry.card.cmc, t.op, t.value);
    case 'cmcParity':
      return entry.card.cmc % 2 === 0 === t.even;
    case 'mana':
      return compareMana(entry.card.manaCost, t.op, t);
    case 'set':
      return entry.sets.has(t.value);
    case 'is':
      return t.test(entry);
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

// Same superset/subset shape as matchColorSet, generalized to a mana cost:
// a numeral magnitude (generic) plus a multiset of every other symbol.
function compareMana(
  cardManaCost: string | null,
  op: NumOp,
  want: { generic: number; symbols: ReadonlyMap<string, number> },
): boolean {
  const have = (cardManaCost && parseManaCost(cardManaCost)) || { generic: 0, symbols: new Map<string, number>() };
  const allWanted = have.generic >= want.generic && hasAllSymbols(have.symbols, want.symbols); // cost ⊇ query
  const onlyWanted = have.generic <= want.generic && hasAllSymbols(want.symbols, have.symbols); // cost ⊆ query
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
