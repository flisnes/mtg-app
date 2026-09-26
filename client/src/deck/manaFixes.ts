import { decodeFetchProfile, decodeManaProfile, sourceColors } from '@mtg/shared';
import type { Color, Condition, ContainerKind, DeckFormat, Finish, OracleCard } from '@mtg/shared';
import {
  fetchColorsIn,
  fetchTargets,
  grantedColors,
  pipColors,
  readyTurn,
  type ManaReport,
  type SourceRow,
} from '@mtg/sim';
import type { PipColor } from '@mtg/sim';
import { copiesWelcome, isBasicLand } from './legality.js';

// Phase 6: the colored-source report says what is wrong; this says what to do
// about it, out of the cards you already own.
//
// That last clause is the whole point. Every deckbuilding site can tell you to
// play more white sources. Only a collection app knows you have three Plains in
// a bulk box and a Hallowed Fountain in a binder, and can put them in the deck
// in one tap. So the candidate pool is your collection and nothing else: no
// card-DB recommendations, nothing you would have to go and buy.
//
// Two deliberate omissions:
//
//  - Nothing here suggests what to *cut*. A 100-card deck that takes two more
//    lands is a 102-card deck, and which two spells you love least is not a
//    question arithmetic answers. The panel says so and leaves it to you.
//  - Copies already in another deck are named but never recommended. Your
//    Modern deck's Hallowed Fountain is not spare cardboard, and a fix list
//    that quietly dismantles your other decks is a worse tool than one that
//    tells you where the card went.

/** Rows past this and the panel stops being a suggestion and starts being a decklist. */
const MAX_FIXES = 6;

/** One piece of cardboard a fix would file, in the shape a deck slot names it. */
export interface FixCopy {
  scryfallId?: string;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
  quantity: number;
}

/** A mana source you own, with what the collection knows about where it is. */
export interface OwnedSource {
  oracle: OracleCard;
  /** Copies of it you own, every printing. */
  owned: number;
  /** Of those, copies a deck other than this one has already spoken for. */
  inDecks: number;
  /** Which decks those are, biggest holding first. */
  inDeckNames: string[];
  /** Where the rest of them sit — binders and boxes only — biggest pile first. */
  where: { name: string; kind: ContainerKind; quantity: number }[];
  /** The copies themselves, the ones no deck is holding first. */
  copies: FixCopy[];
}

/** A hole in the deck's mana: sources of a color it wants and hasn't got. */
export interface ManaNeed {
  /** Any one of these pays the pips. */
  colors: PipColor[];
  /** Sources still wanted, on top of what the deck already has. */
  short: number;
  /** Online by this turn, or it doesn't help the card that asked. */
  turn: number;
  /** The card that asks hardest — the one worth naming. */
  worst: string;
  /** The deck makes none of this at all, so the card is uncastable rather than unlikely. */
  none: boolean;
}

/** A card you own that would help, and what standing it has to be added. */
export interface FixCandidate {
  oracleId: string;
  name: string;
  colors: PipColor[];
  /** Earliest turn it can pay for a spell cast that same turn. */
  readyTurn: number;
  /** Always enters tapped. */
  slow: boolean;
  /** Copies of it no deck is using. */
  free: number;
  owned: number;
  /** Copies more this deck could legally take — Infinity for a basic. */
  room: number;
  basic: boolean;
  where: OwnedSource['where'];
  inDeckNames: string[];
  copies: FixCopy[];
}

/** One recommendation: this many copies of this card. */
export interface ManaFix {
  candidate: FixCandidate;
  copies: number;
  /** Colors it answers among the needs still open when it was picked. */
  covers: PipColor[];
}

export interface FixPlan {
  needs: ManaNeed[];
  fixes: ManaFix[];
  /** What is still short once every fix above is in. */
  remaining: ManaNeed[];
  /** Sources you own that would help, but whose every copy is in another deck. */
  spokenFor: { name: string; colors: PipColor[]; where: string }[];
  /** Copies the fixes would add, which is also the number of cards you'd cut. */
  added: number;
}

