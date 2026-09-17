import {
  BEHAVIOR_ZONES,
  MAX_BEHAVIOR_AMOUNT,
  type BehaviorStep,
  type BehaviorZone,
  type DeckFormat,
  type EffectProfile,
} from '@mtg/shared';
import { canPay, explainPayment, maxMatching, PAY_GENERIC, PAY_UNUSED, type ManaUnit, type UnitGroup } from './canPay.js';
import { newTraceSink, pipText, say, type GameTrace, type TraceLine, type TraceSink } from './trace.js';
import { handSize } from './gameModel.js';
import { KEEP_ANYTHING_AT } from './mulligan.js';
import { makeRng, shuffle, type Rng } from './rng.js';
import { bindingPips, type ParsedCost, type Pip } from './manaCost.js';
import { popcount, UNIT_BY_MASK, type SimCard, type SimDeck } from './simDeck.js';

// The simulator: phase 5, and the only engine here that can answer a question
// about the *order* you drew things in.
//
// Everything before this was exact. A hypergeometric sees a multiset and
// nothing else, so it cannot tell a tapland played on turn one (free) from the
// same tapland on turn three (a whole turn of mana), cannot recurse through
// "the ramp spell needed two mana of its own first", and cannot solve the
// colors jointly for a draw it never looks at. Those three are most of what
// decides whether you cast your four-drop on turn four, so they get a game loop
// and twenty thousand dealt hands instead of a formula.
//
// What comes out is a *goldfish* number under a *stated policy*. Nobody is on
// the other side of the table, nothing is countered, nothing dies, and the play
// pattern is a fixed greedy one rather than a player. The UI says so on its
// face: a simulated number whose policy is hidden is worth less than no number.

/** Turns simulated. Eight covers a seven-drop's own curve and stops there. */
export const SIM_MAX_TURN = 8;

/** Enough games that a percentage point is real, few enough to finish on a phone. */
export const DEFAULT_GAMES = 20000;

/** How often the simulator reports progress, in games. */
const PROGRESS_EVERY = 2000;

/** Room for the battlefield. A goldfish that gets past this has other problems. */
const MAX_SOURCES = 64;

/**
 * Spells cast in one turn before the sequencer stops asking. A turn that wants
 * more than this is a turn the model has already lost the thread of, and the
 * trajectory panel says so rather than grinding through it.
 */
const MAX_CASTS_PER_TURN = 8;

/**
 * A Treasure taps for one mana of any colour — WUBRG, and not {C}, which is
 * the one bit of MASK_BITS it does not light up.
 */
const TREASURE_MASK = 0b11111;

/** Extra land drops honoured in a turn. Azusa and a friend is already a lot. */
const MAX_EXTRA_LANDS = 4;

/** Cards one effect may put into your hand. Guards a misread "draw X". */
const MAX_DRAW_PER_EFFECT = 12;

/**
 * Room for the hand. Seven plus eight turns of draw steps never came near the
 * old 96 and a deck full of card draw still does not, but every point that
 * grows the hand now checks the bound rather than assuming it.
 */
const MAX_HAND = 128;

/** How a zone reads in a trace line: "to your graveyard". */
const ZONE_PHRASE = new Map(BEHAVIOR_ZONES.map((z) => [z.id as string, z.phrase]));

/** Karsten's simulations ship a hand with fewer than two lands; so does this one. */
export const DEFAULT_KEEP_MIN = 2;
export const DEFAULT_KEEP_MAX = 5;

export interface SimOptions {
  games: number;
  onPlay: boolean;
  maxTurn: number;
  format: DeckFormat | undefined;
  /** Keep a seven holding this many lands. */
  keepMin: number;
  keepMax: number;
  /** Off for the acceptance test, which needs the simulator to be the hypergeometric. */
  mulligan: boolean;
  /**
   * Resolve what a spell does, rather than casting it as a blank. Phase 9's
   * master switch, and it is a switch for two reasons (§11.8). The phase 5
   * acceptance test — mulligans off, one colour, no ramp, the sim agreeing with
   * the exact hypergeometric — only passes with effects off, because a deck
   * that draws extra cards is no longer the distribution the formula describes.
   * And turning one family on at a time is how its contribution gets measured.
   */
  effects: boolean;
  /**
   * Write the game down as it is played. One game only, on the main thread,
   * for the goldfish trace. Off for every run that feeds a number: the
   * bookkeeping is cheap but it is not free, and twenty thousand games of it
   * would be twenty thousand transcripts nobody reads.
   */
  trace?: boolean;
  seed: number;
}

export const defaultSimOptions = (format: DeckFormat | undefined, onPlay: boolean): SimOptions => ({
  games: DEFAULT_GAMES,
  onPlay,
  maxTurn: SIM_MAX_TURN,
  format,
  keepMin: DEFAULT_KEEP_MIN,
  keepMax: DEFAULT_KEEP_MAX,
  mulligan: true,
  effects: true,
  seed: 0x5eed,
});

/**
 * Two different questions, kept apart on purpose.
 *
 * `cast` is the question as a player asks it: did you have the card *and* the
 * mana by turn N. For a one-of in a ninety-nine it is a small number for
 * reasons that have nothing to do with your lands, which is why it cannot be
 * the only one reported.
 *
 * `pay` is the manabase question, and it is **conditional on holding the
 * card**: of the games where you had it by turn N, how often could you pay for
 * it. That conditioning is not a convenience, it is the only version of the
 * question that means anything here, because the sequencer's land drops are a
 * response to what is in hand. In a game where you never drew your one-drop,
 * nothing made it play the untapped white source on turn one, and asking
 * whether it "could have" cast Swords that turn measures the policy rather than
 * the deck.
 *
 * `pay` is pooled across every card in the deck written at the same printed
 * cost, because they have the same answer and a singleton deck holds any one of
 * them in seven percent of games. Pooling five one-ofs at {U}{U} turns five
 * noisy estimates that sort themselves into a fake ranking into one number with
 * five times the sample behind it.
 *
 * All three are reported so nobody has to guess which one a percentage is.
 */
export interface SimCardResult {
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  /** The turn this card wants to be cast on: its mana value. */
  curveTurn: number;
  copies: number;
  commander: boolean;
  /** P(in hand by turn t), indexed by turn; index 0 is unused. */
  heldByTurn: number[];
  /** P(payable by turn t | in hand by turn t) — the manabase, given the card. */
  payByTurn: number[];
  /** P(in hand and payable by turn t). */
  castByTurn: number[];
  /** `payByTurn` at `curveTurn`. */
  onCurvePay: number;
  /** `castByTurn` at `curveTurn`. */
  onCurveCast: number;
  /** Games behind `payByTurn` at `curveTurn` — the sample its interval is built on. */
  paySample: number;
}

/** One printed cost in the deck, and how often the mana covered it. */
export interface SimCostGroup {
  manaCost: string;
  cmc: number;
  curveTurn: number;
  /** Cards in the deck written at this cost. */
  names: string[];
  copies: number;
  /** P(payable by turn t | in hand by turn t), pooled over every card at this cost. */
  payByTurn: number[];
  onCurvePay: number;
  /** Games behind the conditional at `curveTurn`. */
  sample: number;
}

export interface SimResult {
  games: number;
  maxTurn: number;
  /** Library cards with a printed cost, worst on-curve odds first. */
  cards: SimCardResult[];
  /**
   * The command zone. Reported apart from `cards` because it is a different
   * kind of card: you have it in every game, from turn one, without drawing it,
   * and most decks are built around casting it. Never pooled with a library
   * card that happens to share its cost, and never in `costs`.
   */
  commanders: SimCardResult[];
  /** The distinct printed costs in the library, worst first. The report to act on. */
  costs: SimCostGroup[];
  /** Mean mana available, indexed by turn. Treasures made this turn included. */
  manaByTurn: number[];
  /**
   * Mean mana actually spent on spells, indexed by turn. The gap against
   * `manaByTurn` is the thing no other panel in this sheet can see: mana you
   * had and had nothing to do with. It still runs high, because the cards this
   * model cannot read resolve as blanks and buy you nothing.
   */
  manaSpentByTurn: number[];
  /** Mean cards into your hand from the library by end of turn: the opener plus draws. */
  cardsSeenByTurn: number[];
  /** Mean cards left in hand at end of turn, after the turn's spells have left it. */
  handSizeByTurn: number[];
  /** P(you had a land to play), indexed by turn. */
  landDropByTurn: number[];
  /** P(the game started below seven cards). */
  pMulligan: number;
  meanHandSize: number;
  /** Copy-weighted mean of `onCurvePay`: how often this manabase is ready on time. */
  deckOnCurve: number;
}

/**
 * The 95% confidence half-width for a proportion out of `games` games. Reported
 * rather than buried: a simulated 61% and an exact 61% are not the same claim,
 * and this is the size of the difference.
 */
export function halfWidth(p: number, games: number): number {
  if (games <= 0) return 1;
  return 1.96 * Math.sqrt(Math.max(p * (1 - p), 1e-6) / games);
}

