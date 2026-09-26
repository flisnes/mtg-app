import type { DeckFormat } from '@mtg/shared';

// The simulator's knobs and labels, on their own so the UI can import them
// without pulling the engine into the main bundle. simulate.ts is a quarter
// of a megabyte of sequencer; the pickers and defaults are a screenful.

/** Turns simulated. Eight covers a seven-drop's own curve and stops there. */
export const SIM_MAX_TURN = 8;

/** Enough games that a percentage point is real, few enough to finish on a phone. */
export const DEFAULT_GAMES = 20000;
/**
 * The first look (rebuild plan C2). Same seed, so these are the first two
 * thousand games of the full run, and a before/after pair of them shares its
 * draws: the difference is the change, not the shuffle.
 */
export const QUICK_GAMES = 2000;

/** Karsten's simulations ship a hand with fewer than two lands; so does this one. */
export const DEFAULT_KEEP_MIN = 2;
export const DEFAULT_KEEP_MAX = 5;

/**
 * How the sequencer spends a turn, which is the one thing about this model
 * that was never a fact about the deck.
 *
 * Until now there was exactly one policy — ramp first, then the priciest
 * thing in hand — and it is the right one for the deck it was written for and
 * wrong for the two next to it. An aggro deck casting a Signet over a two-drop
 * is not playing aggro; a draw-go deck tapping out every turn is not holding
 * anything up. The numbers upstairs are only worth reading if the policy that
 * produced them is the one you would have played, so it is a control rather
 * than a constant.
 *
 *   ramp       ramp first, priciest first. What this always did.
 *   draw       anything that draws you a card first, then ramp, then the rest.
 *   creatures  bodies first. The aggro ordering: the board before the engine.
 *   curve      cheapest first, so the turn fits as many spells in as it can.
 */
export type SpendPolicy = 'ramp' | 'draw' | 'creatures' | 'curve';

/**
 * Who attacks.
 *
 *   triggers  only creatures whose rule fires on attack. What combat was for
 *             before there was a damage number, and still the cheap answer.
 *   all       every creature that can, every turn. Nothing blocks.
 *   none      nobody. A combo deck's creatures are not there to attack.
 */
export type CombatPolicy = 'triggers' | 'all' | 'none';

/**
 * What happens to the instants in your hand.
 *
 *   cast  they go in the spend loop with everything else. What this always did.
 *   hold  they stay in hand and the mana stays up. There is nobody across the
 *         table to cast them at, so holding one really does mean never casting
 *         it — which is the honest reading of "I keep two mana open", not a
 *         defect. The mana it costs shows up as the gap on the mana chart.
 */
export type InteractionPolicy = 'cast' | 'hold';

export interface SimOptions {
  games: number;
  onPlay: boolean;
  maxTurn: number;
  format: DeckFormat | undefined;
  /** Keep a seven holding this many of the keep rule's cards (`SimCard.keeps`, lands by default). */
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
  /** How the turn is spent. See SpendPolicy. */
  spend: SpendPolicy;
  /** Who attacks. See CombatPolicy. */
  combat: CombatPolicy;
  /** Whether instants get cast or held up. See InteractionPolicy. */
  interaction: InteractionPolicy;
  seed: number;
}

/** The three knobs, on their own, for the UI that sets them and the deck that stores them. */
export interface SimPolicy {
  spend: SpendPolicy;
  combat: CombatPolicy;
  interaction: InteractionPolicy;
}

/** The policy every deck starts on: what the simulator did before it was a choice. */
export const DEFAULT_POLICY: SimPolicy = { spend: 'ramp', combat: 'triggers', interaction: 'cast' };

/**
 * The pickers, written here rather than in the sheet, because a label that
 * disagrees with the sequencer is worse than no label: the whole argument for
 * showing a policy is that it is the one that produced the numbers.
 */
export interface PolicyOption<T> {
  id: T;
  label: string;
  /** Two words for the chip in the analysis context bar. */
  short: string;
  hint: string;
}

export const SPEND_POLICIES: readonly PolicyOption<SpendPolicy>[] = [
  { id: 'ramp', label: 'Ramp first, then greedily', short: 'Ramp first', hint: 'Rocks, dorks and land ramp before anything else, then the priciest spell the turn can pay for.' },
  { id: 'draw', label: 'Card draw first', short: 'Draw first', hint: 'Anything that puts cards in your hand jumps the queue, then ramp, then the rest.' },
  { id: 'creatures', label: 'Creatures first', short: 'Creatures first', hint: 'Bodies before the engine. The aggro ordering: a two-drop on turn two beats a Signet.' },
  { id: 'curve', label: 'Cheapest first', short: 'Cheapest first', hint: 'Fit as many spells into the turn as the mana holds, rather than the one biggest.' },
];

export const COMBAT_POLICIES: readonly PolicyOption<CombatPolicy>[] = [
  { id: 'triggers', label: 'Only when it triggers something', short: 'Attacks for triggers', hint: 'A creature swings if attacking is what wakes its rule. Nobody else bothers.' },
  { id: 'all', label: 'Everything attacks', short: 'All attack', hint: 'Every creature that can, does, every turn. Nothing blocks, so all of it connects.' },
  { id: 'none', label: 'Nobody attacks', short: 'No attacks', hint: 'The creatures are here for something other than combat.' },
];

export const INTERACTION_POLICIES: readonly PolicyOption<InteractionPolicy>[] = [
  { id: 'cast', label: 'Cast instants on sight', short: 'Instants cast', hint: 'An instant is a spell like any other and goes in the spend order with them.' },
  { id: 'hold', label: 'Hold instants up', short: 'Instants held', hint: 'Instants stay in hand and their mana stays untapped. Nobody is across the table to cast them at, so the cost shows as unspent mana.' },
];

export const defaultSimOptions = (format: DeckFormat | undefined, onPlay: boolean): SimOptions => ({
  games: DEFAULT_GAMES,
  onPlay,
  maxTurn: SIM_MAX_TURN,
  format,
  keepMin: DEFAULT_KEEP_MIN,
  keepMax: DEFAULT_KEEP_MAX,
  mulligan: true,
  effects: true,
  ...DEFAULT_POLICY,
  seed: 0x5eed,
});

/** Mana histogram width: 0..14 and "15 or more". Nothing in eight turns reads past it. */
export const MANA_BINS = 16;

/**
 * The 95% confidence half-width for a proportion out of `games` games. Reported
 * rather than buried: a simulated 61% and an exact 61% are not the same claim,
 * and this is the size of the difference.
 */
export function halfWidth(p: number, games: number): number {
  if (games <= 0) return 1;
  return 1.96 * Math.sqrt(Math.max(p * (1 - p), 1e-6) / games);
}