/**
 * The report's shortfalls, turned into holes to fill.
 *
 * Grouped by the colors that can pay them, because sources are shared: two
 * white cards short of white don't want twice as many white sources, they want
 * whatever the hungrier of them wants. So a group keeps the *largest* shortfall
 * and the turn and name of the card that set it — a tapped land that arrives
 * after that card's turn genuinely doesn't help that card, and that card is the
 * one the number is about.
 */
export function manaNeeds(report: ManaReport): ManaNeed[] {
  const byColors = new Map<string, ManaNeed>();
  for (const c of report.shortfalls) {
    // For an uncastable card the binding group is whatever bound the odds
    // check; what it actually lacks is `missing`, and it has none of it.
    const colors = c.uncastable && c.missing.length > 0 ? c.missing : c.colors;
    // No reachable target means no fix: the bar is above what any manabase this
    // size could hold, so there is no number of lands from your shelves that
    // closes it, and offering some anyway is the contradiction this whole panel
    // was accused of. An uncastable card still lacks a colour and still counts.
    if (c.needed === null && !c.uncastable) continue;
    const short = Math.max(1, (c.needed ?? c.pips) - (c.uncastable ? 0 : c.sources));
    const key = colors.join('');
    const cur = byColors.get(key);
    if (!cur) {
      byColors.set(key, { colors, short, turn: c.turn, worst: c.name, none: c.uncastable });
      continue;
    }
    if (short > cur.short || (short === cur.short && c.turn < cur.turn)) {
      cur.short = short;
      cur.turn = c.turn;
      cur.worst = c.name;
    }
    cur.none ||= c.uncastable;
  }
  // A color the deck can't make at all comes first: that's a card that never
  // casts, not a card that casts late.
  return [...byColors.values()].sort((a, b) => Number(b.none) - Number(a.none) || b.short - a.short || a.turn - b.turn);
}

/**
 * Every mana source in your collection that this deck could legally take,
 * scored against *this* deck: a fetchland's colors come from the lands in the
 * decklist, and a granter in the deck widens what a candidate land taps for —
 * the same deck-relative reads the colored-source report does, so the panel and
 * the report never disagree about what a card is worth.
 *
 * Sources whose color we can't name are left out. An Exotic Orchard fixes a
 * color count only if you know the other side of the table, and a fix list is
 * no place to guess.
 */
export function fixCandidates(
  owned: readonly OwnedSource[],
  rows: readonly SourceRow[],
  format: DeckFormat | undefined,
  identity: ReadonlySet<Color> | null,
): FixCandidate[] {
  const targets = fetchTargets(rows);
  const granted = grantedColors(rows);
  const inDeck = new Map<string, number>();
  for (const r of rows) {
    if (r.quantity <= 0 || r.board === 'token' || !r.oracle) continue;
    inDeck.set(r.oracle.oracleId, (inDeck.get(r.oracle.oracleId) ?? 0) + r.quantity);
  }

  const out: FixCandidate[] = [];
  for (const s of owned) {
    const o = s.oracle;
    const resolved = sourceShape(o, targets);
    if (!resolved) continue;
    const room = copiesWelcome(format, o, inDeck.get(o.oracleId) ?? 0, identity);
    if (room <= 0) continue;
    const colors = resolved.isLand && granted.length > 0 ? union(resolved.colors, granted) : resolved.colors;
    if (colors.length === 0) continue;
    out.push({
      oracleId: o.oracleId,
      name: o.name,
      colors,
      readyTurn: resolved.readyTurn,
      slow: resolved.slow,
      // Spare means spare: copies another deck has claimed are out, and so are
      // the copies *this* deck already lists. File two of your three Tundras
      // here and the third is the only one left to offer.
      free: Math.max(0, s.owned - s.inDecks - (inDeck.get(o.oracleId) ?? 0)),
      owned: s.owned,
      room,
      basic: isBasicLand(o),
      where: s.where,
      inDeckNames: s.inDeckNames,
      copies: s.copies,
    });
  }
  return out;
}