/**
 * The policy, in full, because a number under an unstated policy is a number
 * about nothing:
 *
 *   1. London mulligan. Deal seven; keep it if it holds `keepMin`..`keepMax`
 *      lands, else ship it. Bottom an excess land when the hand is more than
 *      half lands, otherwise the most expensive spell. Keep any five.
 *   2. Draw for turn, except turn one on the play.
 *   3. Play a land, always, if there is one, and one more for every extra land
 *      drop you have in play. Which land: if something in hand costs exactly
 *      one more than the mana already online, take an untapped one; otherwise
 *      dump a tapland now, while it is free. Ties go to the land that adds a
 *      color you don't have, a modal card stays in hand while a real land will
 *      do, and a tie the policy is genuinely indifferent about is a coin flip
 *      rather than hand order.
 *   4. A fetch goes and gets whichever land widens your colors most, and that
 *      land leaves the library. Eight fetches over one Island are one blue
 *      source here, the same as at the table.
 *   5. Record every card in hand you could pay for with everything untapped.
 *      Taken *before* any mana is spent, because the card you are asking about
 *      is the card you would have spent it on.
 *   6. Spend the turn. Ramp first, priciest first, because a Signet cast before
 *      the three-drop is a source next turn and cast after it is a card in
 *      hand; then the rest of the hand, priciest first, until the mana is gone.
 *      A tie between equals is a coin flip rather than decklist order.
 *   7. A card the database has an effect profile for resolves it: cards into
 *      hand, cards out of it, cards off the top into the graveyard, Treasures
 *      onto the battlefield, and a dig that goes looking for a land only when
 *      you have none. A Treasure is cracked the first turn the spending
 *      actually reaches it. Everything else still resolves as a blank, which
 *      is right for a Lightning Bolt and wrong for every draw spell whose draw
 *      hangs off a trigger the pipeline would not read. So the curves are
 *      still a floor, and `SimDeck.coverage` is how far off the floor they are.
 */
