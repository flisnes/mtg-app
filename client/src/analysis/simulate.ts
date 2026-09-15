import type { DeckFormat } from '@mtg/shared';
import { canPay, maxMatching, type ManaUnit, type UnitGroup } from './canPay.js';
import { handSize } from './gameModel.js';
import { KEEP_ANYTHING_AT } from './mulligan.js';
import { makeRng, shuffle } from './rng.js';
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
  /** Mean mana available, indexed by turn. */
  manaByTurn: number[];
  /**
   * Mean mana actually spent on spells, indexed by turn. The gap against
   * `manaByTurn` is the thing no other panel in this sheet can see: mana you
   * had and had nothing to do with. It runs high, because a spell that draws
   * you a card resolves here as a blank and never buys you the next one.
   */
  manaSpentByTurn: number[];
  /** Mean cards off the top of the library by end of turn: the opener plus draws. */
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
 *   3. Play a land, always, if there is one. Which land: if something in hand
 *      costs exactly one more than the mana already online, take an untapped
 *      one; otherwise dump a tapland now, while it is free. Ties go to the land
 *      that adds a color you don't have, and a modal card stays in hand while a
 *      real land will do.
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
 *   7. Everything that is not ramp resolves as a blank. It leaves your hand and
 *      it costs you the mana, and it does not draw, mill or make a Treasure.
 *      That is a one-directional error: every curve here is a floor.
 */
export function simulate(deck: SimDeck, opts: SimOptions, onProgress?: (done: number) => void): SimResult {
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
  const hand = new Int32Array(96);
  const landChoices = new Int32Array(96);
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
  const unitGroups: UnitGroup[] = [];
  /** Sources on the battlefield. Lives out here so the pool builder can see it. */
  let srcLen = 0;
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
    let total = 0;
    for (let s = 0; s < srcLen; s++) {
      if (srcOnline[s]! > turn) continue;
      const expires = srcExpires[s]!;
      if (expires > 0 && turn > expires) continue;
      const n = srcUnits[s]!;
      total += n;
      const mask = srcIsLand[s] ? srcMask[s]! | grantMask : srcMask[s]!;
      if (srcOneColor[s] && n > 1) unitGroups.push({ colors: UNIT_BY_MASK[mask]!.colors, count: n });
      else for (let u = 0; u < n; u++) units.push(UNIT_BY_MASK[mask]!);
    }
    return total;
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
    srcLen++;
    grantMask |= card.grantMask;
    return true;
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
      if (card.bounce) back = srcCard[pick]!;
      srcLen--;
      srcMask[pick] = srcMask[srcLen]!;
      srcUnits[pick] = srcUnits[srcLen]!;
      srcOnline[pick] = srcOnline[srcLen]!;
      srcExpires[pick] = srcExpires[srcLen]!;
      srcOneColor[pick] = srcOneColor[srcLen]!;
      srcIsLand[pick] = srcIsLand[srcLen]!;
      srcCard[pick] = srcCard[srcLen]!;
    }
    return back;
  };
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
    let colorsHeld = 0;
    let handLen = 0;
    /** Cards still in the library, which a fetch shrinks. */
    let libLen = deckSize;
    let top = 0;

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
        library[bottomAt++] = hand[drop]!;
        hand[drop] = hand[--handLen]!;
      }
      handSizeSum += handLen;
      if (handLen < 7) mulliganed++;
      break;
    }
    // The commander is a card you always have, from a zone you never draw, so
    // it joins the hand and stays there until it is cast.
    for (const c of deck.commanders) hand[handLen++] = c;

    for (let turn = 1; turn <= maxTurn; turn++) {
      if (!(turn === 1 && opts.onPlay) && top < libLen) hand[handLen++] = library[top++]!;

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

      // --- Land drop --------------------------------------------------------
      // Candidates first, because most hands hold one land and one land is not
      // a decision. Scoring costs a matching solve apiece and this skips it.
      let candidates = 0;
      let best = -1;
      for (let i = 0; i < handLen; i++) {
        if (!cards[hand[i]!]!.land) continue;
        landChoices[candidates++] = i;
        best = i;
      }
      if (candidates > 1) {
        let bestScore = -1;
        for (let c = 0; c < candidates; c++) {
          const i = landChoices[c]!;
          const score = landScore(cards[hand[i]!]!, colorsHeld, needUntapped, goal, units);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
      }
      if (best >= 0) {
        landDrops[turn] = landDrops[turn]! + 1;
        const cardIndex = hand[best]!;
        const card = cards[cardIndex]!;
        hand[best] = hand[--handLen]!;
        if (card.role === 'fetch') {
          const at = findLand(cards, library, top, libLen, colorsHeld, card.fetchTargets, goal, units);
          if (at >= 0) {
            const index = library[at]!;
            const land = cards[index]!;
            const slow = card.tapped === 'always' || land.tapped === 'always';
            if (addSource(index, land, turn + (slow ? 1 : 0), turn)) {
              colorsHeld |= land.mask;
              library[at] = library[--libLen]!;
              const back = payEntryCost(land);
              if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
            }
          }
        } else if (addSource(cardIndex, card, turn + (card.tapped === 'always' ? 1 : 0), turn)) {
          colorsHeld |= card.mask;
          const back = payEntryCost(card);
          if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
        }
      }

      // --- What could you pay for, with everything untapped -----------------
      const available = buildPool(turn);
      manaSum[turn] = manaSum[turn]! + available;

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
        if (pick < 0) break;
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
          break;
        }
        paid.mana += card.cost!.mana;
        spent += card.cost!.mana;
        hand[pick] = hand[--handLen]!;

        if (card.role === 'landramp') {
          // What it fetches is a land out of the library, arriving tapped. That
          // is Rampant Growth exactly and Nature's Lore a turn late, which is
          // the conservative half of the two.
          for (let k = 0; k < card.adds; k++) {
            const at = findLand(cards, library, top, libLen, colorsHeld, null, goal, units);
            if (at < 0) break;
            const found = library[at]!;
            const land = cards[found]!;
            if (!addSource(found, land, turn + 1, turn)) break;
            colorsHeld |= land.mask;
            library[at] = library[--libLen]!;
            const back = payEntryCost(land);
            if (back >= 0 && handLen < hand.length) hand[handLen++] = back;
          }
          // The mana that cast it has been spent, and a dork is summoning sick
          // on top of that, so either way it pays for something from next turn.
        } else if (card.role === 'rock' || card.role === 'dork') {
          if (addSource(index, card, turn + 1, turn)) colorsHeld |= card.mask;
        }
        // Everything else resolves as a blank. It left your hand and it cost
        // you the mana, and what it *does* is phase 9's problem. That is the
        // one-directional error the panel has to own up to: a draw spell that
        // does not draw makes every curve here a floor rather than an estimate.
      }

      spentSum[turn] = spentSum[turn]! + spent;
      seenSum[turn] = seenSum[turn]! + top;
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
): number {
  let best = -1;
  let bestScore = -1;
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
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
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