/** What a card is worth as a source, or null if it isn't one we can count. */
function sourceShape(
  o: OracleCard,
  targets: readonly { typeLine: string; colors: PipColor[]; basic: boolean }[],
): { colors: PipColor[]; readyTurn: number; slow: boolean; isLand: boolean } | null {
  if (o.fetch) {
    const profile = decodeFetchProfile(o.fetch);
    const colors = fetchColorsIn(o, targets);
    if (!profile || colors.length === 0) return null;
    // The fetch itself is untapped; what costs you a turn is what it puts down.
    return { colors, readyTurn: profile.tapped === 'always' ? 2 : 1, slow: profile.tapped === 'always', isLand: true };
  }
  const profile = decodeManaProfile(o.mana);
  if (!profile || profile.opponent) return null;
  const ready = readyTurn(profile.kind, o.cmc, profile.tapped);
  if (ready === null) return null;
  const colors = pipColors(sourceColors(profile, o.produces));
  if (colors.length === 0) return null;
  return { colors, readyTurn: ready, slow: profile.tapped === 'always', isLand: profile.kind === 'land' };
}

const union = (a: readonly PipColor[], b: readonly PipColor[]): PipColor[] => {
  const set = new Set([...a, ...b]);
  return (['W', 'U', 'B', 'R', 'G', 'C'] as PipColor[]).filter((c) => set.has(c));
};

/**
 * Greedily fill the holes from the pool: take the card that closes the most
 * open needs, put in as many copies as the biggest of those needs wants, and go
 * again until nothing is left short or nothing is left to add.
 *
 * Greedy rather than exact on purpose. Set cover is the exact problem and it is
 * NP-hard, but the input here is two or three needs against a handful of dual
 * lands, where greedy and optimal are the same answer — and where greedy has
 * the property that matters more: every step is a sentence you can read
 * ("Hallowed Fountain, because it makes both"). An optimum you can't explain is
 * a worse recommendation than a near-optimum you can.
 *
 * Ties go to the untapped source, then to the one that closes the most at once.
 */
export function planFixes(needs: readonly ManaNeed[], candidates: readonly FixCandidate[]): FixPlan {
  const open = needs.map((need) => ({ need, left: need.short }));
  const pool = candidates.map((c) => ({ c, free: Math.min(c.free, c.room) }));
  const fixes: ManaFix[] = [];

  while (fixes.length < MAX_FIXES) {
    let best: { p: (typeof pool)[number]; want: number; hit: typeof open; rank: number[] } | null = null;
    for (const p of pool) {
      if (p.free <= 0) continue;
      const hit = open.filter(
        (o) => o.left > 0 && p.c.readyTurn <= o.need.turn && p.c.colors.some((x) => o.need.colors.includes(x)),
      );
      if (hit.length === 0) continue;
      const want = Math.min(p.free, Math.max(...hit.map((o) => o.left)));
      const rank = [hit.length, -p.c.readyTurn, want];
      if (best && !better(rank, best.rank, p.c.name, best.p.c.name)) continue;
      best = { p, want, hit, rank };
    }
    if (!best) break;
    const { p, want, hit } = best;
    for (const o of hit) o.left = Math.max(0, o.left - want);
    p.free -= want;
    fixes.push({
      candidate: p.c,
      copies: want,
      covers: union(
        p.c.colors.filter((x) => hit.some((o) => o.need.colors.includes(x))),
        [],
      ),
    });
  }

  const stillOpen = open.filter((o) => o.left > 0);
  const spokenFor = candidates
    .filter(
      (c) =>
        c.free <= 0 &&
        // Held by another deck, specifically. A card this deck already runs
        // every copy of is not a card that went missing.
        c.inDeckNames.length > 0 &&
        stillOpen.some((o) => c.readyTurn <= o.need.turn && c.colors.some((x) => o.need.colors.includes(x))),
    )
    .slice(0, MAX_FIXES)
    .map((c) => ({ name: c.name, colors: c.colors, where: c.inDeckNames[0] ?? 'another deck' }));

  return {
    needs: [...needs],
    fixes,
    remaining: stillOpen.map((o) => ({ ...o.need, short: o.left })),
    spokenFor,
    added: fixes.reduce((n, f) => n + f.copies, 0),
  };
}

/** Lexicographic on the rank tuple, with the card name as the last tiebreak so the list is stable. */
function better(a: readonly number[], b: readonly number[], nameA: string, nameB: string): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return nameA.localeCompare(nameB) < 0;
}