export function simulate(
  deck: SimDeck,
  opts: SimOptions,
  onProgress?: (done: number) => void,
  sink?: TraceSink,
): SimResult {
  const cards = deck.cards;
  const n = cards.length;
  const maxTurn = opts.maxTurn;
  const stride = maxTurn + 1;
  const rng = makeRng(opts.seed);
  const deckSize = deck.library.length;

  // Cards sharing a printed cost share an answer, so the payment solver runs
  // once per distinct cost per turn rather than once per card. That is also
  // what makes the manabase question cheap: asking it of every card in the deck
  // costs the same as asking it of the ten distinct costs they are written in.
  const groupOf = new Int32Array(n).fill(-1);
  const groupRep: number[] = [];
  const seenCost = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const card = cards[i]!;
    if (!card.spell || !card.cost) continue;
    let g = seenCost.get(card.manaCost);
    if (g === undefined) {
      g = groupRep.length;
      seenCost.set(card.manaCost, g);
      groupRep.push(i);
    }
    groupOf[i] = g;
  }
  const groups = groupRep.length;
  /** The colored pips of each cost, for scoring a land drop against it. */
  const goalPips: Pip[][] = groupRep.map((i) => bindingPips(cards[i]!.cost!));

  const library = new Int32Array(deckSize);
  const hand = new Int32Array(MAX_HAND);
  /**
   * The graveyard and exile, as card indices.
   *
   * Until a behavior could go looking in the yard nothing read it, so milling
   * walked the library pointer past a card and that was the end of it. Now that
   * "return every land from your graveyard" is a rule somebody can write, both
   * zones have to be filled by *everything* that fills them: milling,
   * discarding, a cracked fetch, a Lotus Field's own entry cost, and every
   * spell that is not a permanent. A yard only half the game puts cards into is
   * worse than no yard at all, because a rule written against it looks like it
   * works.
   */
  const graveyard = new Int32Array(deckSize + MAX_HAND);
  let gyLen = 0;
  const exiled = new Int32Array(deckSize + MAX_HAND);
  let exLen = 0;
  const landChoices = new Int32Array(MAX_HAND);
  const srcMask = new Int32Array(MAX_SOURCES);
  const srcUnits = new Int32Array(MAX_SOURCES);
  const srcOnline = new Int32Array(MAX_SOURCES);
  /** Last turn the source still works, or 0 for "it doesn't go away". */
  const srcExpires = new Int32Array(MAX_SOURCES);
  /** Its mana is all one color, chosen once: a group, not independent units. */
  const srcOneColor = new Uint8Array(MAX_SOURCES);
  /** A land, so a granter in play widens what it taps for. */
  const srcIsLand = new Uint8Array(MAX_SOURCES);
  /** Which card it is, so a Karoo can hand one back to you. */
  const srcCard = new Int32Array(MAX_SOURCES);
  /** A Treasure, so it can be sacrificed for the mana it just paid. */
  const srcTreasure = new Uint8Array(MAX_SOURCES);
  const unitGroups: UnitGroup[] = [];
  /** Permanents with a recurring effect, as card indices. Phyrexian Arena. */
  const recurring = new Int32Array(MAX_SOURCES);
  let recurLen = 0;
  /** Land drops beyond the first, from an Exploration or an Azusa in play. */
  let extraLands = 0;
  /** Sources on the battlefield. Lives out here so the pool builder can see it. */
  let srcLen = 0;
  /**
   * The hand and the library, out here for the same reason: the effect
   * resolvers below move all four of these and closing over them beats
   * threading them through five call signatures.
   *
   * `top` is the library pointer and `seen` is what reached your hand off it.
   * They used to be the same number, and they stop being the same number the
   * moment anything mills: a card binned off the top has left the library
   * without you ever seeing it, and the cards chart is about what you hold.
   */
  let handLen = 0;
  let libLen = 0;
  let top = 0;
  let seen = 0;
  let colorsHeld = 0;
  /** Colors every land you control also makes, from an Urborg or a Lantern in play. */
  let grantMask = 0;

  /**
   * The mana available this turn, as the payment solver wants it, and how much
   * of it there is.
   *
   * Three things happen here that did not used to. A source past its lifetime
   * is skipped, so Urza's Saga stops paying after three turns and a Peat Bog
   * after two activations instead of feeding an eight-turn game sixteen mana. A
   * source whose mana is all one color becomes a *group*, because Lotus Field
   * makes three of one color and not three of any. And a granter in play ORs
   * its colors into every land, which is the one place this model was too mean
   * rather than too kind.
   */
  const buildPool = (turn: number): number => {
    units.length = 0;
    unitGroups.length = 0;
    if (sink) {
      unitOwner.length = 0;
      groupOwner.length = 0;
    }
    let total = 0;
    for (let s = 0; s < srcLen; s++) {
      if (srcOnline[s]! > turn) continue;
      const expires = srcExpires[s]!;
      if (expires > 0 && turn > expires) continue;
      const n = srcUnits[s]!;
      total += n;
      const mask = srcIsLand[s] ? srcMask[s]! | grantMask : srcMask[s]!;
      if (srcOneColor[s] && n > 1) {
        unitGroups.push({ colors: UNIT_BY_MASK[mask]!.colors, count: n });
        if (sink) groupOwner.push(srcCard[s]!);
      } else {
        for (let u = 0; u < n; u++) {
          units.push(UNIT_BY_MASK[mask]!);
          if (sink) unitOwner.push(srcCard[s]!);
        }
      }
    }
    return total;
  };

  /**
   * Which permanent pushed each unit and each group, as a *card* index rather
   * than a battlefield slot. Slots are swap-removed — a Karoo bouncing a land,
   * a Treasure being cracked — so a slot recorded when the pool was built can
   * be someone else entirely by the time a trace line reads it. A card index
   * never moves. Filled only under trace.
   */
  const unitOwner: number[] = [];
  const groupOwner: number[] = [];
  /** The cast lines of the turn being written, waiting for their tap breakdown. */
  const castLines: { line: TraceLine; generic: number; pips: number }[] = [];

  /** What a permanent is called, for a trace line. -1 is a Treasure token. */
  const sourceName = (index: number): string => (index < 0 ? 'Treasure' : (cards[index]?.name ?? 'a source'));

  /**
   * Which permanent paid for which spell, worked out **once for the whole
   * turn** and written back onto the cast lines afterwards.
   *
   * It has to be once. The sequencer's own decision is cumulative — every cost
   * committed this turn folded into `paid` and re-solved — so a per-card solve
   * against whatever was left over is a different question with a different
   * answer, and the first draft of this made exactly that mistake: it showed a
   * Lightning Bolt tapping a Treasure on a turn the sequencer had correctly
   * decided no Treasure was needed. A trace that contradicts the model it is
   * supposed to explain is worse than no trace.
   *
   * Generic mana has no owner in the solve, so it is handed out in cast order:
   * the first spell's generic is paid before the second spell's. Any mana pays
   * generic, so which units go where is arbitrary, and cast order is the
   * arbitrary choice a reader can follow.
   */
  const attributeTaps = (
    casts: { line: TraceLine; generic: number; pips: number }[],
    pool: readonly ManaUnit[],
    owners: readonly number[],
  ): void => {
    if (casts.length === 0) return;
    const plan = explainPayment(paid, pool, unitGroups);
    if (!plan) {
      // The cumulative cost is payable (the sequencer just checked) but this
      // particular ordering of hybrids did not hand back an assignment. Say so
      // rather than invent one.
      for (const c of casts) c.line.text += ` (no tap breakdown available)`;
      return;
    }
    // Which *cast* each symbol of the folded cost came from. By position in the
    // turn, never by card: two copies of Big Score in one turn are two casts and
    // one card index, and keying this by the card gave both lines the whole
    // turn's taps.
    const owner: number[] = [];
    for (let c = 0; c < casts.length; c++) for (let i = 0; i < casts[c]!.pips; i++) owner.push(c);
    /** Generic still owed, per cast, drained in order. */
    const owed = casts.map((c) => c.generic);
    const taps: string[][] = casts.map(() => []);

    for (let i = 0; i < plan.byUnit.length; i++) {
      const use = plan.byUnit[i]!;
      if (use === PAY_UNUSED) continue;
      const name = sourceName(poolOwner(i, owners));
      if (use === PAY_GENERIC) {
        let at = owed.findIndex((n) => n > 0);
        if (at < 0) at = casts.length - 1;
        owed[at] = (owed[at] ?? 1) - 1;
        taps[at]!.push(`${name} taps for generic`);
        continue;
      }
      const at = owner[plan.pipSlot[use] ?? -1] ?? 0;
      taps[at]!.push(`${name} taps for ${pipText(plan.pips[use]!.options)}`);
    }
    for (let c = 0; c < casts.length; c++) {
      if (taps[c]!.length > 0) casts[c]!.line.taps = taps[c];
    }
  };

  /** The permanent behind pool index `i`, plain units first and then the groups. */
  const poolOwner = (i: number, owners: readonly number[]): number => {
    if (i < owners.length) return owners[i]!;
    let at = i - owners.length;
    let g = 0;
    while (g < unitGroups.length && at >= unitGroups[g]!.count) {
      at -= unitGroups[g]!.count;
      g++;
    }
    return groupOwner[g] ?? -1;
  };

  /**
   * Put a source onto the battlefield. `index` is the card it is; `card` is what
   * that card does, which for a fetch is the land it found rather than the fetch.
   *
   * A granter's colors are OR'd in on arrival and never removed, because nothing
   * in a goldfish removes a permanent. Only granters the sequencer actually puts
   * down are seen — an Urborg or a Chromatic Lantern. A Prismatic Omen is filed
   * as a plain spell and never reaches the battlefield here, so the simulator
   * misses it where the colored-source report, which is deck-relative, does not.
   */
  const addSource = (index: number, card: SimCard, online: number, turn: number): boolean => {
    if (srcLen >= MAX_SOURCES) return false;
    srcMask[srcLen] = card.mask;
    srcUnits[srcLen] = card.adds;
    srcOnline[srcLen] = online;
    // A lifetime is counted from the turn it arrives and includes that turn.
    // Urza's Saga gains its ability from chapter I at precombat main and is
    // sacrificed after III, so you tap it for {C} on the turn it dies too.
    srcExpires[srcLen] = card.life > 0 ? turn + card.life - 1 : 0;
    srcOneColor[srcLen] = card.oneColor ? 1 : 0;
    srcIsLand[srcLen] = card.role === 'land' || card.role === 'fetch' ? 1 : 0;
    srcCard[srcLen] = index;
    srcTreasure[srcLen] = 0;
    srcLen++;
    grantMask |= card.grantMask;
    return true;
  };

  /** Swap-remove a source. The parallel arrays all move together or not at all. */
  const dropSource = (at: number): void => {
    srcLen--;
    srcMask[at] = srcMask[srcLen]!;
    srcUnits[at] = srcUnits[srcLen]!;
    srcOnline[at] = srcOnline[srcLen]!;
    srcExpires[at] = srcExpires[srcLen]!;
    srcOneColor[at] = srcOneColor[srcLen]!;
    srcIsLand[at] = srcIsLand[srcLen]!;
    srcCard[at] = srcCard[srcLen]!;
    srcTreasure[at] = srcTreasure[srcLen]!;
  };

  /**
   * The lands a source costs you on the way in, taken off the battlefield.
   * Returns a card to put back into your hand, or -1.
   *
   * Lotus Field is net minus two lands: three permanents become one, and the
   * model used to count it as a bonus. A Karoo is subtler and the arithmetic is
   * worth stating, because the sign is not obvious — you are a mana down the
   * turn it lands and a mana up forever after, but the land it returns is a
   * *spare land drop*, which is the whole reason the cycle is playable. The two
   * pull opposite ways, which is why they are both modelled rather than
   * averaged into a correction factor.
   *
   * What it gives up is the most recently played land other than the one that
   * just entered. That is not optimal play — you would return the worst land —
   * but it is cheap and it is the same conservative direction everywhere else
   * here takes.
   */
  const payEntryCost = (card: SimCard): number => {
    let back = -1;
    for (let k = 0; k < card.entry; k++) {
      let pick = -1;
      for (let s = srcLen - 2; s >= 0; s--) {
        if (srcIsLand[s]) {
          pick = s;
          break;
        }
      }
      if (pick < 0) break;
      const lost = srcCard[pick]!;
      if (card.bounce) back = lost;
      else bury(lost);
      dropSource(pick);
    }
    return back;
  };
  // --- Effect resolution (phase 9) -----------------------------------------
  // What a card does when it resolves, as far as OracleCard.effect can say.
  // Every one of these is written to err downward, because §11.4's whole point
  // is that the curves are only honest while they are a floor.

  // What the last resolveEffect() actually did, so the trace can say "drew
  // Ponder and a Swamp" instead of "drew 2". Cleared per resolution; never
  // touched at all when nothing is tracing.
  const drewNames: string[] = [];
  const discardedNames: string[] = [];
  const milledNames: string[] = [];
  const movedNames: string[] = [];

  /** A card lands in the yard. Treasure tokens (-1) have no card to put there. */
  const bury = (index: number): void => {
    if (index >= 0 && gyLen < graveyard.length) graveyard[gyLen++] = index;
  };

  /** Cards off the top into your hand. A tutor comes through here too, see below. */
  const drawCards = (count: number): void => {
    for (let k = 0; k < count; k++) {
      if (top >= libLen || handLen >= hand.length) return;
      const index = library[top++]!;
      hand[handLen++] = index;
      seen++;
      if (sink) drewNames.push(cards[index]!.name);
    }
  };

  /**
   * Cards out of your hand. The commander is exempt: it is in `hand` as a
   * bookkeeping convenience and discarding it would be a rules error, not a
   * conservative approximation.
   */
  const discardCards = (count: number): void => {
    for (let k = 0; k < count; k++) {
      const pick = pickDiscard(cards, hand, handLen);
      if (pick < 0) return;
      const index = hand[pick]!;
      if (sink) discardedNames.push(cards[index]!.name);
      hand[pick] = hand[--handLen]!;
      bury(index);
    }
  };

  /** Cards off the top into the graveyard. They leave the library; you never see them. */
  const millCards = (count: number): void => {
    for (let k = 0; k < count && top < libLen; k++) {
      const index = library[top++]!;
      if (sink) milledNames.push(cards[index]!.name);
      bury(index);
    }
  };

  /**
   * Scry and surveil, modelled as the one thing they are unambiguously for:
   * not missing a land drop. Look at the top `count`; if you are holding no
   * land at all, bring the first one you see to the top.
   *
   * It never digs for action, never bottoms anything and never bins anything,
   * so it can only make the model less flooded and never more explosive — the
   * floor direction. What it leaves out is surveil's whole distinguishing half,
   * the graveyard, which is phase 10's chart and needs the yard modelled first.
   */
  const dig = (count: number): void => {
    if (count <= 0 || top >= libLen) return;
    for (let i = 0; i < handLen; i++) if (cards[hand[i]!]!.land) return;
    const upto = Math.min(top + count, libLen);
    for (let i = top; i < upto; i++) {
      if (!cards[library[i]!]!.land) continue;
      const found = library[i]!;
      library[i] = library[top]!;
      library[top] = found;
      return;
    }
  };

  /**
   * Treasures onto the battlefield, usable the turn they are made.
   *
   * They go into the pool as well as onto the field, because `units` is what
   * the payment solver is already holding this turn and a Treasure that cannot
   * fix a colour until next turn is not a Treasure. What makes them keep rather
   * than evaporate is the reconciliation after the spend loop: whatever the
   * turn's spending actually dipped into gets sacrificed, and the rest is still
   * there next turn. That is how anyone plays them — lands and rocks first,
   * Treasure last, because the Treasure is the one that does not come back.
   */
  const makeTreasures = (count: number, turn: number): number => {
    let made = 0;
    for (let k = 0; k < count; k++) {
      if (srcLen >= MAX_SOURCES) break;
      srcMask[srcLen] = TREASURE_MASK;
      srcUnits[srcLen] = 1;
      srcOnline[srcLen] = turn;
      srcExpires[srcLen] = 0;
      srcOneColor[srcLen] = 0;
      srcIsLand[srcLen] = 0;
      srcCard[srcLen] = -1;
      srcTreasure[srcLen] = 1;
      srcLen++;
      units.push(UNIT_BY_MASK[TREASURE_MASK]!);
      if (sink) unitOwner.push(-1);
      colorsHeld |= TREASURE_MASK;
      made++;
    }
    return made;
  };

  /** Treasures on the battlefield right now, cracked or not. */
  const countTreasures = (): number => {
    let n = 0;
    for (let s = 0; s < srcLen; s++) if (srcTreasure[s]) n++;
    return n;
  };

  /**
   * How many Treasures this turn actually had to crack.
   *
   * Quantity is the obvious half: spend more mana than your permanents make and
   * the difference came out of Treasures. **Colour is the half the goldfish
   * trace caught.** A Lightning Bolt cast off a Treasure because the only
   * untapped land left was an Island costs you that Treasure exactly as much as
   * a fourth mana would have, and a reconciliation that only compares totals
   * lets it keep. That is the generous direction, which is the one direction
   * §11.4 says this model is never allowed to be wrong in.
   *
   * So: rebuild the pool with no Treasures in it, then add them back one at a
   * time until the turn's committed cost is payable again. Runs once a turn,
   * and only on a turn that has Treasures at all.
   */
  const treasuresSpent = (turn: number, treasures: number): number => {
    for (let k = 0; k <= treasures; k++) {
      thrifty.length = 0;
      thriftyOwner.length = 0;
      for (let s = 0; s < srcLen; s++) {
        if (srcTreasure[s]) continue;
        if (srcOnline[s]! > turn) continue;
        const expires = srcExpires[s]!;
        if (expires > 0 && turn > expires) continue;
        const n = srcUnits[s]!;
        if (srcOneColor[s] && n > 1) continue; // already in unitGroups
        const mask = srcIsLand[s] ? srcMask[s]! | grantMask : srcMask[s]!;
        for (let u = 0; u < n; u++) {
          thrifty.push(UNIT_BY_MASK[mask]!);
          if (sink) thriftyOwner.push(srcCard[s]!);
        }
      }
      for (let i = 0; i < k; i++) {
        thrifty.push(UNIT_BY_MASK[TREASURE_MASK]!);
        if (sink) thriftyOwner.push(-1);
      }
      if (canPay(paid, thrifty, unitGroups)) return k;
    }
    return treasures;
  };
  /**
   * The pool `treasuresSpent` settled on: every permanent, and only as many
   * Treasures as the turn genuinely had to crack. The trace attributes taps out
   * of this rather than out of `units`, so the breakdown can never show four
   * Treasures paying for a turn the model then charges two for.
   */
  const thrifty: ManaUnit[] = [];
  const thriftyOwner: number[] = [];

  /** Sacrifice `count` of them, newest first — they are interchangeable. */
  const crackTreasures = (count: number): void => {
    for (let k = 0; k < count; k++) {
      let at = -1;
      for (let s = srcLen - 1; s >= 0; s--) {
        if (srcTreasure[s]) {
          at = s;
          break;
        }
      }
      if (at < 0) return;
      dropSource(at);
    }
  };

  /**
   * Resolve one card's effect, and return the mana it added to this turn.
   *
   * Order matters and it is the order the card is written in: you draw before
   * you discard, so a loot can throw away the card it just found. Milling comes
   * off the same top the draw did, and the dig happens last because it is about
   * the *next* draw rather than this one.
   *
   * A tutor is resolved as a draw off the top, which is the one place here that
   * is knowingly, badly wrong in the right direction: a Demonic Tutor finds the
   * card that wins the game and this hands you a random one. EFFECT_TUTOR is on
   * the profile so a later phase can do better; hand size is the same either
   * way, which is what these charts read.
   */
  /**
   * A permanent arrived, by land drop or by casting. A recurring effect joins
   * the upkeep list and fires from *next* turn, because its trigger is an
   * upkeep it has already missed; a one-shot one resolves now. Returns the mana
   * it added to this turn, which only a Treasure ever does.
   */
  const enters = (index: number, card: SimCard, turn: number): number => {
    // Authored behavior replaces the derived profile outright — see
    // SimCard.behavior for why replace and not merge. A card carrying both an
    // upkeep rule and a play rule does both: unlike EffectProfile, where
    // `repeatable` is one flag over the whole thing, the rules are separate, so
    // a card that draws on entry *and* every upkeep is one behavior.
    const b = card.behavior;
    if (b) {
      if (b.upkeep.length > 0 && recurLen < recurring.length) recurring[recurLen++] = index;
      if (sink) lastEffectText = '';
      return b.play.length > 0 ? runSteps(b.play, turn) : 0;
    }
    const effect = card.effect;
    if (!effect) return 0;
    if (effect.repeatable) {
      if (recurLen < recurring.length) recurring[recurLen++] = index;
      return 0;
    }
    return resolveEffect(effect, turn);
  };

  const resolveEffect = (effect: EffectProfile, turn: number): number => {
    if (sink) {
      drewNames.length = 0;
      discardedNames.length = 0;
      milledNames.length = 0;
    }
    drawCards(Math.min(effect.draw, MAX_DRAW_PER_EFFECT));
    if (effect.wholeHand) discardCards(handLen);
    else discardCards(effect.discard);
    millCards(effect.mill);
    const dug = Math.max(effect.surveil, effect.scry);
    dig(dug);
    const made = effect.treasure > 0 ? makeTreasures(effect.treasure, turn) : 0;
    if (sink) {
      const bits: string[] = [];
      if (drewNames.length) bits.push(`${effect.tutor ? 'finds' : 'draws'} ${drewNames.join(', ')}`);
      if (discardedNames.length) bits.push(`discards ${discardedNames.join(', ')}`);
      if (milledNames.length) bits.push(`mills ${milledNames.join(', ')}`);
      if (dug > 0) bits.push(`${effect.scry >= effect.surveil ? 'scry' : 'surveil'} ${dug}`);
      if (made > 0) bits.push(`makes ${made} Treasure${made === 1 ? '' : 's'}`);
      if (effect.unknown) bits.push('amount floored');
      lastEffectText = bits.join(', ');
    }
    return made;
  };

  /** What resolveEffect() just did, in one phrase, for the caller to attribute. */
  let lastEffectText = '';

  // --- Authored behavior ----------------------------------------------------
  // The same zone movers, driven by the user's rules instead of the card
  // database's reading. Nothing new happens to the game state here: what a
  // behavior buys is *order* and *arithmetic* — a loot that discards before it
  // draws, a draw whose number is the size of your hand — over a grammar the
  // editor can offer without lying about what gets executed.

  /** Lands on the battlefield right now, for the `lands` amount. */
  const landsInPlay = (turn: number): number => {
    let n = 0;
    for (let s = 0; s < srcLen; s++) {
      if (!srcIsLand[s]) continue;
      const expires = srcExpires[s]!;
      if (expires > 0 && turn > expires) continue;
      n++;
    }
    return n;
  };

  /**
   * A step's number, clamped both ends.
   *
   * The ceiling is the guard that makes state-reading amounts safe to offer: a
   * hand of forty in a deck that draws its whole library would otherwise ask
   * drawCards() for forty, and `hand` is a fixed-size array. It is the same cap
   * MAX_DRAW_PER_EFFECT is for a misread "draw X", for the same reason.
   */
  const behaviorAmount = (step: BehaviorStep, turn: number): number => {
    let n: number;
    switch (step.x.kind) {
      case 'fixed':
        n = step.x.n ?? 0;
        break;
      case 'hand':
        n = handLen;
        break;
      case 'lands':
        n = landsInPlay(turn);
        break;
      case 'graveyard':
        n = gyLen;
        break;
      case 'turn':
        n = turn;
        break;
      case 'all':
        // Bounded by the zone rather than by a number. This is only the ceiling
        // the move loop stops at; it stops sooner the moment nothing matches.
        n = MAX_BEHAVIOR_AMOUNT;
        break;
      default:
        // A kind this build has never heard of, off a newer device.
        // compileBehavior drops those, so reaching here means the grammar grew
        // without this switch; zero is the omission the rest of the model is
        // built on.
        return 0;
    }
    return Math.max(0, Math.min(MAX_BEHAVIOR_AMOUNT, n));
  };

  // --- Moving cards between zones ------------------------------------------
  // One step covers tutoring, ramping a land out of the library, regrowth,
  // bouncing, entombing and putting a card back, because all six are the same
  // sentence with different zones in it. What narrows it to a particular card
  // is a Scryfall query, matched against the deck once at build time and
  // reaching the inner loop as a byte per card.

  /** Nothing matches. What a criteria string no filter was built for gets. */
  const NO_MATCH = new Uint8Array(0);
  const filterMasks = new Map<string, Uint8Array>();
  for (const f of deck.filters) filterMasks.set(f.q, f.match);

  const accepts = (mask: Uint8Array | null, index: number): boolean => !mask || mask[index] === 1;

  /**
   * Pull one matching card out of a zone, or -1. The zone shrinks by one.
   *
   * The library is scanned from the top down, so an unfiltered move off it is a
   * draw and a filtered one is a tutor that finds the topmost copy — which in a
   * shuffled library is a uniformly random one. Every other zone is scanned in
   * whatever order the sequencer happens to hold it, which is the honest answer
   * for a goldfish: there is no opponent to play around and no reason to prefer
   * one Mountain in the yard over another.
   */
  const takeFrom = (zone: BehaviorZone, mask: Uint8Array | null): number => {
    switch (zone) {
      case 'library':
        for (let i = top; i < libLen; i++) {
          const index = library[i]!;
          if (!accepts(mask, index)) continue;
          library[i] = library[--libLen]!;
          return index;
        }
        return -1;
      case 'hand':
        for (let i = 0; i < handLen; i++) {
          const index = hand[i]!;
          // The commander sits in `hand` as bookkeeping, not as a card you may
          // put wherever you like. Same exemption pickDiscard makes.
          if (cards[index]!.commander || !accepts(mask, index)) continue;
          hand[i] = hand[--handLen]!;
          return index;
        }
        return -1;
      case 'graveyard':
        for (let i = 0; i < gyLen; i++) {
          const index = graveyard[i]!;
          if (!accepts(mask, index)) continue;
          graveyard[i] = graveyard[--gyLen]!;
          return index;
        }
        return -1;
      case 'exile':
        for (let i = 0; i < exLen; i++) {
          const index = exiled[i]!;
          if (!accepts(mask, index)) continue;
          exiled[i] = exiled[--exLen]!;
          return index;
        }
        return -1;
      case 'battlefield':
        // The battlefield here holds mana sources and nothing else, so this
        // finds a land or a rock and never the creature somebody meant. Said
        // out loud in the editor rather than discovered from a flat curve.
        for (let s = 0; s < srcLen; s++) {
          const index = srcCard[s]!;
          if (index < 0 || !accepts(mask, index)) continue;
          dropSource(s);
          return index;
        }
        return -1;
      default:
        return -1;
    }
  };

  /**
   * A card put onto the battlefield by a move rather than played for the turn.
   *
   * A mana source becomes one, arriving **tapped** — the same call the landramp
   * role already makes ("Rampant Growth exactly and Nature's Lore a turn late"),
   * and the conservative half of the two cards that print this. An Exploration
   * grants its extra drop from next turn, as it does when cast, because this
   * turn's drop has already happened.
   *
   * Everything else arrives and is not tracked: a reanimated creature is a body
   * this model has no room for. It really did leave the zone it was in, and it
   * really does nothing here, which is the omission §11.4 asks for rather than
   * the invention it forbids. It also does **not** fire its own behavior, which
   * is the one place that would have to be a rules engine: a rule that puts
   * cards onto the battlefield could reach cards whose rules do the same, and a
   * goldfish is not where anyone should find out how deep that goes.
   */
  const enterBattlefield = (index: number, card: SimCard, turn: number): void => {
    if (card.role === 'extraland') {
      if (extraLands < MAX_EXTRA_LANDS) extraLands++;
      return;
    }
    if (card.role === 'spell' || card.role === 'landramp') return;
    if (!addSource(index, card, turn + 1, turn)) return;
    colorsHeld |= card.mask;
    const back = payEntryCost(card);
    if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
  };

  /** Room for one more card in a zone. */
  const roomIn = (zone: BehaviorZone): boolean => {
    switch (zone) {
      case 'hand':
        return handLen < hand.length;
      case 'graveyard':
        return gyLen < graveyard.length;
      case 'exile':
        return exLen < exiled.length;
      default:
        return true;
    }
  };

  const putTo = (index: number, zone: BehaviorZone, turn: number): void => {
    switch (zone) {
      case 'hand':
        hand[handLen++] = index;
        return;
      case 'library':
        // The bottom, never the top: putting a card back where you would next
        // draw it is the generous reading and §11.4 does not allow one. Inside
        // eight turns the bottom of a real library is the same as gone, which
        // is also what the London mulligan's own bottoming means here — so a
        // library with no spare slot simply loses the card, and that is the
        // same statement rather than a different one.
        if (libLen < library.length) library[libLen++] = index;
        return;
      case 'graveyard':
        graveyard[gyLen++] = index;
        return;
      case 'exile':
        exiled[exLen++] = index;
        return;
      case 'battlefield':
        enterBattlefield(index, cards[index]!, turn);
        return;
    }
  };

  const moveCards = (step: BehaviorStep, count: number, turn: number): void => {
    const from = step.from;
    const to = step.to;
    if (!from || !to || from === to) return;
    const mask = step.q ? (filterMasks.get(step.q) ?? NO_MATCH) : null;
    for (let k = 0; k < count; k++) {
      if (!roomIn(to)) return;
      const index = takeFrom(from, mask);
      if (index < 0) return;
      // `seen` is cards that reached your hand off the library, which is what
      // the cards chart reads. A tutor counts; a regrowth does not.
      if (from === 'library' && to === 'hand') seen++;
      putTo(index, to, turn);
      if (sink) movedNames.push(cards[index]!.name);
    }
  };

  /**
   * Run a rule's steps in the order they were authored, and return the mana
   * they added to this turn.
   *
   * Every amount is read *as its step runs*, not once up front, which is what
   * makes a sequence worth having: "discard your hand, then draw cards equal to
   * the cards in your hand" is a very short rule, and this resolves it the way
   * the card would.
   */
  const runSteps = (steps: readonly BehaviorStep[], turn: number): number => {
    const bits: string[] = [];
    let made = 0;
    for (const step of steps) {
      const n = behaviorAmount(step, turn);
      if (n <= 0) continue;
      switch (step.op) {
        case 'draw':
          if (sink) drewNames.length = 0;
          drawCards(n);
          if (sink && drewNames.length) bits.push(`draws ${drewNames.join(', ')}`);
          break;
        case 'discard':
          if (sink) discardedNames.length = 0;
          discardCards(n);
          if (sink && discardedNames.length) bits.push(`discards ${discardedNames.join(', ')}`);
          break;
        case 'mill':
          if (sink) milledNames.length = 0;
          millCards(n);
          if (sink && milledNames.length) bits.push(`mills ${milledNames.join(', ')}`);
          break;
        case 'scry':
        case 'surveil':
          dig(n);
          if (sink) bits.push(`${step.op} ${n}`);
          break;
        case 'treasure': {
          const t = makeTreasures(n, turn);
          made += t;
          if (sink && t > 0) bits.push(`makes ${t} Treasure${t === 1 ? '' : 's'}`);
          break;
        }
        case 'move': {
          if (sink) movedNames.length = 0;
          moveCards(step, n, turn);
          if (sink && movedNames.length) {
            const where = ZONE_PHRASE.get(step.to ?? '') ?? 'somewhere';
            bits.push(`moves ${movedNames.join(', ')} to ${where}`);
          }
          break;
        }
      }
    }
    if (sink) lastEffectText = bits.join(', ');
    return made;
  };

  /** Does anything happen when this resolves, from either source? */
  const resolves = (card: SimCard): boolean => !!card.behavior || !!card.effect;

  const firstCast = new Int32Array(n);
  const firstHeld = new Int32Array(n);
  const firstPay = new Int32Array(groups);
  const payStamp = new Int32Array(groups).fill(-1);
  const units: ManaUnit[] = [];

  /** castAt[card * stride + turn]: games where that card was first castable then. */
  const castAt = new Uint32Array(n * stride);
  /** heldAt[card * stride + turn]: games where it first reached your hand then. */
  const heldAt = new Uint32Array(n * stride);
  const manaSum = new Float64Array(stride);
  /** Mana actually committed to spells, against the mana that was there to commit. */
  const spentSum = new Float64Array(stride);
  /** Cards off the top of the library: the opener plus every draw step. */
  const seenSum = new Float64Array(stride);
  /** Cards still in hand at end of turn, once the turn's spells have left it. */
  const handSum = new Float64Array(stride);
  const landDrops = new Uint32Array(stride);
  /** Every cost committed this turn, folded into one, so partial spends add up. */
  const paid: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [], faces: 1 };
  let handSizeSum = 0;
  let mulliganed = 0;
  const games = deckSize > 0 ? opts.games : 0;

  for (let game = 0; game < games; game++) {
    firstCast.fill(0);
    firstHeld.fill(0);
    firstPay.fill(0);
    srcLen = 0;
    grantMask = 0;
    recurLen = 0;
    extraLands = 0;
    colorsHeld = 0;
    handLen = 0;
    libLen = deckSize;
    top = 0;
    seen = 0;
    gyLen = 0;
    exLen = 0;

    // --- The opener, and however many mulligans it takes ---------------------
    for (let m = 0; ; m++) {
      library.set(deck.library);
      shuffle(library, deckSize, rng);
      libLen = deckSize;
      top = 0;
      let bottomAt = 0;
      handLen = Math.min(7, deckSize);
      for (let i = 0; i < handLen; i++) hand[i] = library[top++]!;

      const keep = opts.mulligan ? Math.min(handSize(opts.format, m), handLen) : handLen;
      if (opts.mulligan && keep > KEEP_ANYTHING_AT) {
        let lands = 0;
        for (let i = 0; i < handLen; i++) if (cards[hand[i]!]!.land) lands++;
        if (lands < opts.keepMin || lands > opts.keepMax) continue;
      }
      // London bottoms the difference. Which card goes back is a judgement
      // about the cards; the rule below is as close as a mana model gets to one.
      // The bottomed card lands in the dead space the opener left at the front
      // of the array, which is the bottom of a fifty-card library: it is still
      // in the deck, and it is not coming back inside eight turns.
      while (handLen > keep) {
        const drop = pickBottom(cards, hand, handLen);
        if (sink) sink.game.bottomed.push(cards[hand[drop]!]!.name);
        library[bottomAt++] = hand[drop]!;
        hand[drop] = hand[--handLen]!;
      }
      handSizeSum += handLen;
      if (handLen < 7) mulliganed++;
      if (sink) {
        sink.game.mulligans = m;
        for (let i = 0; i < handLen; i++) sink.game.opener.push(cards[hand[i]!]!.name);
        sink.game.opener.sort((a, b) => a.localeCompare(b));
      }
      // Seven cards came off the library whether you kept them or not, which
      // is what the cards chart counted before there was anything else to
      // count and what it still counts now.
      seen = top;
      break;
    }
    // The commander is a card you always have, from a zone you never draw, so
    // it joins the hand and stays there until it is cast.
    for (const c of deck.commanders) hand[handLen++] = c;

    for (let turn = 1; turn <= maxTurn; turn++) {
      if (sink) {
        sink.turn = { turn, lines: [], available: 0, spent: 0, hand: [] };
        sink.game.turns.push(sink.turn);
        castLines.length = 0;
      }
      // Upkeep, before the draw step, because that is where Phyrexian Arena
      // sits and the difference is one card in your opener's worth of ordering.
      // A recurring effect that makes Treasure makes it now, and the pool
      // rebuild below picks it up off the battlefield rather than off the
      // return value — which is why that return value is dropped here and
      // added by hand only inside the spend loop, after the pool is fixed.
      for (let r = 0; r < recurLen; r++) {
        const index = recurring[r]!;
        const card = cards[index]!;
        if (card.behavior) {
          if (card.behavior.upkeep.length === 0) continue;
          runSteps(card.behavior.upkeep, turn);
        } else if (card.effect) {
          resolveEffect(card.effect, turn);
        } else {
          continue;
        }
        if (sink && lastEffectText) say(sink, 'effect', `Upkeep: ${card.name} ${lastEffectText}`);
      }

      if (!(turn === 1 && opts.onPlay) && top < libLen && handLen < MAX_HAND) {
        const index = library[top++]!;
        hand[handLen++] = index;
        seen++;
        if (sink) say(sink, 'draw', `Draws ${cards[index]!.name}`);
      } else if (sink && turn === 1 && opts.onPlay) {
        say(sink, 'note', 'On the play, so no draw this turn');
      }

      // The mana already online, and the pool it makes, both of which the land
      // drop is a decision about.
      const pending = buildPool(turn);
      let needUntapped = false;
      // The cheapest thing in hand you still cannot pay for: the cost this
      // turn's land is really being chosen for.
      let goal: readonly Pip[] | null = null;
      let goalCmc = Infinity;
      for (let i = 0; i < handLen; i++) {
        const index = hand[i]!;
        const card = cards[index]!;
        const g = groupOf[index]!;
        if (g < 0 || !card.cost) continue;
        if (Math.ceil(card.cmc) === pending + 1) needUntapped = true;
        if (firstPay[g] !== 0 || card.cmc >= goalCmc) continue;
        goal = goalPips[g]!;
        goalCmc = card.cmc;
      }

      // --- Land drops -------------------------------------------------------
      // One, plus whatever an Exploration or an Azusa on the battlefield is
      // worth. `needUntapped` and `goal` are read once for the turn rather than
      // recomputed between drops: the second drop is a rare path and the first
      // one is the one the choice matters for.
      for (let drop = 0; drop <= extraLands; drop++) {
        // Candidates first, because most hands hold one land and one land is
        // not a decision. Scoring costs a matching solve apiece and this skips
        // it.
        let candidates = 0;
        let best = -1;
        for (let i = 0; i < handLen; i++) {
          if (!cards[hand[i]!]!.land) continue;
          landChoices[candidates++] = i;
          best = i;
        }
        if (candidates > 1) {
          let bestScore = -1;
          let ties = 0;
          for (let c = 0; c < candidates; c++) {
            const i = landChoices[c]!;
            const score = landScore(cards[hand[i]!]!, colorsHeld, needUntapped, goal, units);
            if (score < bestScore) continue;
            // §11.3: random where the policy is genuinely indifferent, and
            // nowhere else. Two Islands score the same and it does not matter
            // which one you play; letting hand order decide is free and wrong,
            // because swap-removal makes that order anything but uniform.
            if (score === bestScore) {
              ties++;
              if (rng.int(ties) !== 0) continue;
            } else {
              ties = 1;
              bestScore = score;
            }
            best = i;
          }
        }
        if (best < 0) {
          if (sink && drop === 0) say(sink, 'land', 'No land to play');
          break;
        }
        // The land-drop percentage is about the drop everybody gets, so an
        // Azusa turn still counts once rather than three times.
        if (drop === 0) landDrops[turn] = landDrops[turn]! + 1;
        if (sink) {
          const chosen = cards[hand[best]!]!;
          // The lands it turned down, by name and distinct. A hand with three
          // Mountains in it did not offer a choice worth reporting, and
          // "plays Mountain over Mountain" reads as a bug rather than as a
          // decision.
          const others = new Set<string>();
          for (let c = 0; c < candidates; c++) {
            const name = cards[hand[landChoices[c]!]!]!.name;
            if (name !== chosen.name) others.add(name);
          }
          const how = chosen.tapped === 'always' ? ' (enters tapped)' : '';
          const over = others.size > 0 ? ` over ${[...others].join(', ')}` : '';
          const extra = drop > 0 ? ' (extra land drop)' : '';
          say(sink, 'land', `Plays ${chosen.name}${how}${over}${extra}`);
        }
        const cardIndex = hand[best]!;
        const card = cards[cardIndex]!;
        hand[best] = hand[--handLen]!;
        if (card.role === 'fetch') {
          const at = findLand(cards, library, top, libLen, colorsHeld, card.fetchTargets, goal, units, rng);
          if (at >= 0) {
            const index = library[at]!;
            const land = cards[index]!;
            const slow = card.tapped === 'always' || land.tapped === 'always';
            if (addSource(index, land, turn + (slow ? 1 : 0), turn)) {
              colorsHeld |= land.mask;
              library[at] = library[--libLen]!;
              // The fetch itself is sacrificed, which means the yard, which
              // means a behavior can go and get it back.
              bury(cardIndex);
              if (sink) say(sink, 'land', `Cracks for ${land.name}${slow ? ' (enters tapped)' : ''}`);
              const back = payEntryCost(land);
              if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
              if (opts.effects && resolves(land)) {
                enters(index, land, turn);
                if (sink && lastEffectText) say(sink, 'effect', `${land.name} ${lastEffectText}`);
              }
            }
          } else if (sink) {
            say(sink, 'land', 'Nothing left in the library to fetch');
          }
        } else if (addSource(cardIndex, card, turn + (card.tapped === 'always' ? 1 : 0), turn)) {
          colorsHeld |= card.mask;
          const back = payEntryCost(card);
          if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
          // A Temple scries as it enters, and half the taplands printed since
          // Theros do something on the way in. Free, now that there is a
          // resolver to call.
          if (opts.effects && resolves(card)) {
            enters(cardIndex, card, turn);
            if (sink && lastEffectText) say(sink, 'effect', `${card.name} ${lastEffectText}`);
          }
        }
      }

      // --- What could you pay for, with everything untapped -----------------
      // Not const any more: a Treasure made mid-turn is mana this turn, and it
      // has to reach both the spend loop's budget and the chart. Recorded after
      // the turn rather than here, so the available line is never below the
      // spent line — the trajectory chart's right-hand labels lean on that.
      let available = buildPool(turn);
      if (sink) {
        const bits: string[] = [];
        for (let u = 0; u < units.length; u++) {
          bits.push(`${sourceName(unitOwner[u]!)} (${pipText(units[u]!.colors)})`);
        }
        for (let g = 0; g < unitGroups.length; g++) {
          const grp = unitGroups[g]!;
          bits.push(`${sourceName(groupOwner[g]!)} (${grp.count} of one of ${pipText(grp.colors)})`);
        }
        say(sink, 'mana', bits.length === 0 ? 'No mana available' : `${available} mana untapped: ${bits.join(', ')}`);
      }

      // Which of the cards in hand the mana covers. Only cards in hand: the
      // manabase number this feeds is conditional on holding the card, so
      // solving a cost still sitting in the library would be work nothing reads.
      //
      // The pool only ever grows, so "payable" is monotone in the turn and one
      // solve per cost per game is enough. `payStamp` covers the rest: two
      // cards in hand at the same cost are one question.
      const stamp = game * stride + turn;
      for (let i = 0; i < handLen; i++) {
        const index = hand[i]!;
        const g = groupOf[index]!;
        if (g < 0) continue;
        if (firstHeld[index] === 0) firstHeld[index] = turn;
        if (firstCast[index] !== 0) continue;
        if (firstPay[g] === 0 && payStamp[g] !== stamp) {
          payStamp[g] = stamp;
          if (canPay(cards[index]!.cost!, units, unitGroups)) firstPay[g] = turn;
        }
        if (firstPay[g] !== 0) firstCast[index] = turn;
      }

      // --- Spend the turn ---------------------------------------------------
      // Until this phase existed the sequencer cast exactly one ramp spell a
      // turn and nothing else, because anything more meant accounting for
      // partially spent mana (§8's stated omission). `paid` is that accounting:
      // every cost committed this turn is folded into one cost and the whole
      // thing is re-solved, so "can I still afford this as well" is the same
      // canPay question the rest of the file already trusts.
      //
      // Ramp goes first, most expensive first. It is not a preference, it is
      // the only ordering that does not cost you mana later: a Signet cast
      // before the three-drop is a source next turn, and cast after it is a
      // card in hand. The rest is spend-down, priciest first, with a coin flip
      // between equals so that two four-drops in hand do not always resolve in
      // decklist order.
      paid.generic = 0;
      paid.pips.length = 0;
      paid.mana = 0;
      let spent = 0;
      for (let cast = 0; cast < MAX_CASTS_PER_TURN; cast++) {
        const left = available - spent;
        if (left <= 0) break;
        let pick = -1;
        let pickRank = -1;
        let ties = 0;
        for (let i = 0; i < handLen; i++) {
          const card = cards[hand[i]!]!;
          if (!card.spell || !card.cost) continue;
          // The cheap test first: a cost that wants more mana than is left
          // cannot be paid whatever colors it wants, and skipping it here is
          // what keeps the solver off nine tenths of the hand.
          if (card.cost.mana > left) continue;
          const ramp = card.role === 'rock' || card.role === 'dork' || card.role === 'landramp';
          const rank = (ramp ? 1000 : 0) + card.cost.mana;
          if (rank < pickRank) continue;
          // Reservoir sampling over the ties, so the choice is uniform among
          // equals without building a list to shuffle.
          if (rank === pickRank) {
            ties++;
            if (rng.int(ties) !== 0) continue;
          } else {
            ties = 1;
            pickRank = rank;
          }
          pick = i;
        }
        if (pick < 0) {
          if (sink && left > 0) {
            let holding = 0;
            for (let i = 0; i < handLen; i++) if (cards[hand[i]!]!.spell) holding++;
            say(
              sink,
              'note',
              holding > 0
                ? `Stops with ${left} mana up: nothing left in hand costs ${left} or less`
                : `Stops with ${left} mana up and no spell in hand`,
            );
          }
          break;
        }
        // Only now does the matching solver run, and only on the one card the
        // policy actually wants to cast.
        const index = hand[pick]!;
        const card = cards[index]!;
        const before = paid.pips.length;
        paid.generic += card.cost!.generic;
        for (const pip of card.cost!.pips) paid.pips.push(pip);
        if (!canPay(paid, units, unitGroups)) {
          // Unaffordable in *these* colors alongside what is already committed.
          // Roll it back and stop: the next-best card is usually the same
          // colors and re-scanning the hand for it costs more than it wins.
          paid.generic -= card.cost!.generic;
          paid.pips.length = before;
          if (sink) {
            say(
              sink,
              'note',
              castLines.length > 0
                ? `Stops: ${card.name} ${card.manaCost} is not payable in these colours alongside what is already cast`
                : `Stops: ${card.name} ${card.manaCost} is not payable in these colours`,
            );
          }
          break;
        }
        paid.mana += card.cost!.mana;
        spent += card.cost!.mana;
        hand[pick] = hand[--handLen]!;
        if (sink && sink.turn) {
          const why = card.role === 'rock' || card.role === 'dork' || card.role === 'landramp' ? ' (ramp first)' : '';
          say(sink, 'cast', `Casts ${card.name} ${card.manaCost}${why}`);
          // The taps arrive on this line later. The turn has to finish
          // committing first, because there is only one cost to solve and it is
          // the whole turn's.
          castLines.push({
            line: sink.turn.lines[sink.turn.lines.length - 1]!,
            generic: card.cost!.generic,
            pips: card.cost!.pips.length,
          });
        }

        if (card.role === 'landramp') {
          // What it fetches is a land out of the library, arriving tapped. That
          // is Rampant Growth exactly and Nature's Lore a turn late, which is
          // the conservative half of the two.
          for (let k = 0; k < card.adds; k++) {
            const at = findLand(cards, library, top, libLen, colorsHeld, null, goal, units, rng);
            if (at < 0) break;
            const found = library[at]!;
            const land = cards[found]!;
            if (!addSource(found, land, turn + 1, turn)) break;
            colorsHeld |= land.mask;
            library[at] = library[--libLen]!;
            if (sink) say(sink, 'mana', `Finds ${land.name}, which arrives tapped`);
            const back = payEntryCost(land);
            if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
          }
          // The mana that cast it has been spent, and a dork is summoning sick
          // on top of that, so either way it pays for something from next turn.
        } else if (card.role === 'rock' || card.role === 'dork') {
          if (addSource(index, card, turn + 1, turn)) {
            colorsHeld |= card.mask;
            // A filter like Prophetic Prism profiles at zero net mana: it fixes
            // colours and adds none. "Will add 0" is true and reads like a bug,
            // so it says what the card is for instead.
            if (sink) {
              const colors = pipText(UNIT_BY_MASK[card.mask]!.colors);
              say(
                sink,
                'mana',
                card.adds > 0
                  ? `${card.name} will add ${card.adds} ${colors} from next turn`
                  : `${card.name} will filter mana into ${colors} from next turn, adding none`,
              );
            }
          }
        } else if (card.role === 'extraland') {
          // From next turn, not this one: this turn's land drop already
          // happened, above, and an Exploration cast after it does not rewind
          // the turn. Conservative by exactly one land drop, once.
          if (extraLands < MAX_EXTRA_LANDS) extraLands++;
          if (sink) say(sink, 'mana', 'An extra land drop every turn, from next turn');
        }
        // And what the card *does*, which until this phase was nothing at all.
        // A Treasure made here is mana this turn, so the budget grows under the
        // loop's feet — which is the point of a Treasure and the reason `left`
        // is recomputed from `available` at the top of every pass.
        if (opts.effects) {
          available += enters(index, card, turn);
          if (sink && resolves(card)) {
            // A behavior with an upkeep rule and no play rule is the same shape
            // as a repeatable profile: nothing happened now, something will.
            const recurs = card.behavior ? card.behavior.play.length === 0 : card.effect!.repeatable;
            say(
              sink,
              'effect',
              recurs ? `${card.name} will fire every upkeep from next turn` : `${card.name} ${lastEffectText || 'resolves'}`,
            );
          }
        }
        // And where the card itself ends up. A permanent stays out, as a source
        // if it makes mana and as an untracked body if it does not; everything
        // else is in the graveyard once it has resolved, which is where a
        // behavior can go and find it. After the effect, not before, because a
        // sorcery is on the stack while it resolves and a Regrowth that finds
        // itself is a rules error rather than a rounding one.
        if (!card.permanent) bury(index);
        // A card with no effect profile still resolves as a blank. For a
        // Lightning Bolt that is correct; for a draw spell whose draw hangs off
        // a trigger the pipeline would not read, it is the floor §11.4 warned
        // about, and SimDeck.coverage is what says how much of the deck it is.
      }

      // --- Treasures, reconciled -------------------------------------------
      // Lands and rocks are spent first and a Treasure only when the turn runs
      // past them, in quantity or in colour. Whatever the spending reached gets
      // cracked; the rest is still there next turn, which is the whole reason a
      // Treasure is worth more than a ritual.
      //
      // The trace's tap breakdown comes out of the same solve, which is why it
      // waits until here: attributed against the full pool it would happily
      // show four Treasures paying for a turn the model charges two for.
      const treasures = countTreasures();
      let attributed = false;
      if (treasures > 0 && spent > 0) {
        const cracked = treasuresSpent(turn, treasures);
        if (sink) {
          attributeTaps(castLines, thrifty, thriftyOwner);
          attributed = true;
        }
        if (cracked > 0) {
          crackTreasures(cracked);
          if (sink) say(sink, 'mana', `Sacrifices ${cracked} Treasure${cracked === 1 ? '' : 's'} to cover the turn`);
        }
      }
      if (sink && !attributed) attributeTaps(castLines, units, unitOwner);

      if (sink && sink.turn) {
        sink.turn.available = available;
        sink.turn.spent = spent;
        for (let i = 0; i < handLen; i++) sink.turn.hand.push(cards[hand[i]!]!.name);
        sink.turn.hand.sort((a, b) => a.localeCompare(b));
      }
      manaSum[turn] = manaSum[turn]! + available;
      spentSum[turn] = spentSum[turn]! + spent;
      seenSum[turn] = seenSum[turn]! + seen;
      handSum[turn] = handSum[turn]! + handLen;
    }

    for (let i = 0; i < n; i++) {
      const t = firstCast[i]!;
      if (t > 0) castAt[i * stride + t] = castAt[i * stride + t]! + 1;
    }
    for (let i = 0; i < n; i++) {
      const t = firstHeld[i]!;
      if (t > 0) heldAt[i * stride + t] = heldAt[i * stride + t]! + 1;
    }
    if (onProgress && (game + 1) % PROGRESS_EVERY === 0) onProgress(game + 1);
  }

  return summarise(deck, opts, games, {
    castAt,
    heldAt,
    groupOf,
    stride,
    manaSum,
    spentSum,
    seenSum,
    handSum,
    landDrops,
    handSizeSum,
    mulliganed,
  });
}

