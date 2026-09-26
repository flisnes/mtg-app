import {
  EFFECT_REPEATABLE,
  EFFECT_TUTOR,
  EFFECT_UNKNOWN,
  EFFECT_WHOLE_HAND,
  type EffectProfileTuple,
  type OracleTagDictionary,
} from '@mtg/shared';
import { tagSubtrees } from './oracleTags.js';

// Derives OracleCard.effect: what a card does to your hand, library and
// graveyard when it resolves. Sibling to manaProfile.ts, which says what a card
// puts into play — between them the simulator can play a turn out instead of
// only paying for one. Runs here for the same reason: it wants oracle text and
// Tagger tags in the same place, and §4's line is that the client carries no
// parser.
//
// Three rules, and the third is the one that decides how the feature reads:
//
//  1. **The tags gate the verb; the text gives the number.** Same split as the
//     mana profile, for a different reason. "Draw a card" is not ambiguous the
//     way "enters tapped" is, so the text does nearly all the work: run this
//     with the gate off and all but two of the cards it accepts as drawing
//     carry a `draw` tag anyway, and those two are real draws the taggers
//     missed. The gate stays regardless, because it costs three cards out of
//     ~1,480 and it is the thing that will catch a templating change we have
//     not seen yet. Treasure has no gate: Tagger has no "makes Treasure" tag,
//     and a proper noun that appears nowhere else on a card needs no help.
//
//  2. **Only unconditional, only on resolution, only yours.** An effect hanging
//     off a combat trigger, an activated ability, a kicker, a mode or an "if"
//     is left out, as is one aimed at an opponent. Roughly two thirds of the
//     cards Tagger calls draw cards end up with no draw here, and that is the
//     intended answer rather than a shortfall.
//
//  3. **Every error has to be an omission.** The simulator's trajectory curves
//     are honest only while they are a *floor* (§11.4): a card we fail to model
//     makes the deck look worse than it is, which is a bias the panel can own
//     out loud. A card we model too generously makes it look better, which is a
//     bias nobody can see. So where the reading is uncertain the effect is
//     dropped, and where the amount is uncertain it is flagged and floored.
//     "Draw three cards" behind an additional cost of discarding two is the one
//     case that would otherwise break the rule, so the discard is counted too.

/** Tag subtrees the derivation gates on, resolved to dictionary indices once. */
export interface EffectTagIndex {
  draw: ReadonlySet<number>;
  mill: ReadonlySet<number>;
  surveil: ReadonlySet<number>;
  scry: ReadonlySet<number>;
  tutor: ReadonlySet<number>;
}

const GATE_SLUGS = ['draw', 'mill', 'surveil', 'scry', 'tutor'] as const;

export function buildEffectTagIndex(dictionary: OracleTagDictionary): EffectTagIndex {
  const sets = tagSubtrees(dictionary, GATE_SLUGS);
  const of = (slug: string) => sets.get(slug) ?? new Set<number>();
  return {
    draw: of('draw'),
    mill: of('mill'),
    surveil: of('surveil'),
    scry: of('scry'),
    tutor: of('tutor'),
  };
}

const WRITTEN_NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** What a countable amount looks like in Magic's templating, including the ones we can't count. */
const AMOUNT = `a|an|\\d+|${WRITTEN_NUMBERS.join('|')}|x`;

/** An amount as a number, or null when it is an X we have no value for. */
function amount(word: string | undefined): number | null {
  if (!word) return null;
  const lower = word.toLowerCase();
  if (lower === 'a' || lower === 'an') return 1;
  const n = Number(lower);
  if (Number.isFinite(n)) return n;
  const i = WRITTEN_NUMBERS.indexOf(lower);
  return i >= 0 ? i + 1 : null;
}

/**
 * Reminder text. Every Treasure-maker prints "(It's an artifact with '{T},
 * Sacrifice this token: Add one mana of any color.')", every surveil card
 * prints what surveil does, and reading either as a second effect doubles the
 * card.
 */
const REMINDER = /\([^)]*\)/g;
/**
 * A quoted ability belongs to something else, exactly as it does in the mana
 * profile: a token the card creates, a permanent it enchants, an emblem.
 */
