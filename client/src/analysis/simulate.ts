import {
  applyAmountOp,
  BEHAVIOR_ZONES,
  MAX_QUERY_X,
  type BehaviorAmount,
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
import { popcount, UNIT_BY_MASK, type SimCard, type SimDeck, type SimFilter } from './simDeck.js';

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
/**
 * How many triggers can be stacked on top of each other. A rule that puts a
 * card onto the battlefield can reach a card whose rule does the same, and a
 * sacrifice can reach a death trigger that sacrifices something else. Two is
 * one level deeper than any card worth modelling goes.
 */
const MAX_TRIGGER_DEPTH = 2;

/**
 * Room for the permanents you control, which is a longer list than the mana
 * sources: every creature, every enchantment and every artifact is on it, and
 * only some of those tap for anything.
 */
const MAX_PERMANENTS = 128;

/** Cards one effect may put into your hand. Guards a misread "draw X". */
const MAX_DRAW_PER_EFFECT = 12;

/**
 * Room for the hand. Seven plus eight turns of draw steps never came near the
 * old 96 and a deck full of card draw still does not, but every point that
 * grows the hand now checks the bound rather than assuming it.
 */
const MAX_HAND = 128;

/** How a zone reads in a trace line as a destination: "to the top of your library". */
const ZONE_PHRASE = new Map(BEHAVIOR_ZONES.map((z) => [z.id as string, z.into ?? z.phrase]));

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

/**
 * One card's share of the two trajectory lines — phase 13.
 *
 * This is **accounting, not a counterfactual.** It says what happened in the
 * games that were played: whose rule drew the card, whose permanent made the
 * mana. It does not say what would happen if you cut the card, and the two are
 * different numbers whenever cards work together. Play an Opt with an Archmage
 * Emeritus out and the accounting hands each of them one card, because each of
 * them drew one. Cut the Opt and you lose two, because the trigger goes with
 * it. Marginal contributions do not add up and this does, which is the whole
 * reason it is the one being reported: every row here is a slice of a line on
 * the chart above it.
 *
 * The one place the accounting is knowingly generous: a land another card went
 * and got is credited to the card that got it, for as long as it is on the
 * battlefield. Skyshroud Claim owns its two Forests forever. Some of that mana
 * would have turned up anyway off the top of your library, so a deck full of
 * fetches and land tutors reads high.
 */
export interface SimContribution {
  oracleId: string;
  name: string;
  copies: number;
  /** Mean mana available on turn t that this card's sources made, indexed by turn. */
  manaByTurn: number[];
  /** Mean cards drawn off the library by turn t by this card's rules. Cumulative. */
  cardsByTurn: number[];
  /** `manaByTurn` summed over every charted turn: the mana it was worth all game. */
  mana: number;
  /** `cardsByTurn` at the last charted turn. */
  cards: number;
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
  /**
   * Who made the two lines above, worth-most first. Only cards that contributed
   * something: a Lightning Bolt makes no mana and draws nothing, and a row of
   * zeroes for every removal spell in the deck would bury the ones that matter.
   */
  contributions: SimContribution[];
  /** Cards seen by turn t that came off the opener, mulligans included. */
  seenFromOpener: number[];
  /** Cards seen by turn t that came off the draw step. */
  seenFromDrawStep: number[];
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
 *   5. Record every card in hand you could pay for with everything untapped,
 *      plus whatever the rituals in hand would add to that. Taken *before* any
 *      mana is spent, because the card you are asking about is the card you
 *      would have spent it on.
 *   6. Spend the turn. Ramp first, priciest first, because a Signet cast before
 *      the three-drop is a source next turn and cast after it is a card in
 *      hand; a ritual counts as ramp for the same reason, and is cast only when
 *      something else in hand is waiting on exactly the mana it makes. Then the
 *      rest of the hand, priciest first, until the mana is gone.
 *      A tie between equals is a coin flip rather than decklist order. An X
 *      spell goes **last** of all, and X is then whatever the turn has left
 *      over, which is what a player does with it and costs nothing precisely
 *      because it goes last. It is held rather than cast when nothing is left
 *      over, because a Fireball for zero spends the card and buys nothing.
 *   7. A card the database has an effect profile for resolves it: cards into
 *      hand, cards out of it, cards off the top into the graveyard, Treasures
 *      onto the battlefield, mana into your mana pool, and a dig that goes
 *      looking for a land only when you have none. A Treasure is cracked the
 *      first turn the spending actually reaches it; mana in the pool is gone at
 *      the end of the turn whether you spent it or not. Everything else still resolves as a blank, which
 *      is right for a Lightning Bolt and wrong for every draw spell whose draw
 *      hangs off a trigger the pipeline would not read. So the curves are
 *      still a floor, and `SimDeck.coverage` is how far off the floor they are.
 *   8. A card put back into the library lands in a **random** spot, because a
 *      shuffle is what a deck is. The top and the bottom are separate
 *      destinations and go where they say, and more than one card sent to
 *      either arrives in a random order rather than in whatever order the zone
 *      it came from happened to hold it.
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

  /**
   * The library, with room above the deck size for cards put *back* into it.
   *
   * It used to be exactly `deckSize`, which quietly made "put a card on the
   * bottom of your library" a no-op in every deck without a fetch: `libLen`
   * only ever shrank when a tutor or a fetch pulled a card out, so there was
   * never a spare slot to write into and the card was dropped. The headroom is
   * the fix, and MAX_HAND is comfortably past anything a hand and a graveyard
   * can hand back inside eight turns.
   */
  const library = new Int32Array(deckSize + MAX_HAND);
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
  /**
   * Which card *put it there*, which is not the same question and is the whole
   * of §13's mana credit. A land you played from hand answers itself. A Forest
   * a Skyshroud Claim went and got answers Skyshroud Claim, for as long as the
   * Forest is on the battlefield, because the Forest is in the library in the
   * game where you never drew the Claim.
   */
  const srcBy = new Int32Array(MAX_SOURCES);
  /** A Treasure, so it can be sacrificed for the mana it just paid. */
  const srcTreasure = new Uint8Array(MAX_SOURCES);
  /**
   * Floating mana: a ritual's burst, or a landfall trigger's, sitting in your
   * mana pool for this turn and gone at the end of it.
   *
   * Filed with the sources because `units` is what the payment solver reads and
   * this is mana the solver has to see. Flagged because it is not on the
   * battlefield and never was: nothing sacrifices it, nothing bounces it,
   * `landsInPlay` does not count it, and `emptyPool` takes the slot back when
   * the turn ends whether the mana was spent or not. That last line is the
   * whole difference between a ritual and a Treasure.
   */
  const srcFloating = new Uint8Array(MAX_SOURCES);
  const unitGroups: UnitGroup[] = [];
  /**
   * The battlefield, as permanents rather than as mana.
   *
   * `srcCard` and friends are the *mana* view: what taps, for how much, from
   * when. It has always been a subset, and for nine phases it was the only
   * view, which is why "sacrifice a creature" found a land and "creatures you
   * control" could not be asked at all. This list is every card that stays on
   * the battlefield, mana or not, and the two are kept in step at the one place
   * a permanent arrives (`addSource` and `addPermanent`) and the one place it
   * leaves (`leavePlay`).
   *
   * Card *indices*, so two copies of the same card are two entries with the
   * same number in them — the same convention `srcCard` has always used, and
   * the reason `leavePlay` removes the first match rather than all of them.
   */
  const permCard = new Int32Array(MAX_PERMANENTS);
  /** The turn it arrived, so summoning sickness is `permSince === turn`. */
  const permSince = new Int32Array(MAX_PERMANENTS);
  /** Last turn it is still around, or 0 for "it does not go away". */
  const permUntil = new Int32Array(MAX_PERMANENTS);
  let permLen = 0;
  /** Permanents with a recurring effect, as card indices. Phyrexian Arena. */
  const recurring = new Int32Array(MAX_SOURCES);
  let recurLen = 0;
  /** Land drops beyond the first, from an Exploration or an Azusa in play. */
  let extraLands = 0;
  /** Trigger lines waiting for the rule that caused them to be written. */
  const pendingEntry: string[] = [];
  /**
   * The cost the turn's land drop is being chosen for, hoisted out of the turn
   * loop so a fetch cracked mid-rule aims at the same thing a fetch cracked on
   * your land drop does. Null before the first drop of the game.
   */
  let turnGoal: readonly Pip[] | null = null;
  /**
   * How many triggers deep we are. A rule that puts a card onto the battlefield
   * can reach a card whose rule does the same; this is the whole answer to
   * that, and two is one more level than any real card needs.
   */
  let triggerDepth = 0;
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
  /**
   * How far down the front of the array the London mulligan's bottomed cards
   * reach. Everything from here to `top` is dead space left by the opener, and
   * that is where a card put on *top* of the library goes — so this is the line
   * it must not cross, or a bottomed card gets overwritten by one.
   */
  let libFloor = 0;
  let seen = 0;
  /**
   * Who is responsible for what happens next — §13's card credit, and the only
   * new piece of state the accounting needed.
   *
   * Set to the card holding the rule for as long as that rule is running, which
   * makes a draw inside a magecraft trigger credit Archmage Emeritus and the
   * draw inside Opt's own rule credit Opt. -1 is the game itself: your opener
   * and your draw step belong to nobody, and crediting them to a card would put
   * seven cards against whichever one happened to be resolving.
   */
  let creditTo = -1;
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
  const buildPool = (turn: number, credit = false): number => {
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
      // In the same walk that produces the number, so the two can never
      // disagree about which sources were online. This runs on the land-drop
      // rehearsal too, which is why it is a flag and not a second loop.
      if (credit) creditMana(srcBy[s]!, turn, n);
      const mask = srcIsLand[s] ? srcMask[s]! | grantMask : srcMask[s]!;
      const owner = srcFloating[s] ? floatOwner(srcCard[s]!) : srcCard[s]!;
      if (srcOneColor[s] && n > 1) {
        unitGroups.push({ colors: UNIT_BY_MASK[mask]!.colors, count: n });
        if (sink) groupOwner.push(owner);
      } else {
        for (let u = 0; u < n; u++) {
          units.push(UNIT_BY_MASK[mask]!);
          if (sink) unitOwner.push(owner);
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
  /**
   * The cast lines of the turn being written, waiting for their tap breakdown.
   * `card` is what was cast, so a floating unit can be told apart from the
   * spell that made it.
   */
  interface CastLine {
    line: TraceLine;
    card: number;
    generic: number;
    pips: number;
  }
  const castLines: CastLine[] = [];

  /**
   * Who a unit in the pool belongs to, as the trace wants to say it.
   *
   * A plain card index is a permanent that taps. -1 is a Treasure token, which
   * is nobody's card. Anything below that is *floating mana* made by a card,
   * encoded rather than given a parallel array because `unitOwner` is rebuilt
   * every turn in the pool walk and a second array would have to be kept in
   * step with it at four sites instead of one.
   */
  const floatOwner = (index: number): number => -2 - index;
  const isFloating = (owner: number): boolean => owner <= -2;
  const ownerCard = (owner: number): number => (owner <= -2 ? -2 - owner : owner);

  /** What a permanent is called, for a trace line. -1 is a Treasure token. */
  const sourceName = (owner: number): string =>
    owner === -1 ? 'Treasure' : (cards[ownerCard(owner)]?.name ?? 'a source');

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
  const attributeTaps = (casts: CastLine[], pool: readonly ManaUnit[], owners: readonly number[]): void => {
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
    /** One row per unit the plan actually spent: which unit, on which cast. */
    const spent: { unit: number; at: number; label: string }[] = [];

    for (let i = 0; i < plan.byUnit.length; i++) {
      const use = plan.byUnit[i]!;
      if (use === PAY_UNUSED) continue;
      if (use === PAY_GENERIC) {
        let at = owed.findIndex((n) => n > 0);
        if (at < 0) at = casts.length - 1;
        owed[at] = (owed[at] ?? 1) - 1;
        spent.push({ unit: i, at, label: 'generic' });
        continue;
      }
      const at = owner[plan.pipSlot[use] ?? -1] ?? 0;
      spent.push({ unit: i, at, label: pipText(plan.pips[use]!.options) });
    }

    // --- mana nobody had yet ----------------------------------------------
    // The solver sees one cost and one pool for the whole turn, so it will
    // happily hand a Dark Ritual its own {B} back out of the {B}{B}{B} that
    // Dark Ritual made. The *decision* is sound — the cast was solved against
    // the pool as it stood, before the burst — but the breakdown would be a
    // sequence nobody could have played, and a trace that contradicts the
    // model is the one thing this function exists not to do.
    //
    // So: a floating unit assigned to its own maker, or to anything cast
    // before it, swaps with a unit of the same colors spent later. Same colors
    // is what makes the swap free — two interchangeable units changing places
    // is the same payment — and a ritual makes the colors it costs, which is
    // why so narrow a rule covers the case it was written for.
    const madeAt = (unit: number): number => {
      const who = poolOwner(unit, owners);
      if (!isFloating(who)) return -1;
      const card = ownerCard(who);
      for (let c = 0; c < casts.length; c++) if (casts[c]!.card === card) return c;
      return -1;
    };
    const sig = (unit: number): string => poolColors(unit, pool).join('');
    for (let k = 0; k < spent.length; k++) {
      const e = spent[k]!;
      const made = madeAt(e.unit);
      if (made < 0 || e.at > made) continue;
      for (let m = 0; m < spent.length; m++) {
        const f = spent[m]!;
        if (f.at <= e.at || sig(f.unit) !== sig(e.unit)) continue;
        const moved = madeAt(f.unit);
        if (moved >= 0 && e.at <= moved) continue;
        const tmp = e.unit;
        e.unit = f.unit;
        f.unit = tmp;
        break;
      }
    }

    const taps: string[][] = casts.map(() => []);
    for (const e of spent) {
      const who = poolOwner(e.unit, owners);
      // Nothing taps for floating mana: it is already in the pool, and a line
      // saying a Dark Ritual tapped for black is a line about a permanent that
      // is not there.
      taps[e.at]!.push(`${sourceName(who)} ${isFloating(who) ? 'adds' : 'taps for'} ${e.label}`);
    }
    for (let c = 0; c < casts.length; c++) {
      if (taps[c]!.length > 0) casts[c]!.line.taps = taps[c];
    }
  };

  /** What pool index `i` can pay, walked the same way poolOwner walks it. */
  const poolColors = (i: number, pool: readonly ManaUnit[]): readonly string[] => {
    if (i < pool.length) return pool[i]!.colors;
    let at = i - pool.length;
    let g = 0;
    while (g < unitGroups.length && at >= unitGroups[g]!.count) {
      at -= unitGroups[g]!.count;
      g++;
    }
    return unitGroups[g]?.colors ?? [];
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
  const addSource = (index: number, card: SimCard, online: number, turn: number, by: number): boolean => {
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
    srcBy[srcLen] = by;
    srcTreasure[srcLen] = 0;
    srcFloating[srcLen] = 0;
    srcLen++;
    grantMask |= card.grantMask;
    // Every mana source that is a real card is also a permanent, and this is
    // the one place that has to remember it. A Treasure comes through here with
    // index -1 and is deliberately not one: it is a token, and a rule that
    // could sacrifice it would be sacrificing the same mana twice.
    if (index >= 0) addPermanent(index, card, turn);
    return true;
  };

  /**
   * File a card on the battlefield. Idempotent is exactly what this must *not*
   * be: two Islands are two entries carrying the same card index.
   */
  const addPermanent = (index: number, card: SimCard, turn: number): void => {
    if (permLen >= MAX_PERMANENTS) return;
    permCard[permLen] = index;
    permSince[permLen] = turn;
    permUntil[permLen] = card.life > 0 ? turn + card.life - 1 : 0;
    permLen++;
  };

  /**
   * Take a card off the battlefield, mana view and permanent view together.
   * True if it was actually there, which is what tells a `self` step whether it
   * just sacrificed something or merely discarded it.
   */
  const leavePlay = (index: number): boolean => {
    unsource(index);
    unrecur(index);
    for (let p = 0; p < permLen; p++) {
      if (permCard[p] !== index) continue;
      dropPermanent(p);
      return true;
    }
    return false;
  };

  /** The same, for a caller that already knows which slot it picked. */
  const dropPermanent = (at: number): void => {
    permLen--;
    permCard[at] = permCard[permLen]!;
    permSince[at] = permSince[permLen]!;
    permUntil[at] = permUntil[permLen]!;
  };

  /**
   * And off the upkeep list, because a Phyrexian Arena somebody sacrificed does
   * not keep drawing. Only `selfPlaced` used to reach this, and a card could
   * only place itself; now a rule can sacrifice any permanent it can name, so
   * the same bookkeeping has to happen from the other direction.
   *
   * Removing by swap can make the upkeep loop skip an entry if this fires from
   * inside it. That is a permanent missing one trigger, which is the omission
   * §11.4 asks for; the alternative — leaving a dead card on the list — is one
   * drawing cards from the graveyard forever, which is the other kind.
   */
  const unrecur = (index: number): void => {
    for (let r = 0; r < recurLen; r++) {
      if (recurring[r] !== index) continue;
      recurring[r] = recurring[--recurLen]!;
      return;
    }
  };

  /** Still around this turn: a Lotus Petal's slot outlives the Petal. */
  const stillOut = (p: number, turn: number): boolean => {
    const until = permUntil[p]!;
    return until === 0 || turn <= until;
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
    srcBy[at] = srcBy[srcLen]!;
    srcTreasure[at] = srcTreasure[srcLen]!;
    srcFloating[at] = srcFloating[srcLen]!;
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

  /**
   * Cards off the top into your hand. A tutor comes through here too, see below.
   *
   * Returns how many actually moved, which is what "the previous X" reads: a
   * draw-7 off a library of three drew three, and the step after it has no
   * business being told seven.
   */
  const drawCards = (count: number): number => {
    let drawn = 0;
    for (let k = 0; k < count; k++) {
      if (top >= libLen || handLen >= hand.length) break;
      const index = library[top++]!;
      hand[handLen++] = index;
      seen++;
      drawn++;
      if (sink) drewNames.push(cards[index]!.name);
    }
    creditSeen(creditTo, drawn);
    return drawn;
  };

  /**
   * Cards out of your hand. The commander is exempt: it is in `hand` as a
   * bookkeeping convenience and discarding it would be a rules error, not a
   * conservative approximation.
   */
  const discardCards = (count: number): number => {
    let discarded = 0;
    for (let k = 0; k < count; k++) {
      const pick = pickDiscard(cards, hand, handLen);
      if (pick < 0) break;
      const index = hand[pick]!;
      if (sink) discardedNames.push(cards[index]!.name);
      hand[pick] = hand[--handLen]!;
      bury(index);
      discarded++;
    }
    return discarded;
  };

  /** Cards off the top into the graveyard. They leave the library; you never see them. */
  const millCards = (count: number): number => {
    let milled = 0;
    for (let k = 0; k < count && top < libLen; k++) {
      const index = library[top++]!;
      if (sink) milledNames.push(cards[index]!.name);
      bury(index);
      milled++;
    }
    return milled;
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
      srcBy[srcLen] = creditTo;
      srcTreasure[srcLen] = 1;
      srcFloating[srcLen] = 0;
      srcLen++;
      units.push(UNIT_BY_MASK[TREASURE_MASK]!);
      if (sink) unitOwner.push(-1);
      colorsHeld |= TREASURE_MASK;
      made++;
    }
    // Only the ones the pool walk has already gone past: see `poolCredited`.
    // On every later turn the Treasure is an ordinary source and the walk finds
    // it, still carrying the index of whatever made it.
    if (poolCredited) creditMana(creditTo, turn, made);
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
        const owner = srcFloating[s] ? floatOwner(srcCard[s]!) : srcCard[s]!;
        for (let u = 0; u < n; u++) {
          thrifty.push(UNIT_BY_MASK[mask]!);
          if (sink) thriftyOwner.push(owner);
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

  /**
   * Mana straight into your mana pool: a Dark Ritual's {B}{B}{B}, a Lotus
   * Cobra's landfall trigger. Returns how much it actually put there.
   *
   * Into `units` as well as into the source list, for the same reason a
   * Treasure goes into both: `units` is the pool the payment solver is holding
   * *this turn*, and mana that cannot be spent until the next rebuild is not
   * mana anybody would call a ritual.
   *
   * What makes it a ritual rather than a Treasure is the expiry. It lasts this
   * turn and no longer, spent or not, so there is no reconciliation to do at
   * the end of it — `emptyPool` throws the slot away either way. That is also
   * why the sequencer has to be choosier about casting one than about making a
   * Treasure: see `ritualHasUse`.
   */
  const addPoolMana = (count: number, mask: number, oneColor: boolean, turn: number, by: number): number => {
    if (count <= 0 || srcLen >= MAX_SOURCES) return 0;
    const grouped = oneColor && count > 1;
    srcMask[srcLen] = mask;
    srcUnits[srcLen] = count;
    srcOnline[srcLen] = turn;
    // Last turn it works is this one, so the next pool walk skips it even if
    // the sweep below has not run yet.
    srcExpires[srcLen] = turn;
    srcOneColor[srcLen] = grouped ? 1 : 0;
    srcIsLand[srcLen] = 0;
    srcCard[srcLen] = by;
    srcBy[srcLen] = by;
    srcTreasure[srcLen] = 0;
    srcFloating[srcLen] = 1;
    srcLen++;
    const unit = UNIT_BY_MASK[mask]!;
    if (grouped) {
      unitGroups.push({ colors: unit.colors, count });
      if (sink) groupOwner.push(floatOwner(by));
    } else {
      for (let u = 0; u < count; u++) {
        units.push(unit);
        if (sink) unitOwner.push(floatOwner(by));
      }
    }
    // Same dance as makeTreasures: the pool walk credits what it counted, so
    // only mana made *after* that walk is credited by hand here.
    if (poolCredited) creditMana(by, turn, count);
    return count;
  };

  /**
   * End of turn: the mana pool empties. Use it or lose it, which is the one
   * rule of Magic this whole mechanism exists to model.
   *
   * Compacts forward rather than walking backwards, because `dropSource` is a
   * swap-remove and a backwards walk over a shrinking array is a bug waiting
   * for the second floating source in a turn.
   */
  const emptyPool = (): void => {
    for (let s = 0; s < srcLen; ) {
      if (srcFloating[s]) dropSource(s);
      else s++;
    }
  };

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
   * A card arrived, and `cast` says how. True is the card leaving your hand
   * under its own power — a spell resolving, a land going down for the turn.
   * False is everything else: the land a fetch went and got, a creature a move
   * step pulled out of the graveyard. The difference is which rules fire.
   *
   * A recurring effect joins the upkeep list and fires from *next* turn,
   * because its trigger is an upkeep it has already missed; a one-shot one
   * resolves now. Returns the mana it added to this turn, which only a Treasure
   * ever does.
   */
  const enters = (index: number, card: SimCard, turn: number, cast: boolean): number => {
    // Authored behavior replaces the derived profile outright — see
    // SimCard.behavior for why replace and not merge. A card carrying both an
    // upkeep rule and a play rule does both: unlike EffectProfile, where
    // `repeatable` is one flag over the whole thing, the rules are separate, so
    // a card that draws on entry *and* every upkeep is one behavior.
    selfPlaced = false;
    const b = card.behavior;
    if (b) {
      if (sink) lastEffectText = '';
      let made = 0;
      let text = '';
      if (cast && b.play.length > 0) {
        made += runSteps(b.play, turn, index);
        if (sink) text = lastEffectText;
      }
      // Then the arrival, in that order, because that is the order a card you
      // cast does them in. Not if the cast rule already sent it somewhere else:
      // a spell that exiled itself never reached the battlefield to enter it.
      if (b.etb.length > 0 && card.permanent && !selfPlaced) {
        made += runSteps(b.etb, turn, index);
        if (sink) text = text && lastEffectText ? `${text}, then ${lastEffectText}` : text || lastEffectText;
      }
      if (sink) lastEffectText = text;
      // The upkeep list is joined *after* the play rules have run, because a
      // card whose play rule exiled it is not on the battlefield to trigger.
      if (b.upkeep.length > 0 && !selfPlaced && recurLen < recurring.length) recurring[recurLen++] = index;
      return made;
    }
    // A derived reading is "what happens when this resolves", and nothing in
    // the profile says which half of that is a cast trigger and which is an
    // entry one. Firing it for a card that was never cast would invent a
    // Divination's two cards for a reanimation spell, which is the direction
    // §11.4 forbids. The `etb` rule above is how you say otherwise.
    if (!cast) return 0;
    const effect = card.effect;
    if (!effect) return 0;
    if (effect.repeatable) {
      if (recurLen < recurring.length) recurring[recurLen++] = index;
      return 0;
    }
    return resolveEffect(effect, turn, index);
  };

  /** Does this card do anything on the way in, having not been cast? */
  const entersDoing = (card: SimCard): boolean => !!card.behavior && card.behavior.etb.length > 0 && card.permanent;

  const resolveEffect = (effect: EffectProfile, turn: number, self: number): number => {
    // The derived path never reaches `runSteps`, so it sets the credit itself.
    // Nothing inside here can nest — a profile is one card's own reading and
    // fires no watchers — so a plain assignment is enough, but the restore
    // still matters: the spend loop resolves the next card after this returns.
    const outerCredit = creditTo;
    creditTo = self;
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
    creditTo = outerCredit;
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

  /** Creatures on the battlefield right now, for the `creatures` amount. */
  const creaturesInPlay = (turn: number): number => {
    let n = 0;
    for (let p = 0; p < permLen; p++) {
      if (!cards[permCard[p]!]!.creature || !stillOut(p, turn)) continue;
      n++;
    }
    return n;
  };

  /**
   * The greatest printed power among them, for Disciple of Freyalise — the card
   * that started §12 and the last thing on its list to become writable.
   *
   * Printed, not current: nothing here counters, equips, or puts a +1/+1 on
   * anything, so the number is a floor rather than a reading of the board. A
   * deck of Llanowar Elves and one Craterhoof reads the Craterhoof's 5.
   */
  const greatestPower = (turn: number): number => {
    let best = 0;
    for (let p = 0; p < permLen; p++) {
      const card = cards[permCard[p]!]!;
      if (!card.creature || !stillOut(p, turn) || card.power <= best) continue;
      best = card.power;
    }
    return best;
  };

  /**
   * What the step before this one actually did, for a `prev` amount to read.
   *
   * "What it did", not "what it asked for": a draw-7 that found three cards
   * hands on three. The number the step *wanted* is available and would be
   * easier, and it is the wrong one — it would let a step that failed feed a
   * step that then succeeds, which is exactly the invention §11.4 forbids.
   */
  let lastAmount = 0;

  /**
   * A step's number. Floored at zero and **not** capped at the top.
   *
   * It used to be capped at MAX_BEHAVIOR_AMOUNT, which was a guard against the
   * fixed-size zone arrays and turned out to be redundant: every one of them
   * checks its own bound anyway (drawCards stops at the end of the library and
   * the size of your hand, moveCards stops the moment nothing matches,
   * makeTreasures stops at MAX_SOURCES). What the cap actually did was make
   * "draw half your library" mean twenty, so a deck with a Peer Into the Abyss
   * in it got the curve of a deck without one.
   */
  const behaviorAmount = (x: BehaviorAmount, turn: number): number => {
    let n: number;
    switch (x.kind) {
      case 'fixed':
        n = x.n ?? 0;
        break;
      case 'prev':
        n = lastAmount;
        break;
      case 'hand':
        n = handLen;
        break;
      case 'library':
        n = libLen - top;
        break;
      case 'lands':
        n = landsInPlay(turn);
        break;
      case 'creatures':
        n = creaturesInPlay(turn);
        break;
      case 'power':
        n = greatestPower(turn);
        break;
      case 'graveyard':
        n = gyLen;
        break;
      case 'turn':
        n = turn;
        break;
      case 'xpaid':
        // Set by the cast that is resolving right now, and zero everywhere
        // else. An upkeep three turns later is not the moment the mana went in.
        n = xSpent;
        break;
      case 'all':
        // Bounded by the zone rather than by a number. This is only the ceiling
        // the move loop stops at; it stops sooner the moment nothing matches,
        // and no zone here is bigger than the library's backing array.
        n = library.length;
        break;
      default:
        // A kind this build has never heard of, off a newer device.
        // compileBehavior drops those, so reaching here means the grammar grew
        // without this switch; zero is the omission the rest of the model is
        // built on.
        return 0;
    }
    return Math.max(0, applyAmountOp(n, x));
  };

  // --- Moving cards between zones ------------------------------------------
  // One step covers tutoring, ramping a land out of the library, regrowth,
  // bouncing, entombing and putting a card back, because all six are the same
  // sentence with different zones in it. What narrows it to a particular card
  // is a Scryfall query, matched against the deck once at build time and
  // reaching the inner loop as a byte per card.

  /** Nothing matches. What a criteria string no filter was built for gets. */
  const NO_MATCH = new Uint8Array(0);
  const filterFor = new Map<string, SimFilter>();
  for (const f of deck.filters) filterFor.set(f.q, f);
  /**
   * Does any card in the deck care about attacking? Almost none do, and combat
   * is otherwise a scan of the battlefield every turn of every one of twenty
   * thousand games to find out there is nothing to fire.
   */
  const anyAttackers = cards.some((c) => c.creature && !!c.behavior && c.behavior.attack.length > 0);
  /**
   * The same question for the two watched triggers, and the same answer: almost
   * no deck has one, and a deck that does not must not pay a scan of the
   * battlefield on every cast and every permanent that arrives, twenty thousand
   * games deep.
   *
   * Only permanents count. A rule on a sorcery is one that could never be on
   * the battlefield to see anything, which the editor already refuses to offer
   * and this refuses to look for.
   */
  const anyCastWatchers = cards.some((c) => c.permanent && !!c.behavior && c.behavior.cast.length > 0);
  const anyEnterWatchers = cards.some((c) => c.permanent && !!c.behavior && c.behavior.enters.length > 0);

  /**
   * The mana that went into the `{X}` of the spell resolving right now, so a
   * rule on a Fireball can read what it was cast for. Zero for everything that
   * is not that: land drops, upkeeps, and every spell without an X.
   */
  let xSpent = 0;

  /** An absent `qx`: the placeholder is worth nothing until someone says otherwise. */
  const ZERO_AMOUNT: BehaviorAmount = { kind: 'fixed', n: 0 };

  /** `base` is the row of a stacked `[X]` bitmask, and zero for every other query. */
  const accepts = (mask: Uint8Array | null, base: number, index: number): boolean => !mask || mask[base + index] === 1;

  /**
   * Pull one matching card out of a zone, or -1. The zone shrinks by one.
   *
   * An unfiltered move off the library is a draw and takes the top card. A
   * filtered one is a *search*, and it takes a **uniformly random** match
   * rather than the topmost one — which is not the same thing and was worth
   * 6% of a ramp deck's mana. Taking the nearest copy means the copy that
   * leaves your library is always the one you would have drawn soonest, so
   * every later draw is biased against it; at a real table you take a copy and
   * shuffle, and all of them are the same copy. `findLand` has always sampled
   * its ties this way, and the two disagreeing is how this surfaced.
   *
   * Every other zone is scanned in whatever order the sequencer happens to hold
   * it, which is the honest answer for a goldfish: there is no opponent to play
   * around and no reason to prefer one Mountain in the yard over another.
   */
  const takeFrom = (zone: BehaviorZone, mask: Uint8Array | null, base: number, turn: number): number => {
    switch (zone) {
      case 'library': {
        if (!mask) {
          if (top >= libLen) return -1;
          const index = library[top]!;
          library[top] = library[--libLen]!;
          return index;
        }
        // Reservoir sampling over the matches, so the choice is uniform among
        // them without building a list to shuffle. Same trick as the land drop's
        // tie-break, for the same reason.
        let pick = -1;
        let matches = 0;
        for (let i = top; i < libLen; i++) {
          if (!accepts(mask, base, library[i]!)) continue;
          matches++;
          if (rng.int(matches) === 0) pick = i;
        }
        if (pick < 0) return -1;
        const index = library[pick]!;
        library[pick] = library[--libLen]!;
        return index;
      }
      case 'hand':
        for (let i = 0; i < handLen; i++) {
          const index = hand[i]!;
          // The commander sits in `hand` as bookkeeping, not as a card you may
          // put wherever you like. Same exemption pickDiscard makes.
          if (cards[index]!.commander || !accepts(mask, base, index)) continue;
          hand[i] = hand[--handLen]!;
          return index;
        }
        return -1;
      case 'graveyard':
        for (let i = 0; i < gyLen; i++) {
          const index = graveyard[i]!;
          if (!accepts(mask, base, index)) continue;
          graveyard[i] = graveyard[--gyLen]!;
          return index;
        }
        return -1;
      case 'exile':
        for (let i = 0; i < exLen; i++) {
          const index = exiled[i]!;
          if (!accepts(mask, base, index)) continue;
          exiled[i] = exiled[--exLen]!;
          return index;
        }
        return -1;
      case 'battlefield': {
        // Every permanent, not just the ones that tap for mana. Until the
        // permanent list existed this searched `srcCard`, so "sacrifice a
        // creature" found a land and a deck full of creatures behaved as though
        // the battlefield were empty.
        //
        // Reservoir sampling rather than the first match, for the same reason
        // the library does it: which of four creatures you sacrifice is not
        // decided by the order they happened to be played in.
        let pick = -1;
        let matches = 0;
        for (let p = 0; p < permLen; p++) {
          const index = permCard[p]!;
          if (!stillOut(p, turn) || !accepts(mask, base, index)) continue;
          matches++;
          if (rng.int(matches) === 0) pick = p;
        }
        if (pick < 0) return -1;
        const index = permCard[pick]!;
        // The slot it picked, not the first slot carrying that card index:
        // two copies are two slots and only one of them is leaving.
        dropPermanent(pick);
        unsource(index);
        unrecur(index);
        return index;
      }
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
   * really does nothing here unless it says so — which is what an `etb` rule
   * is, and the reason this path fires one. That used to be refused outright on
   * the grounds that a rule putting cards onto the battlefield could reach
   * cards whose rules do the same; the answer to that is a depth counter, not a
   * whole missing trigger.
   */
  const enterBattlefield = (index: number, card: SimCard, turn: number, by: number): void => {
    if (card.role === 'extraland') {
      if (extraLands < MAX_EXTRA_LANDS) extraLands++;
      addPermanent(index, card, turn);
      fireEntry(index, card, turn);
      fireArrival(index, card, turn);
      return;
    }
    if (card.role === 'spell' || card.role === 'landramp') {
      // It makes no mana and it is still on the battlefield. A reanimated
      // creature used to arrive nowhere at all — "a body this model has no room
      // for" — which is exactly the room the permanent list is.
      if (card.permanent) addPermanent(index, card, turn);
      fireEntry(index, card, turn);
      fireArrival(index, card, turn);
      return;
    }
    // A fetch is not a land that taps for five colours. Its mask is the union
    // of what it could go and *get* (see buildSimDeck), which is exactly right
    // for deciding which land drop widens your colours and exactly wrong as a
    // mana source — and reanimating a Flooded Strand was reading it as the
    // second thing. It cracks here the same way it cracks off a land drop.
    if (card.role === 'fetch') {
      // An authored rule replaces the crack outright, the same way it replaces
      // land ramp: writing "find a Forest" by hand and getting that *plus* the
      // derived search is the Into the North bug with a land type on it.
      if (entersDoing(card)) fireEntry(index, card, turn);
      // Cracked means sacrificed, so the yard, which is where a later rule can
      // go and get it. Nothing to find means you would not have cracked it, so
      // it sits there instead, untracked and making no mana, which is what a
      // fetch with no targets is worth.
      else if (crack(card, turn, turn + 1, index)) bury(index);
      return;
    }
    if (!addSource(index, card, turn + 1, turn, by)) return;
    colorsHeld |= card.mask;
    const back = payEntryCost(card);
    if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
    fireEntry(index, card, turn);
    fireArrival(index, card, turn);
  };

  /**
   * Sacrifice a fetch for the best land in the library. `online` is the turn
   * the land starts paying for things, which is the one difference between
   * cracking it on your land drop (this turn, unless either half enters tapped)
   * and cracking it any other way (next turn, like every other move onto the
   * battlefield). True if it found something.
   *
   * The fetch itself is left where it is: the land drop buries it and the move
   * path has its own reason to, and they are not the same reason.
   */
  const crack = (card: SimCard, turn: number, online: number, by: number): boolean => {
    const at = findLand(cards, library, top, libLen, colorsHeld, card.fetchTargets, turnGoal, units, rng);
    if (at < 0) {
      if (sink) say(sink, 'land', 'Nothing left in the library to fetch');
      return false;
    }
    const found = library[at]!;
    const land = cards[found]!;
    const slow = card.tapped === 'always' || land.tapped === 'always';
    if (!addSource(found, land, Math.max(online, turn + (slow ? 1 : 0)), turn, by)) return false;
    colorsHeld |= land.mask;
    library[at] = library[--libLen]!;
    if (sink) say(sink, 'land', `Cracks for ${land.name}${slow ? ' (enters tapped)' : ''}`);
    const back = payEntryCost(land);
    if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
    // The land was put onto the battlefield, not played, so only its entry
    // rules fire. Its derived reading is a resolution reading and stays out.
    if (opts.effects && entersDoing(land)) {
      fireEntry(found, land, turn);
      sayEffect('');
    }
    // A land entered the battlefield, which is landfall whether you played it,
    // cracked for it or reanimated it. After the library slot has been closed
    // up above, because a watcher can go looking in there.
    fireArrival(found, land, turn);
    return true;
  };

  /**
   * One card's rules, fired from somewhere that is already mid-rule: a creature
   * arriving in the middle of a reanimation, a permanent dying in the middle of
   * the sacrifice that killed it.
   *
   * Everything here is about being re-entrant. `selfPlaced` and `lastAmount`
   * belong to the rule that is running, and a card triggering in the middle of
   * it must not answer "did it move itself?" or "what was the previous X?" on
   * that rule's behalf. The depth counter is the other half: a rule that puts a
   * card onto the battlefield can reach a card whose rule does the same, and a
   * goldfish is not where anyone should find out how deep that goes.
   */
  const fireNested = (index: number, card: SimCard, turn: number, steps: readonly BehaviorStep[]): void => {
    if (!opts.effects || steps.length === 0 || triggerDepth >= MAX_TRIGGER_DEPTH) return;
    const wasPlaced = selfPlaced;
    const wasAmount = lastAmount;
    const wasText = lastEffectText;
    const wasX = xSpent;
    const wasMoved = sink ? movedNames.slice() : null;
    // Nothing was cast to get *here*, whatever was cast to get to the rule this
    // is standing inside. A landfall trigger is not the moment somebody's {X}
    // was paid, and a magecraft rule reading `xpaid` off the spell it saw would
    // be reading a number that belongs to a different card.
    xSpent = 0;
    triggerDepth++;
    runSteps(steps, turn, index);
    triggerDepth--;
    xSpent = wasX;
    // Queued rather than said, because we are standing in the middle of the
    // rule that caused this and its own line has not been written yet. Saying
    // it here puts the reanimated creature's draw above the reanimation.
    if (sink && lastEffectText) pendingEntry.push(`${card.name} ${lastEffectText}`);
    selfPlaced = wasPlaced;
    lastAmount = wasAmount;
    lastEffectText = wasText;
    if (wasMoved) {
      movedNames.length = 0;
      for (const name of wasMoved) movedNames.push(name);
    }
  };

  /**
   * Combat, which exists here for exactly one reason: the `attack` trigger.
   *
   * There is nobody across the table, so there is nothing to decide. Every
   * creature that can attack does, nothing blocks, nothing dies, and no damage
   * is counted anywhere — a goldfish has no life total to take it. What that
   * leaves is the trigger, which is a real draw engine on a real card (Edric,
   * Ohran Frostfang, Toski) and until now was worth nothing at all because the
   * sequencer did not know a creature was on the battlefield.
   *
   * Summoning sickness is `permSince === turn`, and it is the one rule of
   * combat this model has. A creature flickered this turn is sick again,
   * because it really is a new object.
   *
   * The attackers are collected before any of them trigger. A rule that makes a
   * creature mid-combat must not hand it an attack it was never declared for,
   * and a rule that sacrifices one must not shorten the list underneath the
   * loop.
   */
  const attackWith = (turn: number): void => {
    if (!opts.effects || !anyAttackers) return;
    // A list of its own rather than the shared `stack`, which a rule fired
    // below will borrow and empty.
    const attackers: number[] = [];
    for (let p = 0; p < permLen; p++) {
      const index = permCard[p]!;
      const card = cards[index]!;
      if (!card.creature || !stillOut(p, turn) || permSince[p]! >= turn) continue;
      if (!card.behavior || card.behavior.attack.length === 0) continue;
      attackers.push(index);
    }
    for (const index of attackers) {
      const card = cards[index]!;
      xSpent = 0;
      selfPlaced = false;
      lastAmount = 0;
      runSteps(card.behavior!.attack, turn, index);
      sayEffect(lastEffectText ? `Attacks with ${card.name}: ${lastEffectText}` : '');
    }
  };

  /** It arrived on the battlefield without being cast. */
  const fireEntry = (index: number, card: SimCard, turn: number): void => {
    if (card.permanent && card.behavior) fireNested(index, card, turn, card.behavior.etb);
  };

  /**
   * It left the battlefield for the graveyard, which in this model means a rule
   * sacrificed it. Called only where a card is known to have been in play, so
   * a discard and a mill are not deaths.
   */
  const fireDeath = (index: number, card: SimCard, turn: number): void => {
    if (card.behavior) fireNested(index, card, turn, card.behavior.death);
  };

  /** Does the card that caused an event match what a watched rule is looking for? */
  const watched = (q: string | undefined, subject: number): boolean => {
    if (!q) return true;
    const filter = filterFor.get(q);
    // A criteria no filter was built for matches nothing, same as a move step's
    // does. Rule criteria never carry an `[X]` (sanitizeCardBehavior resolves
    // one away), so there is only ever the one row to read.
    return !!filter && filter.match[subject] === 1;
  };

  /**
   * Something happened to one card, and every permanent watching for it goes
   * off. This is the whole of landfall, magecraft, Beast Whisperer and the rest
   * of what a deck calls its engine.
   *
   * The watchers are collected before any of them fires, for the reason the
   * attacker list is: a rule that makes a permanent mid-trigger must not hand
   * it a trigger it was never around for, and a rule that sacrifices one must
   * not shorten the list underneath the loop.
   *
   * `enters` skips any permanent that *is* the card that just arrived, which is
   * what "another permanent" means and also what stops a rule waking itself
   * forever. Two copies of the same card are one card index here, so the first
   * copy sleeps through the second one landing — an omission, and the cheap
   * side of it: nothing that watches permanents arrive is a card you play two
   * of and also a card that matches its own criteria.
   */
  const fireWatchers = (which: 'cast' | 'enters', subject: number, turn: number): void => {
    if (!opts.effects || triggerDepth >= MAX_TRIGGER_DEPTH) return;
    const outermost = triggerDepth === 0;
    // A list of its own rather than the shared `stack`, which a rule fired
    // below will borrow and empty.
    const woken: { index: number; steps: readonly BehaviorStep[] }[] = [];
    for (let p = 0; p < permLen; p++) {
      const index = permCard[p]!;
      if (which === 'enters' && index === subject) continue;
      const rules = cards[index]!.behavior?.[which];
      if (!rules || rules.length === 0 || !stillOut(p, turn)) continue;
      for (const rule of rules) if (watched(rule.q, subject)) woken.push({ index, steps: rule.steps });
    }
    for (const w of woken) fireNested(w.index, cards[w.index]!, turn, w.steps);
    // Drained here rather than left for whatever says the next effect line: the
    // event that woke these has already been written down, so the triggers
    // belong under it and not under the next card to resolve.
    if (outermost && woken.length > 0) sayEffect('');
  };

  /**
   * A permanent arrived under your control. Its own entry rules fire elsewhere
   * (`fireEntry`); this is everyone else noticing.
   */
  const fireArrival = (index: number, card: SimCard, turn: number): void => {
    if (anyEnterWatchers && card.permanent) fireWatchers('enters', index, turn);
  };

  /**
   * One card's effect line, and then every entry trigger it set off, in the
   * order they happened. The queue is drained here and nowhere else, so a
   * resolution that fires nothing costs a length check.
   */
  const sayEffect = (text: string): void => {
    if (!sink) return;
    if (text) say(sink, 'effect', text);
    for (const line of pendingEntry) say(sink, 'effect', line);
    pendingEntry.length = 0;
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

  /**
   * Slide a card into the library at position `at`, somewhere in `[top, libLen]`.
   *
   * Whatever was sitting there is pushed to the very bottom rather than shifted
   * down, which is O(1) instead of O(n) and costs nothing statistically: the
   * live library is a uniformly random permutation, and for any fixed position
   * this map is a bijection on permutations, so what comes out is uniformly
   * random too. That argument is exactly why it is *not* used for the top,
   * where the card sitting there may be one a scry or an earlier tutor put
   * there on purpose.
   */
  const insertInLibrary = (index: number, at: number): void => {
    // No room is the same statement as the bottom of a real library: the card
    // is in the deck and it is not coming back inside eight turns.
    if (libLen >= library.length) return;
    if (at < libLen) {
      library[libLen] = library[at]!;
      library[at] = index;
    } else {
      library[libLen] = index;
    }
    libLen++;
  };

  const putTo = (index: number, zone: BehaviorZone, turn: number): void => {
    switch (zone) {
      case 'hand':
        hand[handLen++] = index;
        return;
      case 'library':
        // A random spot, which is what "shuffle it into your library" means
        // once the deck is a bag of cards rather than an ordered list. The
        // range is inclusive at both ends: the top and the bottom are both
        // places a shuffle can land it.
        insertInLibrary(index, top + rng.int(libLen - top + 1));
        return;
      case 'librarytop':
        // Back up the draw pointer into the dead space the opener left, so the
        // card is genuinely the next one drawn and nothing already on top has
        // to move. Only when there is dead space left to back into — otherwise
        // it displaces the current top card, which is the rare, imprecise path.
        if (top > libFloor) library[--top] = index;
        else insertInLibrary(index, top);
        return;
      case 'librarybottom':
        insertInLibrary(index, libLen);
        return;
      case 'graveyard':
        graveyard[gyLen++] = index;
        return;
      case 'exile':
        exiled[exLen++] = index;
        return;
      case 'battlefield':
        // Whatever rule moved it is what put it there, so that is who its mana
        // belongs to: a reanimated Sol Ring is the reanimation spell's two mana.
        enterBattlefield(index, cards[index]!, turn, creditTo);
        return;
    }
  };

  /**
   * Cards on their way to the top or the bottom of the library, held back so
   * they can be put in a random order.
   *
   * Two cards going to the top arrive in the order the source zone happened to
   * hold them, which is an order nobody chose and the model has no business
   * caring about. Shuffling them is the honest reading of "put them back in any
   * order" and it is what you would do at a table with no information.
   */
  const stack: number[] = [];

  const shuffleStack = (): void => {
    for (let i = stack.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = stack[i]!;
      stack[i] = stack[j]!;
      stack[j] = t;
    }
  };

  /** Returns how many cards actually made the trip, for `prev` to read. */
  /**
   * Take permanents off the battlefield and put them straight back, which fires
   * every entry rule again.
   *
   * A `move` cannot express this: `compileBehavior` refuses a step whose two
   * zones are the same one, because for every other pair that is a typo. Here
   * it is the whole point, so it is its own verb.
   *
   * Collected first and returned after, so a flicker of two permanents cannot
   * pick the same one twice, and so a rule that arrives on the way back in
   * cannot find the flickered card sitting in a zone it never went to.
   * Summoning sickness resets, because the creature really is a new object.
   */
  const flickerPermanents = (step: BehaviorStep, count: number, turn: number): number => {
    let mask: Uint8Array | null = null;
    let base = 0;
    if (step.q) {
      const filter = filterFor.get(step.q);
      mask = filter ? filter.match : NO_MATCH;
      if (filter?.varies) base = Math.min(MAX_QUERY_X, behaviorAmount(step.qx ?? ZERO_AMOUNT, turn)) * n;
    }
    // A local list, not the shared `stack`: putting one of these back can fire
    // an entry rule whose own move step borrows `stack` and empties it, and
    // this loop would then be iterating an array that had vanished underneath
    // it. The allocation is once per flicker step, which nothing casts in a
    // hot loop.
    const taken: number[] = [];
    for (let k = 0; k < count; k++) {
      let pick = -1;
      let matches = 0;
      for (let p = 0; p < permLen; p++) {
        const index = permCard[p]!;
        if (!stillOut(p, turn) || !accepts(mask, base, index)) continue;
        matches++;
        if (rng.int(matches) === 0) pick = p;
      }
      if (pick < 0) break;
      const index = permCard[pick]!;
      dropPermanent(pick);
      unsource(index);
      unrecur(index);
      taken.push(index);
    }
    for (const index of taken) {
      if (sink) movedNames.push(cards[index]!.name);
      // A flicker is the one arrival that credits the card itself. It was
      // already yours and already making this mana; blinking it is not the
      // flicker spell going and getting you a Sol Ring.
      enterBattlefield(index, cards[index]!, turn, index);
    }
    return taken.length;
  };

  const moveCards = (step: BehaviorStep, count: number, turn: number): number => {
    const from = step.from;
    const to = step.to;
    if (!from || !to || from === to) return 0;
    let mask: Uint8Array | null = null;
    let base = 0;
    if (step.q) {
      const filter = filterFor.get(step.q);
      mask = filter ? filter.match : NO_MATCH;
      // A `[X]` query was compiled once per value of X, so picking the row *is*
      // resolving it. Nothing in here parses anything. Clamped to MAX_QUERY_X
      // rather than left to the amount's own range: this is a row index into a
      // table with X_VARIANTS rows, and an amount is no longer bounded by it.
      if (filter?.varies) base = Math.min(MAX_QUERY_X, behaviorAmount(step.qx ?? ZERO_AMOUNT, turn)) * n;
    }
    // A stack of cards going to one end of the library goes in a random order,
    // so they are collected first and placed once the step knows how many
    // there were.
    const ordered = to === 'librarytop' || to === 'librarybottom';
    if (ordered) stack.length = 0;
    let moved = 0;
    for (let k = 0; k < count; k++) {
      if (!roomIn(to)) break;
      const index = takeFrom(from, mask, base, turn);
      if (index < 0) break;
      moved++;
      // `seen` is cards that reached your hand off the library, which is what
      // the cards chart reads. A tutor counts; a regrowth does not.
      if (from === 'library' && to === 'hand') {
        seen++;
        creditSeen(creditTo, 1);
      }
      if (ordered) stack.push(index);
      else putTo(index, to, turn);
      if (sink) movedNames.push(cards[index]!.name);
      // Off the battlefield and into the yard is what dying is here. Nothing
      // across the table kills anything, so a sacrifice is the only way in.
      if (from === 'battlefield' && to === 'graveyard') fireDeath(index, cards[index]!, turn);
    }
    if (ordered) {
      shuffleStack();
      for (const index of stack) putTo(index, to, turn);
    }
    return moved;
  };

  // --- The card talking about itself ---------------------------------------

  /**
   * The card holding the rule put itself somewhere, so wherever it would have
   * gone on its own — the graveyard, for a spell that has finished resolving —
   * is not where it is. Read by the caster and by the upkeep loop; set by the
   * one step that can set it.
   */
  let selfPlaced = false;

  /** Take a card off the battlefield, if it is a source there. */
  const unsource = (index: number): void => {
    for (let s = 0; s < srcLen; s++) {
      // Floating mana carries the index of whatever made it, and it is not the
      // card: a rule that sacrifices a Lotus Cobra must not sacrifice the mana
      // its last landfall trigger put in the pool instead.
      if (srcCard[s] !== index || srcFloating[s]) continue;
      dropSource(s);
      return;
    }
  };

  /**
   * Run a rule's steps in the order they were authored, and return the mana
   * they added to this turn.
   *
   * Every amount is read *as its step runs*, not once up front, which is what
   * makes a sequence worth having: "discard your hand, then draw cards equal to
   * the cards in your hand" is a very short rule, and this resolves it the way
   * the card would — which is to say, drawing nothing, because the hand it is
   * counting has just gone to the graveyard. A Windfall wants the number that
   * step *reached*, and that is what `lastAmount` and the `prev` amount are.
   *
   * @param self The card these rules belong to, for a `self` step to move.
   */
  const runSteps = (steps: readonly BehaviorStep[], turn: number, self: number): number => {
    const bits: string[] = [];
    let made = 0;
    // Saved and restored rather than assigned, because a step here can wake a
    // watcher whose own rule runs to completion inside this one: a landfall
    // trigger nested under the rule that made the land. The inner rule's draws
    // are the watcher's, and the outer rule's remaining steps are still the
    // outer card's once it returns.
    const outerCredit = creditTo;
    creditTo = self;
    // A rule's first step has no step before it, so "the previous X" is zero
    // and the step does nothing. Reset per rule rather than per game: an
    // upkeep trigger three turns later is not reading the cast that made it.
    lastAmount = 0;
    for (const step of steps) {
      // A `self` step moves one card and it is not one you chose, so it reads
      // no amount at all — an `x` on it would be a control with one setting.
      if (step.op === 'self') {
        const to = step.to;
        if (!to || self < 0 || selfPlaced || !roomIn(to)) continue;
        // Off the battlefield first, so a rock that sacrifices itself stops
        // making mana rather than making it from the graveyard. Whether it was
        // *on* the battlefield is the difference between a sacrifice and a
        // discard, and only the first one is a death.
        const wasOut = leavePlay(self);
        putTo(self, to, turn);
        selfPlaced = true;
        if (wasOut && to === 'graveyard') fireDeath(self, cards[self]!, turn);
        if (sink) {
          const where = ZONE_PHRASE.get(to) ?? 'somewhere';
          bits.push(`puts itself ${to === 'battlefield' ? 'onto' : 'into'} ${where}`);
        }
        // Deliberately leaves `lastAmount` alone. A self step carries no
        // number, so "the previous X" reads past it to the last step that did
        // — which is what a Green Sun's Zenith wants.
        continue;
      }
      const n = behaviorAmount(step.x, turn);
      if (n <= 0) {
        lastAmount = 0;
        continue;
      }
      // What the step actually managed, which is what the next one may read.
      let did = n;
      switch (step.op) {
        case 'draw':
          if (sink) drewNames.length = 0;
          did = drawCards(n);
          if (sink && drewNames.length) bits.push(`draws ${drewNames.join(', ')}`);
          break;
        case 'discard':
          if (sink) discardedNames.length = 0;
          did = discardCards(n);
          if (sink && discardedNames.length) bits.push(`discards ${discardedNames.join(', ')}`);
          break;
        case 'mill':
          if (sink) milledNames.length = 0;
          did = millCards(n);
          if (sink && milledNames.length) bits.push(`mills ${milledNames.join(', ')}`);
          break;
        case 'scry':
        case 'surveil':
          // The one step with no count to report back: dig looks at `n` cards
          // and may reorder none of them, and "how many you looked at" is the
          // number the card would have said.
          dig(n);
          if (sink) bits.push(`${step.op} ${n}`);
          break;
        case 'treasure': {
          const t = makeTreasures(n, turn);
          made += t;
          did = t;
          if (sink && t > 0) bits.push(`makes ${t} Treasure${t === 1 ? '' : 's'}`);
          break;
        }
        case 'mana': {
          // Any color, which is what the grammar offers and all it offers: a
          // colored ritual comes off the mana profile with its real colors and
          // needs no rule. Weaker than the Treasure step sitting above it,
          // because this is gone at end of turn and a Treasure is not.
          const m = addPoolMana(n, TREASURE_MASK, false, turn, creditTo);
          made += m;
          did = m;
          if (sink && m > 0) bits.push(`adds ${m} mana`);
          break;
        }
        case 'move': {
          if (sink) movedNames.length = 0;
          did = moveCards(step, n, turn);
          if (sink && movedNames.length) {
            const where = ZONE_PHRASE.get(step.to ?? '') ?? 'somewhere';
            bits.push(`moves ${movedNames.join(', ')} to ${where}`);
          }
          break;
        }
        case 'flicker': {
          if (sink) movedNames.length = 0;
          did = flickerPermanents(step, n, turn);
          if (sink && movedNames.length) bits.push(`flickers ${movedNames.join(', ')}`);
          break;
        }
      }
      lastAmount = did;
    }
    if (sink) lastEffectText = bits.join(', ');
    creditTo = outerCredit;
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

  // --- Card credit (phase 13) ------------------------------------------------
  // The two trajectory lines, decomposed by which card in the deck put each
  // point there. Both decompositions are exact: they sum back to `manaSum` and
  // `seenSum` respectively, which is the property that lets the panel read as a
  // breakdown of a chart rather than a second opinion about it.

  /** manaCredit[card * stride + turn]: mana available that turn off this card's sources. */
  const manaCredit = new Float64Array(n * stride);
  /** seenCredit[card * stride + turn]: cards in hand *by* that turn this card drew. */
  const seenCredit = new Float64Array(n * stride);
  /** This game's running count per card, flushed into `seenCredit` each turn. */
  const gameSeen = new Float64Array(n);
  /**
   * Which cards have drawn anything this game, so the per-turn flush is a walk
   * over the handful of cards that did something and not over the whole deck.
   * Twenty thousand games times eight turns times a hundred cards is sixteen
   * million writes to save a few hundred.
   */
  const touched = new Int32Array(n);
  const touchedFlag = new Uint8Array(n);
  let touchedLen = 0;
  /** The opener, which is no card's doing, and every mulligan you shipped. */
  const openerSeen = new Float64Array(stride);
  /** The draw step, same. Together these are most of the cards line. */
  const drawStepSeen = new Float64Array(stride);
  let gameOpener = 0;
  let gameDrawStep = 0;
  /**
   * Has this turn's pool been counted into `manaCredit` yet?
   *
   * `available` is built once by `buildPool` and then grown by Treasures made
   * mid-spend, and the credit has to follow it exactly or the breakdown stops
   * summing. So the pool walk credits every source it counts, and
   * `makeTreasures` credits only the Treasures made after that walk — the ones
   * `available +=` picks up. A Treasure made at upkeep is already on the
   * battlefield when the walk happens and must not be counted twice.
   */
  let poolCredited = false;

  /** Every mana source this card has on the battlefield is worth this much to it. */
  const creditMana = (by: number, turn: number, units: number): void => {
    if (by >= 0) manaCredit[by * stride + turn] = manaCredit[by * stride + turn]! + units;
  };

  /** Every cards-seen decomposition site funnels through here. */
  const creditSeen = (by: number, count: number): void => {
    if (by < 0 || count <= 0) return;
    gameSeen[by] = gameSeen[by]! + count;
    if (!touchedFlag[by]) {
      touchedFlag[by] = 1;
      touched[touchedLen++] = by;
    }
  };

  /** Every cost committed this turn, folded into one, so partial spends add up. */
  const paid: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [], faces: 1 };

  // --- Rituals, and the pay question -----------------------------------------
  // A ritual in hand is mana you have not spent yet, and the manabase question
  // — "of the games where you held this card, how often could you pay for it" —
  // has to know that or it disagrees with the spend loop below, which happily
  // casts the four-drop off a Dark Ritual and then reports the four-drop as
  // unpayable. Not a generosity: it is the same answer the sequencer acts on.
  //
  // Everything here is dead weight in a deck with no ritual in it, so it is
  // gated on one flag read once.
  const hasRituals = cards.some((c) => c.role === 'ritual' && c.cost !== null && c.adds > c.cost.mana);
  /** The turn's pool with every castable ritual in hand cast into it. */
  const boosted: ManaUnit[] = [];
  const boostedGroups: UnitGroup[] = [];
  /** What casting them costs, to be folded in alongside whatever you asked about. */
  const ritualCost: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [], faces: 1 };
  const probe: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [], faces: 1 };

  /**
   * Cast every ritual in hand, on paper, and report whether any of them went.
   *
   * Greedy and in hand order: a ritual joins if its own cost is still payable
   * alongside the ones already in, and then its mana joins the pool. Greedy is
   * enough because a ritual that pays for itself never makes another one
   * harder to cast — it only ever adds units.
   */
  const buildRitualPool = (): boolean => {
    ritualCost.generic = 0;
    ritualCost.pips.length = 0;
    ritualCost.mana = 0;
    boosted.length = 0;
    boostedGroups.length = 0;
    for (const u of units) boosted.push(u);
    for (const g of unitGroups) boostedGroups.push(g);
    let any = false;
    for (let i = 0; i < handLen; i++) {
      const card = cards[hand[i]!]!;
      if (card.role !== 'ritual' || !card.cost || card.adds <= card.cost.mana) continue;
      const before = ritualCost.pips.length;
      ritualCost.generic += card.cost.generic;
      for (const pip of card.cost.pips) ritualCost.pips.push(pip);
      if (!canPay(ritualCost, boosted, boostedGroups)) {
        ritualCost.generic -= card.cost.generic;
        ritualCost.pips.length = before;
        continue;
      }
      ritualCost.mana += card.cost.mana;
      const unit = UNIT_BY_MASK[card.mask]!;
      if (card.oneColor && card.adds > 1) boostedGroups.push({ colors: unit.colors, count: card.adds });
      else for (let u = 0; u < card.adds; u++) boosted.push(unit);
      any = true;
    }
    return any;
  };

  /** Could you pay for this if you spent the rituals first? */
  const payableWithRituals = (cost: ParsedCost): boolean => {
    probe.generic = ritualCost.generic + cost.generic;
    probe.pips.length = 0;
    for (const pip of ritualCost.pips) probe.pips.push(pip);
    for (const pip of cost.pips) probe.pips.push(pip);
    probe.mana = ritualCost.mana + cost.mana;
    return canPay(probe, boosted, boostedGroups);
  };

  /**
   * The spell this turn's rituals are *for*, or null when they are for nothing.
   *
   * A ritual cast into nothing is a card thrown away for mana that evaporates,
   * and a sequencer that throws them away reports mana it never had a use for —
   * the generous direction, which §11.4 does not allow. So the burst needs a
   * target before any of it is made, and the target is the most expensive thing
   * in hand that the rituals put in reach and the lands do not. Most expensive
   * because that is what anybody rituals into: the payoff, not the filler.
   *
   * The `available + 2` floor is the other half, and it is what stops a deck of
   * two-drops burning twelve Dark Rituals on turn one to cast the two-drop it
   * would have cast on turn two anyway. A ritual is not spent to gain a single
   * land drop; the spell it buys has to be further out of reach than the land
   * you are about to draw.
   *
   * Answered against the same boosted pool the pay question uses, so the two
   * are reading the same hand. They still part company on the `available + 2`
   * floor, and deliberately: `payByTurn` asks whether you *could*, which on a
   * turn-three four-drop is yes, and the sequencer asks whether you *would*,
   * which on a turn-three four-drop is no, because turn four casts it for free.
   */
  const ritualTarget = (available: number): ParsedCost | null => {
    let best: ParsedCost | null = null;
    for (let i = 0; i < handLen; i++) {
      const card = cards[hand[i]!]!;
      if (!card.spell || !card.cost || card.role === 'ritual') continue;
      if (card.cost.mana < available + 2) continue;
      if (best && card.cost.mana <= best.mana) continue;
      if (canPay(card.cost, units, unitGroups)) continue;
      if (!payableWithRituals(card.cost)) continue;
      best = card.cost;
    }
    return best;
  };

  /**
   * Is the turn still short of the spell the rituals are for?
   *
   * Asked against everything already committed, which is what makes a chain
   * work and what stops it running long: two Dark Rituals into a turn-one
   * four-drop is two passes through here, and the third ritual never goes
   * because by then the cost solves.
   */
  const goalProbe: ParsedCost = { generic: 0, pips: [], mana: 0, hasX: false, unmodelled: [], faces: 1 };
  const ritualNeeded = (goal: ParsedCost | null): boolean => {
    if (!goal) return false;
    goalProbe.generic = paid.generic + goal.generic;
    goalProbe.pips.length = 0;
    for (const pip of paid.pips) goalProbe.pips.push(pip);
    for (const pip of goal.pips) goalProbe.pips.push(pip);
    goalProbe.mana = paid.mana + goal.mana;
    return !canPay(goalProbe, units, unitGroups);
  };

  let handSizeSum = 0;
  let mulliganed = 0;
  const games = deckSize > 0 ? opts.games : 0;

  for (let game = 0; game < games; game++) {
    firstCast.fill(0);
    firstHeld.fill(0);
    firstPay.fill(0);
    srcLen = 0;
    permLen = 0;
    grantMask = 0;
    recurLen = 0;
    extraLands = 0;
    colorsHeld = 0;
    handLen = 0;
    libLen = deckSize;
    top = 0;
    seen = 0;
    for (let i = 0; i < touchedLen; i++) {
      gameSeen[touched[i]!] = 0;
      touchedFlag[touched[i]!] = 0;
    }
    touchedLen = 0;
    gameDrawStep = 0;
    creditTo = -1;
    gyLen = 0;
    exLen = 0;

    // --- The opener, and however many mulligans it takes ---------------------
    for (let m = 0; ; m++) {
      library.set(deck.library);
      shuffle(library, deckSize, rng);
      libLen = deckSize;
      top = 0;
      libFloor = 0;
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
        library[libFloor++] = hand[drop]!;
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
      // Every card the opener cost you, mulligans included, and none of it
      // anybody's doing. `top` rather than `handLen`: a hand you shipped came
      // off the library too, which is what this line has always counted.
      gameOpener = top;
      break;
    }
    // The commander is a card you always have, from a zone you never draw, so
    // it joins the hand and stays there until it is cast.
    for (const c of deck.commanders) hand[handLen++] = c;

    for (let turn = 1; turn <= maxTurn; turn++) {
      // A Treasure made at upkeep is on the battlefield before this turn's pool
      // walk and gets its credit from there. Reset before the upkeep triggers
      // run, not after.
      poolCredited = false;
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
        // Nothing was cast to get here, so there is no X to read. An upkeep
        // three turns after the spell is not the moment the mana went in.
        xSpent = 0;
        selfPlaced = false;
        if (card.behavior) {
          if (card.behavior.upkeep.length === 0) continue;
          runSteps(card.behavior.upkeep, turn, index);
        } else if (card.effect) {
          resolveEffect(card.effect, turn, index);
        } else {
          continue;
        }
        sayEffect(lastEffectText ? `Upkeep: ${card.name} ${lastEffectText}` : '');
        // A permanent that put itself somewhere else has left the battlefield,
        // so it comes off the list rather than triggering from the graveyard.
        if (selfPlaced) {
          recurring[r] = recurring[--recurLen]!;
          r--;
        }
      }

      if (!(turn === 1 && opts.onPlay) && top < libLen && handLen < MAX_HAND) {
        const index = library[top++]!;
        hand[handLen++] = index;
        seen++;
        gameDrawStep++;
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
      turnGoal = goal;

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
          // The fetch was *played*, so the fetch's own rule fires — and until
          // this release it never did. This path resolved the land it found and
          // nothing else, so a behavior authored on a Flooded Strand was a rule
          // you could write, save and never see happen.
          const authored = opts.effects && !!card.behavior && (card.behavior.play.length > 0 || card.behavior.etb.length > 0);
          let placed = false;
          if (opts.effects && resolves(card)) {
            xSpent = 0;
            enters(cardIndex, card, turn, true);
            placed = selfPlaced;
            sayEffect(lastEffectText ? `${card.name} ${lastEffectText}` : '');
          }
          // And then what it is, unless you wrote that out yourself.
          if (!authored && crack(card, turn, turn, cardIndex) && !placed) {
            // Sacrificed, which means the yard, which means a behavior can go
            // and get it back.
            bury(cardIndex);
          }
        } else if (addSource(cardIndex, card, turn + (card.tapped === 'always' ? 1 : 0), turn, cardIndex)) {
          colorsHeld |= card.mask;
          const back = payEntryCost(card);
          if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
          // A Temple scries as it enters, and half the taplands printed since
          // Theros do something on the way in. Free, now that there is a
          // resolver to call.
          if (opts.effects && resolves(card)) {
            xSpent = 0;
            enters(cardIndex, card, turn, true);
            sayEffect(lastEffectText ? `${card.name} ${lastEffectText}` : '');
          }
          // And the land drop everybody else was waiting for. This is landfall's
          // main road: the other arrivals are fetches, ramp and reanimation.
          fireArrival(cardIndex, card, turn);
        }
      }

      // --- What could you pay for, with everything untapped -----------------
      // Not const any more: a Treasure made mid-turn is mana this turn, and it
      // has to reach both the spend loop's budget and the chart. Recorded after
      // the turn rather than here, so the available line is never below the
      // spent line — the trajectory chart's right-hand labels lean on that.
      let available = buildPool(turn, true);
      poolCredited = true;
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
      // The pool plus whatever the rituals in hand would add to it, built once
      // for the turn. False in every deck without one, and in every game where
      // none of them is castable yet.
      const withRituals = opts.effects && hasRituals ? buildRitualPool() : false;
      for (let i = 0; i < handLen; i++) {
        const index = hand[i]!;
        const g = groupOf[index]!;
        if (g < 0) continue;
        if (firstHeld[index] === 0) firstHeld[index] = turn;
        if (firstCast[index] !== 0) continue;
        if (firstPay[g] === 0 && payStamp[g] !== stamp) {
          payStamp[g] = stamp;
          const cost = cards[index]!.cost!;
          // The ritual's own row is asked the plain question only: it is
          // already inside `boosted`, and letting it pay for itself out of its
          // own burst is the one circularity this has to refuse.
          if (canPay(cost, units, unitGroups)) firstPay[g] = turn;
          else if (withRituals && cards[index]!.role !== 'ritual' && payableWithRituals(cost)) firstPay[g] = turn;
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
      // What the turn's rituals are for, read off the hand the pay question
      // just finished asking about. Null in every deck that holds none.
      const ritualGoal = withRituals ? ritualTarget(available) : null;
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
          // An X spell with nothing left over for X is a card you hold, not a
          // card you cast. Spending a Fireball for zero uses the card up and
          // buys nothing, which is not the conservative direction — it is just
          // worse play. Holding it is what happens at a table, and it is what
          // makes "the mana you spent on X" a number worth reading.
          if (card.cost.hasX && card.cost.mana >= left) continue;
          // A ritual is ramp for one turn, so it is ramp for the ordering that
          // matters: cast before the spell it is paying for, or the burst is
          // gone by the time anything wants it.
          //
          // Only while it is actually up on the deal. A Jeska's Will reads as a
          // ritual and its amount is a floor of one against a cost of three, so
          // it is filed as one and sequenced as an ordinary spell — the mana
          // still lands in the pool when it resolves, it just does not get to
          // jump the queue or answer to `ritualGoal`, which is somebody else's
          // burst.
          const burst = card.role === 'ritual' && card.adds > card.cost.mana;
          const ramp = card.role === 'rock' || card.role === 'dork' || card.role === 'landramp' || burst;
          if (burst && !ritualNeeded(ritualGoal)) continue;
          // An X spell goes last, under every fixed cost, because X is going to
          // take whatever the turn has left and a Fireball cast first would end
          // the turn on its own. Cast last it costs nothing: the mana it eats
          // had nowhere else to go. The +100 keeps every rank non-negative,
          // which `pickRank` starting at -1 depends on.
          const rank = (ramp ? 1000 : 0) + (card.cost.hasX ? 0 : 100) + card.cost.mana;
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

        // --- X ----------------------------------------------------------
        // Until this point {X} was worth nothing: manaCost.ts records `hasX`
        // and adds zero, so a Fireball was a one-mana spell and six mana sat
        // there unspent. X now takes whatever the turn has left, which is what
        // a player does with it and what the `manaSpentByTurn` line has been
        // overstating the gap on for every deck that plays one.
        xSpent = 0;
        if (card.cost!.hasX) {
          const rest = available - spent;
          if (rest > 0) {
            paid.generic += rest;
            if (canPay(paid, units, unitGroups)) {
              paid.mana += rest;
              spent += rest;
              xSpent = rest;
            } else {
              // Cannot actually happen — generic is payable by anything — but
              // committing mana the solver won't confirm is the one thing this
              // loop is not allowed to do.
              paid.generic -= rest;
            }
          }
        }

        if (sink && sink.turn) {
          const rampFirst =
            card.role === 'rock' ||
            card.role === 'dork' ||
            card.role === 'landramp' ||
            (card.role === 'ritual' && card.adds > card.cost!.mana);
          const why = rampFirst ? ' (ramp first)' : '';
          const forX = card.cost!.hasX ? ` with X = ${xSpent}` : '';
          say(sink, 'cast', `Casts ${card.name} ${card.manaCost}${forX}${why}`);
          // The taps arrive on this line later. The turn has to finish
          // committing first, because there is only one cost to solve and it is
          // the whole turn's.
          castLines.push({
            line: sink.turn.lines[sink.turn.lines.length - 1]!,
            card: index,
            // X is generic mana like any other, so the tap breakdown has to
            // account for it or the line shows five lands paying for two.
            generic: card.cost!.generic + xSpent,
            pips: card.cost!.pips.length,
          });
        }

        // Cast triggers, and they go off *before* the spell does — which is
        // both the rule and the reason they are worth writing. An Archmage
        // Emeritus draws off the Windfall before the Windfall empties your
        // hand, and a Storm-Kiln Artist's Treasure is mana this turn.
        if (anyCastWatchers) fireWatchers('cast', index, turn);

        // An authored play rule *is* what the card does, and a behavior
        // replaces the derived reading rather than adding to it — see
        // SimCard.behavior. Land ramp is a derived reading like any other, it
        // just comes off the mana profile instead of the effect profile, and
        // nothing was enforcing that until an Into the North written out by
        // hand fetched an Urza's Saga first and then did what it was told.
        const authored = opts.effects && !!card.behavior && (card.behavior.play.length > 0 || card.behavior.etb.length > 0);
        if (card.role === 'landramp' && !authored) {
          // What it fetches is a land out of the library, arriving tapped. That
          // is Rampant Growth exactly and Nature's Lore a turn late, which is
          // the conservative half of the two. What it is *allowed* to fetch is
          // not modelled at all — the profile records how many lands, never
          // which — so this takes the land that best fixes your colours and a
          // deck with a Snow-Covered Forest package gets whatever is in there.
          // Writing the criteria out is exactly what a behavior is for.
          for (let k = 0; k < card.adds; k++) {
            const at = findLand(cards, library, top, libLen, colorsHeld, null, goal, units, rng);
            if (at < 0) break;
            const found = library[at]!;
            const land = cards[found]!;
            if (!addSource(found, land, turn + 1, turn, index)) break;
            colorsHeld |= land.mask;
            library[at] = library[--libLen]!;
            if (sink) say(sink, 'mana', `Finds ${land.name}, which arrives tapped`);
            const back = payEntryCost(land);
            if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
            // It entered the battlefield, so anything it does on the way in
            // does it here too. A land found this way was never played, so its
            // played rule and its derived reading both stay out.
            fireEntry(found, land, turn);
            sayEffect('');
            fireArrival(found, land, turn);
          }
          // The mana that cast it has been spent, and a dork is summoning sick
          // on top of that, so either way it pays for something from next turn.
        } else if (card.role === 'rock' || card.role === 'dork') {
          if (addSource(index, card, turn + 1, turn, index)) {
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
        } else if (card.role === 'ritual') {
          // This turn's mana, in this turn's pool, so the passes below this one
          // can spend it. The colors are the profile's, not any-color: a Dark
          // Ritual makes black and a deck that cannot use black mana does not
          // get to pretend otherwise.
          const burst = addPoolMana(card.adds, card.mask, card.oneColor, turn, index);
          available += burst;
          if (sink && burst > 0) {
            const colors = pipText(UNIT_BY_MASK[card.mask]!.colors);
            say(sink, 'mana', `${card.name} adds ${burst} ${colors} to the pool, this turn only`);
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
        // On the battlefield before it resolves, which is the order the real
        // thing happens in and the order its own entry rule needs: a creature
        // whose arrival sacrifices a creature can sacrifice itself, and a
        // Panharmonicon-shaped rule counting creatures counts this one.
        //
        // Only the roles that did not already go through addSource above: a
        // rock and a dork are filed there, with their mana.
        if (card.permanent && card.role !== 'rock' && card.role !== 'dork') addPermanent(index, card, turn);
        if (opts.effects) {
          available += enters(index, card, turn, true);
          if (sink && resolves(card)) {
            // A behavior with an upkeep rule and no play rule is the same shape
            // as a repeatable profile: nothing happened now, something will.
            const b = card.behavior;
            const later = b ? b.play.length === 0 && b.etb.length === 0 : card.effect!.repeatable;
            // *What* will, though, is now two different promises. A watcher does
            // not fire on a clock, it fires on the next thing you do, and
            // telling someone their Tatyova triggers at upkeep is the trace
            // contradicting the rule they just wrote.
            const when =
              b && b.upkeep.length === 0 && (b.cast.length > 0 || b.enters.length > 0)
                ? 'is watching, and fires when it sees what it is waiting for'
                : 'will fire every upkeep from next turn';
            sayEffect(later ? `${card.name} ${when}` : `${card.name} ${lastEffectText || 'resolves'}`);
          }
        }
        // And everyone watching it arrive. After its own rules, which is the
        // order a card you cast does them in, and not at all if one of them
        // sent it somewhere other than the battlefield.
        if (!selfPlaced) fireArrival(index, card, turn);
        // And where the card itself ends up. A permanent stays out, as a source
        // if it makes mana and as an untracked body if it does not; everything
        // else is in the graveyard once it has resolved, which is where a
        // behavior can go and find it. After the effect, not before, because a
        // sorcery is on the stack while it resolves and a Regrowth that finds
        // itself is a rules error rather than a rounding one.
        //
        // Unless it said otherwise: a `self` step is the card naming its own
        // destination, which is the whole of "exile this card instead" and of
        // a Green Sun's Zenith shuffling back in.
        if (!card.permanent && !(opts.effects && selfPlaced)) bury(index);
        // A card with no effect profile still resolves as a blank. For a
        // Lightning Bolt that is correct; for a draw spell whose draw hangs off
        // a trigger the pipeline would not read, it is the floor §11.4 warned
        // about, and SimDeck.coverage is what says how much of the deck it is.
      }

      // --- Combat ----------------------------------------------------------
      // After the turn's spells, because the creature you just cast is not
      // attacking with them and the one you reanimated might be. Before the
      // Treasure reconciliation, so a trigger that makes one is counted this
      // turn. A card an attack trigger draws is a card you cannot cast until
      // next turn, which is the post-combat main phase this model does not
      // have, and the omission §11.4 asks for rather than the other kind.
      attackWith(turn);

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

      // And the mana pool empties. After the Treasure reconciliation, because
      // that solve wants the floating mana in the pool it is comparing against
      // — a turn paid for by a ritual must not crack a Treasure for it.
      emptyPool();

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
      // `seen` is cumulative within a game, so its decomposition has to be too:
      // this is a snapshot of every card's running total, taken once a turn.
      // `manaCredit` needs no equivalent because mana available is a rate, and
      // the pool walk already wrote this turn's.
      openerSeen[turn] = openerSeen[turn]! + gameOpener;
      drawStepSeen[turn] = drawStepSeen[turn]! + gameDrawStep;
      for (let i = 0; i < touchedLen; i++) {
        const c = touched[i]!;
        seenCredit[c * stride + turn] = seenCredit[c * stride + turn]! + gameSeen[c]!;
      }
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
    manaCredit,
    seenCredit,
    openerSeen,
    drawStepSeen,
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
  manaCredit: Float64Array;
  seenCredit: Float64Array;
  openerSeen: Float64Array;
  drawStepSeen: Float64Array;
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

  // --- Who made the lines (phase 13) ----------------------------------------
  // Every card with a non-zero share of either chart, in one list. Mana and
  // cards stay in separate fields rather than being added together: they are
  // different units, and a ranking that summed them would be inventing an
  // exchange rate between a Forest and a Divination.
  const contributions: SimContribution[] = [];
  for (let i = 0; i < deck.cards.length; i++) {
    const card = deck.cards[i]!;
    const manaByTurn = [0];
    const cardsByTurn = [0];
    let mana = 0;
    for (let turn = 1; turn < stride; turn++) {
      const m = t.manaCredit[i * stride + turn]! * per;
      manaByTurn.push(m);
      mana += m;
      cardsByTurn.push(t.seenCredit[i * stride + turn]! * per);
    }
    const seenAt = cardsByTurn[stride - 1] ?? 0;
    // A tenth of a mana over eight turns is a rounding artefact wearing a card
    // name. The panel's smallest readable step is 0.1, so anything under half
    // of that would render as "0.0" next to a name, which reads as a bug.
    if (mana < 0.05 && seenAt < 0.05) continue;
    contributions.push({
      oracleId: card.oracleId,
      name: card.name,
      copies: card.copies + (card.commander ? 1 : 0),
      manaByTurn,
      cardsByTurn,
      mana,
      cards: seenAt,
    });
  }
  contributions.sort((a, b) => b.mana + b.cards - (a.mana + a.cards) || a.name.localeCompare(b.name));

  return {
    games,
    maxTurn: opts.maxTurn,
    cards: results,
    commanders,
    costs,
    contributions,
    seenFromOpener: [...t.openerSeen].map((sum) => sum * per),
    seenFromDrawStep: [...t.drawStepSeen].map((sum) => sum * per),
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