/**
 * Which land to play. Two things decide it: whether you need the mana *this*
 * turn, and what colors you are missing. Everything else is a tie-break.
 *
 * The "dump the tapland while it is free" half is the part a hypergeometric
 * cannot express and the part that makes taplands cost less than the tapland
 * tax says they do. A Temple played on turn one against a hand with nothing to
 * cast costs you nothing at all.
 */
function landScore(
  card: SimCard,
  colorsHeld: number,
  needUntapped: boolean,
  goal: readonly Pip[] | null,
  pool: ManaUnit[],
): number {
  // How much closer this land gets you to the cost you are stuck on. Counting
  // colors instead gets this backwards for exactly the deck that needs it most:
  // a player holding Counterspell over an Island and a Mountain plays two
  // Islands, and a "widen your colors" tie-break plays one of each and then
  // wonders why the double pip never assembles. Matching sees it, because that
  // is the question it was written for.
  let matched = 0;
  if (goal && goal.length > 0 && card.mask !== 0) {
    const unit = UNIT_BY_MASK[card.mask]!;
    // A source whose mana is all one color is worth one unit to a *matching*,
    // whatever it adds: three mana of any one color would otherwise cover one
    // pip of each of three colors here and none of them at the table. Scoring
    // it at one understates the land, which is the direction to be wrong in.
    const worth = card.oneColor ? 1 : card.adds;
    for (let u = 0; u < worth; u++) pool.push(unit);
    matched = maxMatching(goal, pool);
    pool.length -= worth;
  }
  // A conditional tapland is untapped whenever you want it to be, which is the
  // same call the tapland tax makes by leaving them out of its average.
  const fast = card.tapped !== 'always';
  const timingOk = needUntapped ? fast : !fast;
  const fresh = popcount(card.mask & ~colorsHeld);
  return matched * 1000 + (timingOk ? 100 : 0) + fresh * 10 + (card.modal ? 0 : 3) + (card.mask !== 0 ? 1 : 0);
}