const QUOTED = /["“][^"”]*["”]/g;

/** A triggered ability. Which kind decides everything; see `timingOf`. */
const TRIGGER = /^\s*(?:whenever|when|at the beginning)\b/i;
/** "When this creature enters", "When The Eighth Doctor enters". */
const ENTERS = /^\s*when\b[^,]*\benters\b/i;
/**
 * …but the thing entering is somebody else's: "When a Dragon you control
 * enters", "When another creature enters". An indefinite subject is the tell,
 * and it is the only one that works — the definite case is a card named "The
 * Everflowing Well", not a reference to another permanent.
 */
const ENTERS_OTHER = /^\s*when (?:a|an|another|each|one|two|three|any|all|other)\b/i;
/**
 * A trigger that fires every turn on its own, with nothing to do first:
 * Phyrexian Arena. "Each player's upkeep" is deliberately not here — it draws
 * for the table, and this model has no table.
 */
const EVERY_TURN = /^\s*at the beginning of your (?:upkeep|draw step|end step|precombat main phase)\b/i;
/** A cost, then a colon, then the ability. You have to pay, so we don't count it. */
const ACTIVATED = /^[^:]{1,80}:/;
/** "Choose one —", and the bullet lines under it. Only one of them happens. */
const MODAL = /^\s*•|\bchoose (?:one|two|three|up to)\b/i;

const DRAW = new RegExp(`\\bdraws? (${AMOUNT}) card`, 'i');
const MILL = new RegExp(`\\bmills? (${AMOUNT}) card`, 'i');
const SURVEIL = new RegExp(`\\bsurveil (${AMOUNT})\\b`, 'i');
const SCRY = new RegExp(`\\bscry (${AMOUNT})\\b`, 'i');
const TREASURE = new RegExp(`\\bcreates? (${AMOUNT}) (?:colorless )?treasure token`, 'i');
const DISCARD = new RegExp(`\\bdiscards? (${AMOUNT}) cards?\\b`, 'i');
/** Faithless Looting's bigger cousins. The number is whatever you're holding. */
const DISCARD_HAND = /\bdiscards? your hand\b/i;
/**
 * Brainstorm's other half. The cards go back to the library rather than to the
 * graveyard, so this is neither a discard nor a mill — it is the draw being
 * smaller than it looks, and netting it off is the only reading that gets hand,
 * library and graveyard all right at once. Brainstorm draws one.
 */
const PUT_BACK = new RegExp(
  `\\bputs? (${AMOUNT}) cards? from your hand on (?:top of|the bottom of) your library`,
  'i',
);
/**
 * A search that ends in your hand — Diabolic Intent, Treasure Mage. A search
 * that ends on the battlefield is a `landramp` and belongs to the mana profile;
 * requiring "into your hand" keeps the two from counting the same card twice.
 */
const TUTOR_TO_HAND = new RegExp(
  `\\bsearch your library for (${AMOUNT}|up to \\w+)\\b[^.]*?(?:put|reveal)[^.]*?\\binto your hand\\b`,
  'i',
);

/**
 * Somebody who is not you, in the few words right before the verb — which in
 * Magic's templating is where the subject always is. A whole-sentence test gets
 * "You draw two cards and each opponent discards two cards" wrong in both
 * halves; a window keeps the draw and drops the discard, which is the sentence.
 * A bare imperative ("Draw a card", "Surveil 2") has no subject at all, and an
 * empty window matches nothing, which is the right answer.
 */
const OTHER_PLAYER =
  /\b(?:target|each|every|another|that|its|their) (?:player|opponent|controller)\b|\bplayers\b|\bopponents?\b|\bcontroller\b/i;
const SUBJECT_WINDOW = 24;

/** An amount that depends on the board, the way BOARD_DEPENDENT does for mana. */
const VAGUE = /\bfor each\b|\bequal to\b|\{x\}|\bany number\b|\bthat many\b|\bx cards?\b|\bup to\b/i;
/**
 * The effect might not happen. `instead` and `was cast` are the alternate-cost
 * clauses (spectacle, kicker, foretell) writing a second, better version of the
 * same sentence, and counting both is how a card draws four when it draws one.
 */
const CONDITION = /\bif\b|\bunless\b|\binstead\b|\bwas cast\b|\brather than\b|\bcan't\b|\bat the beginning of the next\b/i;
/**
 * A wheel. "Each player shuffles their hand and graveyard into their library,
 * then draws seven cards" really does draw you seven, and counting seven is
 * still wrong, because the hand you were holding went back into the deck first.
 * The net is seven minus however many cards you had, which is a hand model
 * phase 9 has not built — so this counts as nothing, which is the direction
 * rule 3 asks for. Treated as a condition because it poisons a line the same
 * way: the draw and its price are one sentence and we can only read half.
 */
const WHEEL = /\bshuffles? (?:their|your|his or her) hand\b|\bdiscards their hand\b/i;
/**
 * The additional cost the *whole card* pays, printed on its own line above the
 * effect: Cathartic Reunion discards two to draw three. Rule 3's one exception
 * — a cost is the only thing here read off a line the effect isn't on, because
 * ignoring it is the one omission that would flatter a deck rather than
 * shortchange it.
 */
const ADDITIONAL_COST = new RegExp(
  `\\bas an additional cost to cast[^,]*,[^.]*\\bdiscards? (?:${AMOUNT}) cards?\\b`,
  'i',
);
/**
 * An additional cost we cannot price in cards: sacrifice a creature (Deadly
 * Dispute, Village Rites), exile, return, pay energy. The card read as a free
 * draw two on an empty board, which is a §11.4 break, and half a card is worse
 * than none of it in both directions — so the whole profile is dropped. Three
 * costs stay because the caster can always pay them: a discard (the tally
 * counts it), an optional "you may …", and a reveal. An "or discard a card"
 * alternative also stays — the discard is the honest price then.
 */
const UNPAYABLE_COST =
  /\bas an additional cost to cast this spell, (?!discard\b|you may\b|reveal\b)(?![^.\n]*(?:\bor discards? a card\b|\bdiscards? a card,? or\b))/i;
/**
 * A sacrifice of your own board demanded alongside the payout: Disciple of
 * Bolas's "sacrifice another creature. You … draw X cards" was a free draw
 * one. The price is a fact about the board the tally cannot see, so the line
 * is poisoned the same way an unreadable condition poisons it.
 */
const SACRIFICE_PRICE = /\byou sacrifice\b|\bsacrifices? (?:a|an|another|any number|x|\d+|one|two|three)\b/i;

type Timing = 'resolve' | 'repeat' | 'skip';

/**
 * When the line's effect happens, from the shape of the line alone.
 *
 * `resolve` is the turn you cast the card, which covers a spell's own text and
 * an enters trigger on a permanent — from the simulator's seat those are the
 * same turn and the same certainty. Everything else is `skip`: a combat
 * trigger needs combat, an activated ability needs mana we already spent, a
 * mode means the other modes didn't happen.
 */
function timingOf(line: string, isSpell: boolean): Timing {
  if (MODAL.test(line)) return 'skip';
  if (TRIGGER.test(line)) {
    if (ENTERS.test(line)) return ENTERS_OTHER.test(line) ? 'skip' : 'resolve';
    if (EVERY_TURN.test(line)) return 'repeat';
    return 'skip';
  }
  if (ACTIVATED.test(line)) return 'skip';
  // A bare sentence on a permanent is a static ability, not something that
  // happens; a bare sentence on an instant or sorcery is the whole card.
  return isSpell ? 'resolve' : 'skip';
}

export interface EffectProfileInput {
  typeLine: string;
  oracleText: string | null;
  /** The card's own tag indices (OracleCard.tags), unexpanded. */
  tags: readonly number[] | undefined;
}

interface Tally {
  draw: number;
  discard: number;
  mill: number;
  surveil: number;
  scry: number;
  treasure: number;
}

const KEYS = ['draw', 'discard', 'mill', 'surveil', 'scry', 'treasure'] as const;

/**
 * What the card does to you when it resolves, or undefined when it does none of
 * it in a way we are willing to put a number on.
 */
export function effectProfileOf(card: EffectProfileInput, index: EffectTagIndex): EffectProfileTuple | undefined {
  const tags = card.tags ?? [];
  const tagged = (set: ReadonlySet<number>) => tags.some((t) => set.has(t));
  const once: Tally = { draw: 0, discard: 0, mill: 0, surveil: 0, scry: 0, treasure: 0 };
  const repeat: Tally = { draw: 0, discard: 0, mill: 0, surveil: 0, scry: 0, treasure: 0 };
  let unknown = false;
  let tutor = false;
  let wholeHand = false;

  // The front face only, the same convention parseManaCost keeps and for the
  // same reason: you cast one half of a split, an Adventure or a Room, and
  // reading both is how a 2/2 Wizard ends up surveilling because the sorcery on
  // its back would have.
  const isSpell = /\b(?:Instant|Sorcery)\b/.test(card.typeLine.split('//')[0] ?? '');
  const lines: string[] = [];
  for (const raw of (card.oracleText ?? '').split('\n')) {
    const line = raw.replace(QUOTED, ' ').replace(REMINDER, ' ').trim();
    if (line === '//') break;
    if (line) lines.push(line);
  }

  for (const line of lines) {
    // The unpayable additional cost belongs to casting the card at all, so it
    // takes the whole profile with it whatever else the card says.
    if (UNPAYABLE_COST.test(line)) return undefined;
    const timing = timingOf(line, isSpell);
    // An additional cost is a property of casting the card at all, so it counts
    // even on a permanent, whose other lines this loop is about to walk past.
    if (timing === 'skip') {
      const cost = ADDITIONAL_COST.exec(line);
      if (cost) {
        const n = amount(DISCARD.exec(cost[0])?.[1]);
        once.discard += n ?? 1;
        if (n === null) unknown = true;
      }
      continue;
    }

    const into = timing === 'repeat' ? repeat : once;
    const before: Tally = { ...into };
    const beforeFlags: { unknown: boolean; tutor: boolean; wholeHand: boolean } = { unknown, tutor, wholeHand };
    let poisoned = false;

    // Player scoping and conditions are per *sentence*: one line routinely
    // holds two, and "Mill four cards, then return a creature card from your
    // graveyard to your hand" must not lose its mill to the word "your hand"
    // sitting in the next clause.
    for (const sentence of line.split(/(?<=\.)\s+/)) {
      // A condition we could not read poisons the whole line, and that rule is
      // rule 3 working in both directions at once. "Draw three cards. Then
      // discard two cards unless you discard a creature card" would otherwise
      // keep the draw and drop its price; Keldon Raider's "you may discard a
      // card. If you do, draw a card" would keep the price and drop the draw.
      // Half a card is worse than none of it either way. A sentence about
      // somebody else is not a condition and poisons nothing.
      /** Whoever this verb belongs to, it isn't us. */
      const theirs = (at: number) => OTHER_PLAYER.test(sentence.slice(Math.max(0, at - SUBJECT_WINDOW), at));
      // An opponent's sacrifice is their problem, not our price: Cruel
      // Ultimatum's "Target opponent sacrifices a creature" must not poison
      // the sentence where *we* draw three. An additional-cost line already
      // passed UNPAYABLE_COST, so its sacrifice is the alternative we are not
      // paying — poisoning it would erase the discard we count instead.
      const sac = /\bas an additional cost\b/i.test(sentence) ? null : SACRIFICE_PRICE.exec(sentence);
      if (CONDITION.test(sentence) || WHEEL.test(sentence) || (sac && !theirs(sac.index))) {
        poisoned = true;
        break;
      }

      const take = (re: RegExp, key: (typeof KEYS)[number], gate: boolean) => {
        const m = re.exec(sentence);
        if (!m || !gate || theirs(m.index)) return;
        const n = amount(m[1]);
        if (n === null || VAGUE.test(sentence)) unknown = true;
        into[key] += n ?? 1;
      };

      take(DRAW, 'draw', tagged(index.draw));
      take(MILL, 'mill', tagged(index.mill));
      take(SURVEIL, 'surveil', tagged(index.surveil));
      take(SCRY, 'scry', tagged(index.scry));
      take(TREASURE, 'treasure', true);
      take(DISCARD, 'discard', true);

      const back = PUT_BACK.exec(sentence);
      if (back && !theirs(back.index)) {
        const n = amount(back[1]);
        if (n === null) unknown = true;
        into.draw = Math.max(0, into.draw - (n ?? 1));
      }

      const hand = DISCARD_HAND.exec(sentence);
      if (hand && !theirs(hand.index)) {
        wholeHand = true;
        unknown = true;
      }
      const searched = TUTOR_TO_HAND.exec(sentence);
      if (searched && tagged(index.tutor) && !theirs(searched.index)) {
        const n = amount(searched[1]);
        if (n === null || VAGUE.test(sentence)) unknown = true;
        into.draw += n ?? 1;
        tutor = true;
      }
    }

    if (poisoned) {
      Object.assign(into, before);
      ({ unknown, tutor, wholeHand } = beforeFlags);
    }
  }

  // A card that does one thing on the way in and another every upkeep is two
  // profiles, and this field holds one. The entry is the part every deck gets
  // in every game, so it wins; the recurring half is dropped rather than folded
  // in, because folding it in is how Oath of Jace draws three cards a turn
  // forever.
  const some = (t: Tally) => KEYS.some((k) => t[k] > 0);
  const tally = some(once) ? once : repeat;
  const repeatable = tally === repeat && some(repeat);

  if (!KEYS.some((k) => tally[k] > 0) && !wholeHand) return undefined;

  const flags =
    (repeatable ? EFFECT_REPEATABLE : 0) |
    (unknown ? EFFECT_UNKNOWN : 0) |
    (tutor ? EFFECT_TUTOR : 0) |
    (wholeHand ? EFFECT_WHOLE_HAND : 0);

  // Trimmed to the last slot that carries anything, which for most of these
  // cards is the first: a cantrip is [0, 1].
  const slots: number[] = [flags, ...KEYS.map((k) => tally[k])];
  while (slots.length > 1 && slots.at(-1) === 0) slots.pop();
  return slots as EffectProfileTuple;
}