/**
 * The best land still in the library, as a position in it. `targets` is a
 * fetch's reach; null means any land that makes mana, which is what land ramp
 * goes and gets. Widest new color wins, untapped breaks the tie.
 */
function findLand(
  cards: SimCard[],
  library: Int32Array,
  from: number,
  to: number,
  colorsHeld: number,
  targets: readonly number[] | null,
  goal: readonly Pip[] | null,
  pool: ManaUnit[],
  rng: Rng,
): number {
  let best = -1;
  let bestScore = -1;
  let ties = 0;
  for (let i = from; i < to; i++) {
    const index = library[i]!;
    const card = cards[index]!;
    if (card.role !== 'land' || card.mask === 0) continue;
    if (targets && !targets.includes(index)) continue;
    // Same rule as the land drop: the cost you are stuck on comes first. A
    // Scalding Tarn cracked on colors alone finds an Island half the time when
    // what you are holding is a Bolt.
    let matched = 0;
    if (goal && goal.length > 0) {
      const unit = UNIT_BY_MASK[card.mask]!;
      const worth = card.oneColor ? 1 : card.adds;
      for (let u = 0; u < worth; u++) pool.push(unit);
      matched = maxMatching(goal, pool);
      pool.length -= worth;
    }
    const score = matched * 1000 + popcount(card.mask & ~colorsHeld) * 10 + (card.tapped === 'always' ? 0 : 1);
    if (score < bestScore) continue;
    // Four Islands left in the library are four identical answers, and taking
    // the first is taking a position in a shuffled array — which is uniform
    // today and stops being uniform the moment a fetch swap-removes into it.
    if (score === bestScore) {
      ties++;
      if (rng.int(ties) !== 0) continue;
    } else {
      ties = 1;
      bestScore = score;
    }
    best = i;
  }
  return best;
}

/**
 * Which card goes to the bottom. More than half lands and the worst land goes
 * (the tapped one first, since the early turns are the ones a mulligan is
 * trying to survive); otherwise the most expensive spell, which is the card a
 * short hand is least likely to reach.
 */
function pickBottom(cards: SimCard[], hand: Int32Array, handLen: number): number {
  let lands = 0;
  for (let i = 0; i < handLen; i++) if (cards[hand[i]!]!.land) lands++;
  const flooded = lands * 2 > handLen;
  let pick = 0;
  let best = -1;
  for (let i = 0; i < handLen; i++) {
    const card = cards[hand[i]!]!;
    const score = flooded
      ? card.land
        ? card.tapped === 'always'
          ? 3
          : 2
        : 0
      : card.land
        ? 0
        : Math.ceil(card.cmc);
    if (score > best) {
      best = score;
      pick = i;
    }
  }
  return pick;
}

/**
 * Which card a loot throws away. The same judgement as `pickBottom` — a spare
 * land when you are flooded, otherwise the card you are least likely to reach —
 * with one card exempt.
 *
 * The commander sits in `hand` because it is available from turn one and never
 * drawn, which is a bookkeeping convenience and not a claim that it can be
 * discarded. Throwing it away would not be a conservative approximation, it
 * would be a rules error that makes the deck look worse for no reason.
 *
 * Returns -1 when there is nothing left to discard, which is what a Faithless
 * Looting off an empty hand should do.
 */
function pickDiscard(cards: SimCard[], hand: Int32Array, handLen: number): number {
  let lands = 0;
  let any = false;
  for (let i = 0; i < handLen; i++) {
    const card = cards[hand[i]!]!;
    if (card.commander) continue;
    any = true;
    if (card.land) lands++;
  }
  if (!any) return -1;
  const flooded = lands * 2 > handLen;
  let pick = -1;
  let best = -1;
  for (let i = 0; i < handLen; i++) {
    const card = cards[hand[i]!]!;
    if (card.commander) continue;
    const score = flooded
      ? card.land
        ? card.tapped === 'always'
          ? 3
          : 2
        : 0
      : card.land
        ? 0
        : Math.ceil(card.cmc);
    if (score > best) {
      best = score;
      pick = i;
    }
  }
  return pick;
}

interface Tallies {
  castAt: Uint32Array;
  heldAt: Uint32Array;
  groupOf: Int32Array;
  stride: number;
  manaSum: Float64Array;
  spentSum: Float64Array;
  seenSum: Float64Array;
  handSum: Float64Array;
  landDrops: Uint32Array;
  handSizeSum: number;
  mulliganed: number;
}

function summarise(deck: SimDeck, opts: SimOptions, games: number, t: Tallies): SimResult {
  const { castAt, heldAt, groupOf, stride, manaSum, spentSum, seenSum, handSum, landDrops } = t;
  const per = games > 0 ? 1 / games : 0;

  /** A first-turn histogram turned into "by turn t", which is what anyone reads. */
  const cumulative = (counts: Uint32Array, base: number): Float64Array => {
    const out = new Float64Array(stride);
    let cum = 0;
    for (let turn = 1; turn < stride; turn++) {
      cum += counts[base + turn]!;
      out[turn] = cum;
    }
    return out;
  };

  // Pass one: the raw per-card counts, and the pooled totals per printed cost.
  interface Pending {
    card: SimCard;
    group: number;
    held: Float64Array;
    cast: Float64Array;
    curveTurn: number;
    copies: number;
  }
  const pending: Pending[] = [];
  const pooledHeld = new Map<number, Float64Array>();
  const pooledCast = new Map<number, Float64Array>();

  for (let i = 0; i < deck.cards.length; i++) {
    const card = deck.cards[i]!;
    const g = groupOf[i]!;
    if (!card.spell || g < 0) continue;
    const held = cumulative(heldAt, i * stride);
    const cast = cumulative(castAt, i * stride);
    // A commander pools with nobody. Pooling exists to borrow sample from cards
    // that share an answer, and the commander already has every game in the run
    // behind it: it is in hand from turn one, so its denominator is the whole
    // 20,000. Folding it in with a three-of at the same cost would mix two
    // different conditionals and make the better estimate worse.
    const pool = card.commander ? -(g + 1) : g;
    pending.push({
      card,
      group: pool,
      held,
      cast,
      // From the parsed cost rather than Scryfall's `cmc`, which sums both
      // halves of a split card and so holds a two-mana Fire to turn four.
      curveTurn: Math.min(opts.maxTurn, Math.max(1, Math.ceil(card.cost!.mana))),
      copies: card.copies + (card.commander ? 1 : 0),
    });
    const ph = pooledHeld.get(pool) ?? new Float64Array(stride);
    const pc = pooledCast.get(pool) ?? new Float64Array(stride);
    for (let turn = 1; turn < stride; turn++) {
      ph[turn] = ph[turn]! + held[turn]!;
      pc[turn] = pc[turn]! + cast[turn]!;
    }
    pooledHeld.set(pool, ph);
    pooledCast.set(pool, pc);
  }

  /** Pooled P(payable | held), which is 0 where nothing was ever held to ask. */
  const pooledPay = (g: number): number[] => {
    const held = pooledHeld.get(g)!;
    const cast = pooledCast.get(g)!;
    const out = [0];
    for (let turn = 1; turn < stride; turn++) out.push(held[turn]! > 0 ? cast[turn]! / held[turn]! : 0);
    return out;
  };

  const costs: SimCostGroup[] = [];
  const byGroup = new Map<number, SimCostGroup>();
  const results: SimCardResult[] = [];
  const commanders: SimCardResult[] = [];
  let weight = 0;
  let weighted = 0;

  for (const p of pending) {
    const payByTurn = pooledPay(p.group);
    const onCurvePay = payByTurn[p.curveTurn]!;
    const heldByTurn = [0, ...[...p.held].slice(1).map((count) => count * per)];
    const castByTurn = [0, ...[...p.cast].slice(1).map((count) => count * per)];
    (p.card.commander ? commanders : results).push({
      oracleId: p.card.oracleId,
      name: p.card.name,
      manaCost: p.card.manaCost,
      cmc: p.card.cmc,
      curveTurn: p.curveTurn,
      copies: p.copies,
      commander: p.card.commander,
      heldByTurn,
      payByTurn,
      castByTurn,
      onCurvePay,
      onCurveCast: castByTurn[p.curveTurn]!,
      paySample: pooledHeld.get(p.group)![p.curveTurn]!,
    });
    weight += p.copies;
    weighted += p.copies * onCurvePay;

    // The commander has its own section, so it gets no cost row: a row reading
    // "1 card at this cost" next to a block about that same card is noise.
    if (p.card.commander) continue;
    const existing = byGroup.get(p.group);
    if (existing) {
      existing.names.push(p.card.name);
      existing.copies += p.copies;
      continue;
    }
    const row: SimCostGroup = {
      manaCost: p.card.manaCost,
      cmc: p.card.cmc,
      curveTurn: p.curveTurn,
      names: [p.card.name],
      copies: p.copies,
      payByTurn,
      onCurvePay,
      sample: pooledHeld.get(p.group)![p.curveTurn]!,
    };
    byGroup.set(p.group, row);
    costs.push(row);
  }

  // Worst first: the point of both lists is the thing that is losing you games,
  // and a tie goes to the more expensive one, which is the harder fix.
  const worstFirst = (a: { onCurvePay: number; cmc: number }, b: { onCurvePay: number; cmc: number }) =>
    a.onCurvePay - b.onCurvePay || b.cmc - a.cmc;
  results.sort((a, b) => worstFirst(a, b) || a.name.localeCompare(b.name));
  costs.sort((a, b) => worstFirst(a, b) || a.manaCost.localeCompare(b.manaCost));
  for (const row of costs) row.names.sort((a, b) => a.localeCompare(b));

  return {
    games,
    maxTurn: opts.maxTurn,
    cards: results,
    commanders,
    costs,
    manaByTurn: [...manaSum].map((sum) => sum * per),
    manaSpentByTurn: [...spentSum].map((sum) => sum * per),
    cardsSeenByTurn: [...seenSum].map((sum) => sum * per),
    handSizeByTurn: [...handSum].map((sum) => sum * per),
    landDropByTurn: [...landDrops].map((count) => count * per),
    pMulligan: t.mulliganed * per,
    meanHandSize: t.handSizeSum * per,
    deckOnCurve: weight > 0 ? weighted / weight : 0,
  };
}

/**
 * Deal one game and write it down.
 *
 * It calls the same `simulate()` the charts do, with `games: 1` and a sink
 * attached. That is the whole point: a trace produced by a second, friendlier
 * implementation would agree with the real sequencer right up until the day it
 * mattered, and the reason to show anybody a game at all is so they can catch
 * this one being wrong.
 *
 * One game is microseconds, so this runs on the main thread. The twenty
 * thousand behind the charts do not, and that is the only difference.
 */
export function traceGame(deck: SimDeck, opts: SimOptions, seed: number): GameTrace {
  const sink = newTraceSink(seed);
  simulate(deck, { ...opts, games: 1, seed, trace: true }, undefined, sink);
  return sink.game;
}

// --- Worker protocol ---------------------------------------------------------
// The deck is built on the main thread, where the oracle rows are, and posted
// across; everything in SimDeck is a plain object or a typed array so it
// survives structured clone.

export interface SimRequest {
  deck: SimDeck;
  opts: SimOptions;
}

export type SimResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; result: SimResult }
  | { type: 'error'; message: string };
