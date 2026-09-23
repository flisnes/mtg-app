import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BASIC_BY_COLOR,
  BEHAVIOR_AMOUNTS,
  BEHAVIOR_AMOUNT_OPS,
  BEHAVIOR_FROM_ZONES,
  BEHAVIOR_MANA_COLORS,
  BEHAVIOR_STEPS,
  BEHAVIOR_TOKENS,
  BEHAVIOR_TRIGGERS,
  BEHAVIOR_TYPES,
  BEHAVIOR_ZONES,
  CARD_BEHAVIOR_VERSION,
  CAST_OPTIONS,
  MAX_CAST_N,
  MAX_CAST_OPTIONS,
  MAX_TOKEN_PT,
  normalizeCost,
  ruleKind,
  stepFits,
  type CastOption,
  type CastOptionKind,
  type RuleKind,
  MAX_BEHAVIOR_AMOUNT,
  MAX_BEHAVIOR_QUERY,
  MAX_BEHAVIOR_RULES,
  MAX_BEHAVIOR_STEPS,
  MAX_QUERY_X,
  X_VARIANTS,
  behaviorFromEffect,
  decodeEffectProfile,
  decodeFetchProfile,
  decodeManaProfile,
  describeBehavior,
  describeExtraLand,
  describeFetch,
  describeLandRamp,
  describeManaSource,
  describeRitual,
  manaStepColors,
  normalizeManaColors,
  queryHasX,
  compileBehavior,
  sanitizeCardBehavior,
  substituteQueryX,
  type BehaviorAmount,
  type BehaviorAmountKind,
  type BehaviorAmountOp,
  type BehaviorRule,
  type BehaviorStep,
  type BehaviorStepKind,
  type BehaviorTrigger,
  type BehaviorZone,
  type CardBehavior,
  type EffectProfile,
} from '@mtg/shared';
import { Icon } from './icons.js';
import { ManaCost } from './ManaCost.js';
import { otherDeckBehaviors, setCardBehavior, type BorrowableBehavior } from '../db/dataAccess.js';
import { compileCardQuery, toSearchableEntry, type SearchableEntry } from '../cardDb/querySyntax.js';
import type { GroupRow } from '../analysis/groups.js';
import { HowWorked } from './HowWorked.js';
import { PolicySpread } from './PolicySpread.js';
import type { QueueCard, QueueReason } from '../analysis/coverage.js';
import { templatesFor, type Template } from '../analysis/behaviorTemplates.js';
import { gapWords, type ShippedDefaults } from '../analysis/defaultBehaviors.js';
import { oracleTagClosure } from '../cardDb/oracleTags.js';
import {
  COMBAT_POLICIES,
  INTERACTION_POLICIES,
  SPEND_POLICIES,
  type PolicyOption,
  type SpendRun,
  type SimPolicy,
  type SimRuleFires,
} from '../analysis/simulate.js';

// "What does this card actually do?", answered by the person holding it.
//
// The card database reads oracle text conservatively on purpose (see
// effectProfile.ts rule 2), so most of a deck reaches the simulator as a blank
// and the coverage line on the trajectory panel exists to admit it. This is the
// way out that does not need a rules engine: pick a trigger, pick what happens,
// pick where the number comes from, and the sequencer plays it out.
//
// Two screens in one sheet rather than two stacked sheets. The list is a
// picker, the editor is what the picker is for, and a sheet on a sheet on a
// sheet is three tap guards and two backdrops deep on a phone.

/** One distinct card in the deck, with whatever is currently known about it. */
interface BehaviorCard {
  oracleId: string;
  name: string;
  copies: number;
  /** An `{X}` in the printed cost, so "the mana you spent on X" is a real number. */
  hasX: boolean;
  /** What the card database reads, or null when it reads nothing. */
  derived: EffectProfile | null;
  /**
   * The other half of the database's reading: land ramp, off the mana profile
   * rather than the effect profile. A phrase, not rules — see describeLandRamp.
   */
  ramp: string | null;
  /** And the third: a fetchland's search, off the fetch profile. Same deal. */
  fetch: string | null;
  /** And the fourth: a ritual's burst, off the mana profile. Same deal again. */
  ritual: string | null;
  /**
   * And the fifth: extra land drops, off the mana profile. The last of the five
   * to get a line here, and the one that most needed one — an Arboreal Grazer
   * read as an Exploration sat in this list saying "Do nothing" while the
   * simulator handed it a land drop every turn for the rest of the game.
   */
  extraLand: string | null;
  /**
   * And what the card *is*: a land, a rock, a mana creature. The one reading a
   * rule written here does not replace, listed anyway because every effect the
   * simulator gives a card belongs on this screen — including the ones nobody
   * gets to argue with.
   */
  source: string | null;
  /** What the user said, or null when they have not said anything. */
  authored: CardBehavior | null;
  /**
   * The card itself, shown above the editor. Writing a rule means reading the
   * card, and reading it off a name alone is a memory test nobody asked for.
   */
  image: string | null;
  /**
   * The front face is something that stays on the battlefield, so "when it
   * enters" is a moment this card actually has. A sorcery does not get offered
   * one — see TriggerOption.permanentOnly.
   */
  permanent: boolean;
  /** And a creature, which is the one that can attack. */
  creature: boolean;
  /** Scryfall tag indices, for the starting points (rebuild plan C5). */
  tags: readonly number[];
  /**
   * The rule that ships with the app for this card, played whenever this deck
   * has not written its own (notes/edh-top, and C5's pre-written set).
   */
  shipped: CardBehavior | null;
  /**
   * Read by hand and found nothing to write yet: what it waits on, or an empty
   * list for a card that is right as nothing. Null when nobody has looked.
   */
  idle: readonly string[] | null;
}

/** "When you play it", straight out of the catalog so it is said in one place. */
const PLAY_LEAD = BEHAVIOR_TRIGGERS.find((t) => t.id === 'play')!.lead;

/** The front face decides it: a Murder never enters anything. */
const isPermanent = (typeLine: string) =>
  /\b(Creature|Artifact|Enchantment|Planeswalker|Battle|Land)\b/i.test(typeLine.split('//')[0] ?? '');
const isCreature = (typeLine: string) => /\bCreature\b/i.test(typeLine.split('//')[0] ?? '');

const isNotACard = (typeLine: string) => {
  const t = typeLine.toLowerCase();
  return t.startsWith('token') || t.includes('emblem') || t === 'card';
};

/**
 * The deck's distinct cards, merged the way buildSimDeck merges them: by
 * oracleId, across the mainboard and the command zone. A behavior is authored
 * against a card, not against a slot, so two slots of the same card are one
 * row here and one row in the database.
 */
function behaviorCards(rows: readonly GroupRow[], behaviors: ReadonlyMap<string, CardBehavior>, defaults: ShippedDefaults): BehaviorCard[] {
  const byOracle = new Map<string, BehaviorCard>();
  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o.typeLine)) continue;
    const existing = byOracle.get(o.oracleId);
    if (existing) {
      existing.copies += r.quantity;
      continue;
    }
    byOracle.set(o.oracleId, {
      oracleId: o.oracleId,
      name: o.name,
      copies: r.quantity,
      hasX: /\{X\}/i.test(o.manaCost ?? ''),
      derived: decodeEffectProfile(o.effect),
      ramp: describeLandRamp(decodeManaProfile(o.mana)),
      // Only when it makes no mana of its own. A Krosan Verge taps for {C} and
      // the sequencer files it as the colorless land it is, search dropped.
      fetch: o.produces ? null : describeFetch(decodeFetchProfile(o.fetch)),
      ritual: describeRitual(decodeManaProfile(o.mana), o.produces),
      extraLand: describeExtraLand(decodeManaProfile(o.mana)),
      source: describeManaSource(decodeManaProfile(o.mana), o.produces),
      authored: behaviors.get(o.oracleId) ?? null,
      image: o.imageNormal ?? o.imageSmall ?? null,
      permanent: isPermanent(o.typeLine),
      creature: isCreature(o.typeLine),
      tags: o.tags ?? [],
      shipped: defaults.behaviors.get(o.name) ?? null,
      idle: defaults.idle.get(o.name) ?? null,
    });
  }
  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The line under a card's name in the list. */
function summaryOf(card: BehaviorCard): string {
  const lines = describeBehavior(card.authored ?? card.shipped ?? behaviorFromEffect(card.derived));
  if (lines.length > 0) return lines.join('. ');
  // A Harrow used to read "Do nothing" here while the simulator was ramping off
  // it, which is exactly the card somebody then writes out by hand.
  if (card.ramp) return `${PLAY_LEAD}: ${card.ramp}`;
  if (card.fetch) return `${PLAY_LEAD}: ${card.fetch}`;
  if (card.ritual) return `${PLAY_LEAD}: ${card.ritual}`;
  if (card.extraLand) return `${PLAY_LEAD}: ${card.extraLand}`;
  // No lead on this one: a Forest taps for green whenever you like, which is
  // not a thing that happens when you play it.
  if (card.source) return card.source;
  return 'Do nothing';
}

/**
 * The "Plays out as" line: the draft if there is one, otherwise whatever the
 * card database read.
 *
 * Every derived reading, not the three that happened to be listed. Saying
 * "blank" under an Exploration is exactly what sends someone off to write a
 * rule the card already had — which was the whole complaint, one screen up.
 */
function playsOutAs(card: BehaviorCard, preview: readonly BehaviorRule[], cast: readonly CastOption[]): string {
  if (preview.length > 0 || cast.length > 0) return describeBehavior({ v: CARD_BEHAVIOR_VERSION, rules: [...preview], cast: [...cast] }).join('. ');
  const derived = card.ramp ?? card.fetch ?? card.ritual ?? card.extraLand;
  if (derived) return `${PLAY_LEAD}: ${derived}, read from the card`;
  // A Forest is not a blank, it is a Forest. The line under this one says so.
  if (card.source) return 'Nothing beyond what it is.';
  return 'Nothing. In the simulator this card does nothing.';
}

const NO_OFFERS: ReadonlyMap<string, BorrowableBehavior[]> = new Map();

/** A behavior's content for comparing two of them: its rules and its other ways to cast. */
const shapeOf = (b: { rules: readonly BehaviorRule[]; cast?: readonly CastOption[] }): string =>
  JSON.stringify({ rules: b.rules, cast: b.cast ?? [] });

/** "Elves", "Elves and Gruul", "Elves and 2 more". */
function deckNames(decks: readonly string[]): string {
  if (decks.length <= 2) return decks.join(' and ');
  return `${decks[0]} and ${decks.length - 1} more`;
}

/** How many of the deck's distinct cards a move step's criteria would find. */
export interface DeckMatcher {
  total: number;
  /** A range rather than a number, because a `[X]` query has one answer per X. */
  count: (q: string) => { min: number; max: number; varies: boolean };
}

export function CardBehaviorPanel({
  deckId,
  rows,
  behaviors,
  defaults,
  policy,
  onPolicy,
  openId,
  onOpenId,
  queue,
  onSaved,
  fires,
  onWatch,
  spread,
  spreadStale,
}: {
  deckId: string;
  rows: readonly GroupRow[];
  behaviors: ReadonlyMap<string, CardBehavior>;
  /** Rules that ship with the app, played for any card this deck has not written. */
  defaults: ShippedDefaults;
  /** How the sequencer plays the deck. The other half of "what does this card do". */
  policy: SimPolicy;
  onPolicy: (policy: SimPolicy) => void;
  /** The card in the editor. Held by the page so another tab can open one. */
  openId: string | null;
  onOpenId: (oracleId: string | null) => void;
  /** Blank cards worth writing, best first, or null with no tag vocabulary. */
  queue: readonly QueueCard[] | null;
  /** A rule was written or cleared: what was there before, for Undo. */
  onSaved: (oracleId: string, name: string, before: CardBehavior | null, cleared: boolean) => void;
  /** How often each saved trigger ran in the last run, or undefined before one. */
  fires: readonly SimRuleFires[] | undefined;
  /** Open one game with this card's lines picked out. */
  onWatch: (oracleId: string) => void;
  /** Every spend order's short run (rebuild plan C6), or undefined before one. */
  spread: readonly SpendRun[] | undefined;
  /** `spread` is from before the latest change. */
  spreadStale: boolean;
}) {
  const cards = useMemo(() => behaviorCards(rows, behaviors, defaults), [rows, behaviors, defaults]);
  // Rules for these cards in the user's other decks (rebuild plan C4). Live,
  // so a rule written in one tab is on offer in the other.
  const borrowable = useLiveQuery(() => otherDeckBehaviors(deckId), [deckId]) ?? NO_OFFERS;
  const setOpenId = onOpenId;
  const open = openId ? (cards.find((c) => c.oracleId === openId) ?? null) : null;

  // The same query engine the search bar uses, pointed at this deck. It runs on
  // every keystroke in the criteria box so a typo is a number that drops to
  // zero rather than a rule that quietly does nothing eight turns deep in a
  // simulation nobody can see into.
  const matcher = useMemo<DeckMatcher>(() => {
    const entries: SearchableEntry[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const o = r.oracle;
      if (!o || r.quantity <= 0) continue;
      if (r.board !== 'main' && r.board !== 'commander') continue;
      if (seen.has(o.oracleId) || isNotACard(o.typeLine)) continue;
      seen.add(o.oracleId);
      entries.push(toSearchableEntry(o));
    }
    const one = (q: string) => {
      const compiled = compileCardQuery(q);
      if (compiled.isEmpty) return entries.length;
      let n = 0;
      for (const e of entries) if (compiled.matches(e)) n++;
      return n;
    };
    return {
      total: entries.length,
      count: (q: string) => {
        if (!queryHasX(q)) {
          const n = one(q);
          return { min: n, max: n, varies: false };
        }
        // Twenty-one parses per keystroke, over a deck's worth of cards. It is
        // the same enumeration buildSimDeck does, and the point is the same:
        // the range tells you the query is sane at both ends of X, which one
        // number picked out of the middle would not.
        let min = Infinity;
        let max = 0;
        for (let x = 0; x < X_VARIANTS; x++) {
          const n = one(substituteQueryX(q, x));
          if (n < min) min = n;
          if (n > max) max = n;
        }
        return { min: min === Infinity ? 0 : min, max, varies: true };
      },
    };
  }, [rows]);

  // The panel is a tab on a page now, not a sheet with its own scroll, so a
  // card opened from far down the list would open its editor off screen.
  const top = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    // Not on mount: switching to the tab already lands at its top.
    if (!opened.current) {
      opened.current = true;
      return;
    }
    top.current?.scrollIntoView({ block: 'start' });
  }, [openId]);

  return (
    <div ref={top} className="behavior-panel">
      {open ? (
        <BehaviorEditor
          key={open.oracleId}
          deckId={deckId}
          card={open}
          matcher={matcher}
          onBack={() => setOpenId(null)}
          onSaved={onSaved}
          fires={fires?.filter((f) => f.oracleId === open.oracleId)}
          onWatch={() => onWatch(open.oracleId)}
          offers={borrowable.get(open.oracleId) ?? []}
        />
      ) : (
        <BehaviorList
          cards={cards}
          queue={queue}
          policy={policy}
          onPolicy={onPolicy}
          onOpen={setOpenId}
          borrowable={borrowable}
          spread={spread}
          spreadStale={spreadStale}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** The chip on a queued row: why it is worth writing. */
const REASON_LABEL: Record<QueueReason, string> = { draw: 'draws', ramp: 'ramps', tutor: 'tutors', engine: 'engine' };

/**
 * A queue, then the rest. The queue (rebuild plan C1) is the cards the tags say
 * should be drawing, ramping, tutoring or building something and the simulator
 * plays as nothing, best first, because that is the only list on this screen
 * that moves a number. Your own work next, since it is what you came back to
 * change. The two lists that need no attention fold away: blanks the tags have
 * nothing to say about (removal, beaters, which do nothing here and should
 * not), and everything the card database already reads.
 *
 * With no tag vocabulary there is no queue to build, so the blanks stay open
 * under one heading as before: we cannot tell which of them are fine.
 */
function BehaviorList({
  cards,
  queue,
  policy,
  onPolicy,
  onOpen,
  borrowable,
  spread,
  spreadStale,
}: {
  cards: BehaviorCard[];
  queue: readonly QueueCard[] | null;
  policy: SimPolicy;
  onPolicy: (policy: SimPolicy) => void;
  onOpen: (oracleId: string) => void;
  /** Rules for the same card in the user's other decks. */
  borrowable: ReadonlyMap<string, BorrowableBehavior[]>;
  spread: readonly SpendRun[] | undefined;
  spreadStale: boolean;
}) {
  // Every derived reading, not some of them. A fetchland and an Exploration
  // were both missing from this test, so both sat under "Nothing read yet"
  // with a line underneath saying what had in fact been read off them.
  const isRead = (c: BehaviorCard) => !!(c.derived || c.ramp || c.fetch || c.ritual || c.extraLand || c.source);
  const authored = cards.filter((c) => c.authored);
  const shipped = cards.filter((c) => !c.authored && c.shipped);
  const blank = cards.filter((c) => !c.authored && !c.shipped && !isRead(c));
  const read = cards.filter((c) => !c.authored && !c.shipped && isRead(c));
  // In the queue's order, not the list's. Only blanks: the queue is built off
  // the simulator's deck and this list off the rows, and a card the two
  // disagree about is better left where the list put it than shown twice.
  const byId = new Map(blank.map((c) => [c.oracleId, c]));
  const reasons = new Map<string, QueueReason>();
  const queued: BehaviorCard[] = [];
  for (const q of queue ?? []) {
    const c = byId.get(q.oracleId);
    if (!c || reasons.has(q.oracleId)) continue;
    reasons.set(q.oracleId, q.reason);
    queued.push(c);
  }
  // A blank you already wrote in another deck is one tap from done, so it does
  // not fold away with the blanks that need nothing.
  const ready = (c: BehaviorCard) => borrowable.has(c.oracleId);
  const elsewhere = blank.filter((c) => !reasons.has(c.oracleId) && ready(c));
  // Read by hand and waiting on something the simulator does not model yet.
  const waiting = blank.filter((c) => !reasons.has(c.oracleId) && !ready(c) && !!c.idle?.length);
  const quiet = blank.filter((c) => !reasons.has(c.oracleId) && !ready(c) && !c.idle?.length);

  if (cards.length === 0) {
    return <p className="fine-print">Nothing in the mainboard yet.</p>;
  }

  return (
    <>
      <PolicyPicker policy={policy} onPolicy={onPolicy} />
      <PolicySpread runs={spread} current={policy.spend} stale={spreadStale} onSpend={(spend) => onPolicy({ ...policy, spend })} />
      <h4 className="deck-stats-head">What each card does</h4>
      <p className="fine-print">
        The card database only reads what a card always does for you as it resolves. Anything behind a trigger or an "if" does
        nothing in the simulator until you write it here.
      </p>
      <HowWorked>
        <p className="fine-print">
          A rule can touch your hand, library, graveyard, exile and battlefield, and moves cards between them with the card search
          syntax. It replaces what the card <em>does</em>; what the card <em>is</em> stays, so a land still makes its mana
          unless you write its mana ability yourself. A rule can also make tokens, put counters on the card, grant +X/+X or a
          type while the card is out, and add other ways to cast it (kicker, flashback, suspend).
        </p>
        <p className="fine-print">
          Cards you write play out exactly as written, so for this deck the curves stop being a pure floor. The chip at the top
          says how many of your cards the simulator plays out.
        </p>
        {queue && (
          <p className="fine-print">
            "Write these first" is every card that does nothing yet and that Scryfall's tags call draw, ramp, a tutor or an engine
            (card advantage, recursion, repeatable tokens). Your commander leads, since every game has it. Then draw and ramp, which
            Flow and Mana measure directly, then tutors and engines, cheapest first because a card cast early works for more of the
            turns counted.
          </p>
        )}
        <p className="fine-print">
          The most-played Commander cards come with a rule written for them by hand, and the simulator plays it until you write
          your own. Those rules err low: where a card does more than a rule can say, the rest is left out. A card you wrote in
          another deck brings that rule along too, one tap in the card's editor.
        </p>
      </HowWorked>
      {queue ? (
        <>
          <Section title={`Write these first (${queued.length})`} cards={queued} reasons={reasons} onOpen={onOpen} borrowable={borrowable} suggest />
          <Section
            title={`Ready to use (${elsewhere.length})`}
            cards={elsewhere}
            onOpen={onOpen}
            borrowable={borrowable}
            suggest
          />
          <Section title={`Yours (${authored.length})`} cards={authored} onOpen={onOpen} />
          <Section title={`Written for you (${shipped.length})`} cards={shipped} onOpen={onOpen} folded />
          <Section title={`Waits on the simulator (${waiting.length})`} cards={waiting} onOpen={onOpen} folded />
          <Section title={`Right as nothing (${quiet.length})`} cards={quiet} onOpen={onOpen} borrowable={borrowable} folded />
        </>
      ) : (
        <>
          <Section title={`Yours (${authored.length})`} cards={authored} onOpen={onOpen} />
          <Section title={`Written for you (${shipped.length})`} cards={shipped} onOpen={onOpen} folded />
          <Section title={`Does nothing yet (${blank.length})`} cards={blank} onOpen={onOpen} borrowable={borrowable} suggest />
        </>
      )}
      <Section title={`From the card's text (${read.length})`} cards={read} onOpen={onOpen} borrowable={borrowable} folded />
    </>
  );
}

/**
 * How the simulator plays the deck, as three dropdowns.
 *
 * It lives on this screen rather than beside the charts because it is the same
 * question the rest of the screen asks, one level up. Down there you tell the
 * sequencer what a card does; up here you tell it what you would do with the
 * cards. A deck whose every card is written out perfectly and is then played
 * back-to-front is still not your deck.
 *
 * Three controls and no more. Every one of them changes a number somebody is
 * going to quote, so each has to be a sentence you could defend at a table —
 * which is also why the chosen one says what it means underneath rather than
 * hiding the explanation in a tooltip nobody on a phone can reach.
 */
function PolicyPicker({ policy, onPolicy }: { policy: SimPolicy; onPolicy: (policy: SimPolicy) => void }) {
  return (
    <>
      <h4 className="deck-stats-head">How it plays the deck</h4>
      <div className="behavior-policy">
        <PolicyField
          label="Spend the turn"
          value={policy.spend}
          options={SPEND_POLICIES}
          onChange={(spend) => onPolicy({ ...policy, spend })}
        />
        <PolicyField
          label="Combat"
          value={policy.combat}
          options={COMBAT_POLICIES}
          onChange={(combat) => onPolicy({ ...policy, combat })}
        />
        <PolicyField
          label="Interaction"
          value={policy.interaction}
          options={INTERACTION_POLICIES}
          onChange={(interaction) => onPolicy({ ...policy, interaction })}
        />
      </div>
      <p className="fine-print">
        Nobody is across the table, so these are about your own sequencing. Every simulated number follows them: pick the way you
        would actually play.
      </p>
    </>
  );
}

function PolicyField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly PolicyOption<T>[];
  onChange: (value: T) => void;
}) {
  const chosen = options.find((o) => o.id === value);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {chosen && <span className="behavior-policy-hint">{chosen.hint}</span>}
    </label>
  );
}

function Section({
  title,
  cards,
  reasons,
  folded,
  onOpen,
  borrowable,
  suggest,
}: {
  title: string;
  cards: BehaviorCard[];
  /** Why each card is queued, shown as a chip on the row. */
  reasons?: ReadonlyMap<string, QueueReason>;
  /** Behind a disclosure: a list you only open to look something up. */
  folded?: boolean;
  onOpen: (oracleId: string) => void;
  /** Only passed for cards without a rule here: the line under the name says what another deck wrote. */
  borrowable?: ReadonlyMap<string, BorrowableBehavior[]>;
  /** Blanks: an offer from another deck, when there is one, replaces "Do nothing" under its name. */
  suggest?: boolean;
}) {
  if (cards.length === 0) return null;
  const list = (
    <ul className="behavior-list">
      {cards.map((card) => {
        const reason = reasons?.get(card.oracleId);
        const offer = card.authored || !suggest ? undefined : borrowable?.get(card.oracleId)?.[0];
        const waits = !card.authored && !card.shipped && card.idle?.length ? card.idle : null;
        return (
          <li key={card.oracleId}>
            <button type="button" className="behavior-row" onClick={() => onOpen(card.oracleId)}>
              <span className="behavior-row-text">
                <span className="behavior-row-name">
                  {card.copies > 1 && <span className="behavior-row-qty">{card.copies}×</span>}
                  {card.name}
                </span>
                {offer ? (
                  <span className="behavior-row-what behavior-row-offer">
                    In {deckNames(offer.decks)}: {describeBehavior(offer.behavior).join('. ')}
                  </span>
                ) : waits ? (
                  <span className="behavior-row-what">Needs {gapWords(waits)}, which the simulator does not model yet</span>
                ) : (
                  <span className="behavior-row-what">{summaryOf(card)}</span>
                )}
              </span>
              {card.authored && <span className="behavior-tag">yours</span>}
              {!card.authored && card.shipped && <span className="behavior-tag">default</span>}
              {reason && <span className="behavior-tag behavior-tag-why">{REASON_LABEL[reason]}</span>}
              <Icon name="chevronRight" />
            </button>
          </li>
        );
      })}
    </ul>
  );
  if (folded) {
    return (
      <details className="behavior-fold">
        <summary className="deck-stats-head">{title}</summary>
        {list}
      </details>
    );
  }
  return (
    <>
      <h4 className="deck-stats-head">{title}</h4>
      {list}
    </>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const emptyStep = () => ({ op: 'draw' as BehaviorStepKind, x: { kind: 'fixed' as BehaviorAmountKind, n: 1 } });

/**
 * The step without a flag that no longer applies, rather than with it set to
 * `undefined`. A key carrying undefined survives every spread it meets and
 * disappears only at JSON.stringify, which is one save later than the place
 * anybody looking at the draft would expect it to be gone.
 */
function without(step: BehaviorStep, ...keys: (keyof BehaviorStep)[]): BehaviorStep {
  const out = { ...step };
  for (const key of keys) delete out[key];
  return out;
}

/**
 * One color ticked or unticked on a `mana` step.
 *
 * Unticking the last one is refused rather than obeyed: an empty `colors` is
 * how "any color" is *stored*, so obeying it would turn "only black" into "all
 * five" — the opposite of what the tap asked for. "All one color" goes with the
 * second-to-last tick, because one color on offer is already one color.
 */
function toggleManaColor(step: BehaviorStep, letter: string): BehaviorStep {
  const now = manaStepColors(step);
  const raw = now.includes(letter) ? [...now].filter((c) => c !== letter).join('') : now + letter;
  if (!raw) return step;
  const colors = normalizeManaColors(raw);
  const next = colors ? { ...step, colors } : without(step, 'colors');
  return colors.length === 1 ? without(next, 'oneColor') : next;
}

function BehaviorEditor({
  deckId,
  card,
  matcher,
  onBack,
  onSaved,
  fires,
  onWatch,
  offers,
}: {
  deckId: string;
  card: BehaviorCard;
  matcher: DeckMatcher;
  onBack: () => void;
  onSaved: (oracleId: string, name: string, before: CardBehavior | null, cleared: boolean) => void;
  fires: readonly SimRuleFires[] | undefined;
  onWatch: () => void;
  /** This card's rules in the user's other decks, newest first. */
  offers: readonly BorrowableBehavior[];
}) {
  // The draft opens on whatever is true now: your rules if you wrote some,
  // otherwise the card database's reading in the same grammar. Editing what we
  // read and writing your own are deliberately the same gesture — which is also
  // why saving *replaces* the derived reading rather than adding to it.
  // What plays now: your rule, else the one that ships for this card.
  const active = card.authored ?? card.shipped;
  const start = active ?? behaviorFromEffect(card.derived);
  const [rules, setRules] = useState<BehaviorRule[]>(() => (start ? start.rules.map((r) => ({ ...r, steps: [...r.steps] })) : []));
  // Other ways to cast it (rebuild plan F5): kicker, flashback, suspend.
  const [cast, setCast] = useState<CastOption[]>(() => (active?.cast ?? []).map((o) => ({ ...o })));
  const [saving, setSaving] = useState(false);

  const edit = (i: number, next: BehaviorRule) => setRules(rules.map((r, k) => (k === i ? next : r)));

  const save = async () => {
    setSaving(true);
    const kept = rules.filter((r) => r.steps.length > 0);
    // Through the same sanitizer a row off another device goes through, so the
    // stored bytes are normalized the one way: colors in WUBRGC order, flags
    // dropped where they say nothing, all five colors written as none at all.
    // Saving the same rule twice has to be the same row.
    let clean = kept.length > 0 || cast.length > 0 ? sanitizeCardBehavior({ v: CARD_BEHAVIOR_VERSION, rules: kept, cast }) : null;
    // The default saved unchanged is the default, not a rule of yours: storing
    // it would freeze this deck on today's version when the shipped one improves.
    if (clean && card.shipped && shapeOf(clean) === shapeOf(card.shipped)) clean = null;
    await setCardBehavior(deckId, card.oracleId, clean);
    // Saving what was already there changes nothing, and a toast saying so is noise.
    if (JSON.stringify(clean) !== JSON.stringify(card.authored)) onSaved(card.oracleId, card.name, card.authored, clean === null);
    onBack();
  };

  const reset = async () => {
    setSaving(true);
    await setCardBehavior(deckId, card.oracleId, null);
    if (card.authored) onSaved(card.oracleId, card.name, card.authored, true);
    onBack();
  };

  const preview = rules.filter((r) => r.steps.length > 0);
  // What this deck already saved is not an offer, however many decks share it.
  const saved = card.authored ? shapeOf(card.authored) : null;
  const shown = offers.filter((o) => shapeOf(o.behavior) !== saved);
  const drafted = shapeOf({ rules: preview, cast });
  /** A kicker in the draft, so "the times it was kicked" is a number worth offering. */
  const kicker = cast.some((o) => o.kind === 'kicker' || o.kind === 'multikicker');
  // The shipped rule, on offer once this deck has written over it.
  const pre = card.authored && card.shipped && shapeOf(card.shipped) !== saved ? card.shipped : null;
  // Starting points only for a card nobody has written: with a rule of yours or
  // a shipped one, a guess from the tags is a step backwards. And not for one
  // read by hand and found to have nothing worth writing yet.
  const starts: Template[] = active || card.idle ? [] : templatesFor(card, oracleTagClosure);
  const use = (b: CardBehavior) => {
    setRules(b.rules.map((r) => ({ ...r, steps: [...r.steps] })));
    setCast((b.cast ?? []).map((c) => ({ ...c })));
  };

  return (
    <>
      <button type="button" className="behavior-back" onClick={onBack}>
        <Icon name="chevronLeft" />
        <span>All cards</span>
      </button>

      {/* The card, because a rule is written by reading one. Sized so the type
          line and the rules box are legible on a phone without pushing the
          first dropdown two screens down. */}
      {card.image && <img className="behavior-art" src={card.image} alt={card.name} loading="lazy" />}

      {card.shipped && !card.authored && (
        <p className="fine-print">
          Written for this card by hand and played by default. It errs low: where the card does more than a rule can say, the rest
          is left out. Change anything below and save, and it becomes yours instead.
        </p>
      )}
      {!active && card.idle && (
        <p className="fine-print">
          {card.idle.length > 0
            ? `Read by hand: what this card does needs ${gapWords(card.idle)}, which the simulator does not model yet, so it plays as nothing.`
            : 'Read by hand: nothing on this card changes a game with nobody across the table, so it is right as nothing.'}
        </p>
      )}
      {card.derived && !active && (
        <p className="fine-print">
          Read off this card's oracle text. Change anything below and it becomes yours instead.
          {card.derived.unknown && ' One of these amounts is a floor we could not read exactly.'}
          {card.derived.tutor && ' The database calls this a tutor; the simulator resolves one as a draw off the top either way.'}
        </p>
      )}
      {/* Land ramp is read off the mana profile rather than the oracle text, so
          it never appeared in the rules below and the card looked blank. It is
          not editable here, but what replaces it has to be said out loud. */}
      {card.ramp && (
        <p className="fine-print">
          The card database reads this as land ramp: <em>{card.ramp}</em>. The simulator picks whichever land best fixes your
          colors. A rule of yours replaces that, so add the ramp as a step if you still want it.
        </p>
      )}
      {card.fetch && (
        <p className="fine-print">
          The card database reads this as a fetchland: <em>{card.fetch}</em>. The simulator fetches whichever land best fixes your
          colors. A rule of yours replaces that search, so add it as a step if you still want it.
        </p>
      )}
      {card.ritual && (
        <p className="fine-print">
          The card database reads this as a ritual: <em>{card.ritual}</em>. The mana is gone at end of turn, so the simulator only
          casts it when something in hand needs that mana now. A rule of yours replaces that; an "Add X mana" step makes mana of
          any color.
        </p>
      )}
      {card.extraLand && (
        <p className="fine-print">
          The card database reads this as extra land drops: <em>{card.extraLand}</em>. They only count when you have a spare land
          in hand. A rule of yours replaces that entirely, which is also how you say the card does not do this.
        </p>
      )}
      {card.source && (
        <p className="fine-print">
          What this card <em>is</em>: <em>{card.source}</em>. That comes from the type line and the printed mana ability, so only
          an "It taps for mana" rule replaces it: a Llanowar Elves taps for green whatever else you tell it to do.
        </p>
      )}
      {!card.derived && !card.ramp && !card.fetch && !card.ritual && !card.extraLand && !card.source && !active && !card.idle && (
        <p className="fine-print">
          The card database finds nothing on this card it can play out, so in the simulator it does nothing. Add a rule and it
          will.
        </p>
      )}

      {pre && (
        <>
          <h4 className="deck-stats-head">Written for this card</h4>
          <OfferList offers={[{ head: 'Ships with the app', behavior: pre }]} drafted={drafted} onUse={use} />
          <p className="fine-print">
            Read off the card by hand, erring low where the card does more than a rule can say. "Back to the default" below uses
            it again.
          </p>
        </>
      )}

      {shown.length > 0 && (
        <>
          <h4 className="deck-stats-head">From your other decks</h4>
          <OfferList offers={shown.map((o) => ({ head: deckNames(o.decks), behavior: o.behavior }))} drafted={drafted} onUse={use} />
          <p className="fine-print">
            Copies it into the draft below. Save to keep it; the other deck's rule stays as it is.
          </p>
        </>
      )}

      {starts.length > 0 && (
        <>
          <h4 className="deck-stats-head">Start from</h4>
          <OfferList offers={starts.map((t) => ({ head: t.label, behavior: t.behavior }))} drafted={drafted} onUse={use} />
          <p className="fine-print">
            Picked from what Scryfall's tags say the card does. The trigger is the part they know; the number is a guess, so read
            the card and fix it before you save.
          </p>
        </>
      )}

      {rules.map((rule, i) => (
        <RuleEditor
          key={i}
          rule={rule}
          matcher={matcher}
          hasX={card.hasX}
          permanent={card.permanent}
          creature={card.creature}
          kicker={kicker}
          onChange={(next) => edit(i, next)}
          onRemove={() => setRules(rules.filter((_r, k) => k !== i))}
        />
      ))}

      {rules.length < MAX_BEHAVIOR_RULES && (
        <button
          type="button"
          className="behavior-add"
          onClick={() => setRules([...rules, { on: 'play', steps: [emptyStep()] }])}
        >
          <Icon name="plus" />
          <span>Add a trigger</span>
        </button>
      )}

      <CastOptionsEditor options={cast} onChange={setCast} permanent={card.permanent} />

      <h4 className="deck-stats-head">Plays out as</h4>
      {/* With no rules of your own, what plays out is whatever the database
          read — which for a ramp spell is not nothing, and saying "blank" here
          is what sends someone off to write a rule the card already had. */}
      <p className="deck-stats-verdict">{playsOutAs(card, preview, cast)}</p>
      {/* What the card *is* is not replaced by anything written above, so it is
          said on its own line rather than folded into the sentence. */}
      {card.source && !preview.some((r) => r.on === 'tap') && <p className="fine-print">{card.source}, whatever the rules above say.</p>}
      {active && fires && fires.length > 0 && (
        <FiringCounts
          authored={active}
          fires={fires}
          edited={drafted !== shapeOf(active)}
        />
      )}
      <button type="button" className="behavior-watch" onClick={onWatch}>
        <Icon name="play" />
        <span>Watch it in a game</span>
      </button>

      <div className="sheet-actions">
        {card.authored && (
          <button type="button" onClick={() => void reset()} disabled={saving}>
            {card.shipped ? 'Back to the default' : 'Back to the database'}
          </button>
        )}
        <button type="button" onClick={onBack} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
          Save
        </button>
      </div>
    </>
  );
}

/**
 * Rules on offer, each one tap from the draft: pre-written, from another deck,
 * or a starting point. The button says when the draft already holds it.
 */
function OfferList({
  offers,
  drafted,
  onUse,
}: {
  offers: readonly { head: string; behavior: CardBehavior }[];
  /** The draft's shape, to tell which offer it already is. */
  drafted: string;
  onUse: (behavior: CardBehavior) => void;
}) {
  return (
    <ul className="behavior-offers">
      {offers.map((o, i) => {
        const inDraft = shapeOf(o.behavior) === drafted;
        return (
          <li key={i}>
            <span className="behavior-offer-text">
              <span className="behavior-offer-deck">{o.head}</span>
              <span>{describeBehavior(o.behavior).join('. ')}</span>
            </span>
            <button type="button" disabled={inDraft} onClick={() => onUse(o.behavior)}>
              {inDraft ? 'In the draft' : 'Use this'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const firePct = (p: number) => (p > 0 && p < 0.005 ? 'under 1%' : `${Math.round(p * 100)}%`);

/**
 * How often each saved trigger ran (rebuild plan C3), which is the question a
 * rule nobody can see fire leaves open. Rules on one plain trigger run as one
 * list, so they are one line here; a watched trigger's rules are one line each,
 * named by what they watch for. Read off the saved rules, because those are the
 * ones the run dealt.
 */
function FiringCounts({
  authored,
  fires,
  edited,
}: {
  authored: CardBehavior;
  fires: readonly SimRuleFires[];
  edited: boolean;
}) {
  const compiled = compileBehavior(authored);
  const lines = fires.map((f) => {
    const lead = BEHAVIOR_TRIGGERS.find((t) => t.id === f.on)?.lead ?? f.on;
    const q = f.watch !== undefined && (f.on === 'cast' || f.on === 'enters') ? compiled?.[f.on][f.watch]?.q : undefined;
    const label = q ? `${lead} (${q})` : lead;
    // Once a game is the usual answer for a play rule and says nothing twice.
    const times = f.perGame >= 1.05 ? `, ${f.perGame.toFixed(1)} times a game` : '';
    return { key: `${f.on}:${f.watch ?? ''}`, label, text: f.games > 0 ? `${firePct(f.games)} of games${times}` : 'never', never: f.games === 0 };
  });
  return (
    <>
      <h4 className="deck-stats-head">How often it fires</h4>
      <ul className="behavior-fires">
        {lines.map((l) => (
          <li key={l.key} className={l.never ? 'tone-warn' : undefined}>
            <span>{l.label}</span>
            <strong>{l.text}</strong>
          </li>
        ))}
      </ul>
      {edited && <p className="fine-print">For the saved rules. Save these and the games are dealt again.</p>}
    </>
  );
}

/**
 * The "X = …" picker, plus the number box when X is a fixed one. Used twice on
 * a move step: once for how many cards to move, once for what the query's own
 * `[X]` is worth. Two different numbers, one vocabulary.
 *
 * A computed amount also gets an operator and a number beside it, so "half your
 * library" and "that many minus one" are writable without an amount kind per
 * card. Three controls abreast at 393px is the thing the step layout already
 * learned not to do; it works here only because the operator is one glyph wide
 * and the amount labels were shortened to match ("X = your graveyard", with the
 * full phrase kept for the sentence the rule is written out as).
 */
function AmountPicker({
  value,
  label,
  offer,
  onChange,
  matcher,
}: {
  value: BehaviorAmount;
  label: string;
  /** Which of the catalog's amounts make sense here. */
  offer: (o: (typeof BEHAVIOR_AMOUNTS)[number]) => boolean;
  onChange: (next: BehaviorAmount) => void;
  /** For the criteria of a `matching` amount. */
  matcher?: DeckMatcher;
}) {
  const adjustable = !BEHAVIOR_AMOUNTS.find((o) => o.id === value.kind)?.noAdjust;
  const picker = (
    <div className="behavior-x">
      <label className="field">
        <select
          value={value.kind}
          aria-label={label}
          onChange={(e) => {
            const kind = e.target.value as BehaviorAmountKind;
            // Switching to a kind that takes no adjustment drops the one that
            // was there, rather than parking it somewhere it cannot be seen
            // or removed.
            if (BEHAVIOR_AMOUNTS.find((o) => o.id === kind)?.noAdjust) {
              onChange(kind === 'fixed' ? { kind, n: value.n ?? 1 } : { kind });
              return;
            }
            onChange(value.op && value.by ? { kind, op: value.op, by: value.by } : { kind });
          }}
        >
          {/* Whatever is already selected stays listed even when it no longer
              qualifies — delete the first step of a rule and the second one's
              "previous X" would otherwise leave a select with nothing in it,
              unreadable and unfixable. */}
          {BEHAVIOR_AMOUNTS.filter((o) => offer(o) || o.id === value.kind).map((o) => (
            <option key={o.id} value={o.id}>
              X = {o.label}
            </option>
          ))}
        </select>
      </label>
      {value.kind === 'fixed' && (
        <label className="field behavior-n">
          <input
            type="number"
            min={0}
            max={MAX_BEHAVIOR_AMOUNT}
            inputMode="numeric"
            aria-label="How many"
            value={value.n ?? 0}
            onChange={(e) => {
              const n = Math.max(0, Math.min(MAX_BEHAVIOR_AMOUNT, Math.round(Number(e.target.value) || 0)));
              onChange({ kind: 'fixed', n });
            }}
          />
        </label>
      )}
      {/* Blank until someone picks one, which is also what it means: take the
          number as it comes. The number box appears with the operator rather
          than sitting there empty, so an unadjusted amount is two controls. */}
      {adjustable && (
        <label className="field behavior-opsel">
          <select
            value={value.op ?? ''}
            aria-label={`${label}, adjusted`}
            onChange={(e) => {
              const op = e.target.value as BehaviorAmountOp | '';
              const q = value.q ? { q: value.q } : {};
              onChange(op ? { kind: value.kind, op, by: value.by ?? 1, ...q } : { kind: value.kind, ...q });
            }}
          >
            <option value=""></option>
            {BEHAVIOR_AMOUNT_OPS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.symbol}
              </option>
            ))}
          </select>
        </label>
      )}
      {adjustable && value.op && (
        <label className="field behavior-n">
          <input
            type="number"
            min={1}
            max={MAX_BEHAVIOR_AMOUNT}
            inputMode="numeric"
            aria-label="Adjust by how much"
            value={value.by ?? 1}
            onChange={(e) => {
              const by = Math.max(1, Math.min(MAX_BEHAVIOR_AMOUNT, Math.round(Number(e.target.value) || 1)));
              onChange({ ...value, by });
            }}
          />
        </label>
      )}
    </div>
  );
  if (value.kind !== 'matching') return picker;
  // "Permanents you control matching": the criteria belongs to the amount, so
  // it sits right under it rather than with the step's own.
  return (
    <div className="behavior-amount">
      {picker}
      <div className="behavior-q behavior-rule-q">
        <label className="field">
          <input
            type="text"
            value={value.q ?? ''}
            maxLength={MAX_BEHAVIOR_QUERY}
            aria-label="Which of your permanents count"
            placeholder="Every permanent, or t:elf, t:artifact, …"
            onChange={(e) => onChange({ ...value, q: e.target.value })}
          />
        </label>
        {matcher && <MatchNote q={value.q ?? ''} matcher={matcher} />}
      </div>
    </div>
  );
}

/**
 * How a card arrives on the battlefield, for the two steps that can put one
 * there.
 *
 * Tapped is the default because it is what every such step did before this
 * existed, and because it is the conservative half: a Sol Ring that arrives
 * untapped pays for something the turn it lands, and a model that assumed so
 * everywhere would be reading the generous half of two cards that both print.
 */
function TapPicker({ step, onChange }: { step: BehaviorStep; onChange: (next: BehaviorStep) => void }) {
  return (
    <label className="field">
      <select
        value={step.untapped ? 'untapped' : 'tapped'}
        aria-label="How it arrives"
        onChange={(e) => onChange(e.target.value === 'untapped' ? { ...step, untapped: true } : without(step, 'untapped'))}
      >
        <option value="tapped">Arrives tapped</option>
        <option value="untapped">Arrives untapped</option>
      </select>
    </label>
  );
}

/** How many cards in the deck a criteria string finds, live as it is typed. */
function MatchNote({ q, matcher }: { q: string; matcher: DeckMatcher }) {
  const trimmed = q.trim();
  const hit = useMemo(() => matcher.count(trimmed), [trimmed, matcher]);
  if (!trimmed) return <span className="fine-print">Any of the {matcher.total} cards in this deck.</span>;
  if (hit.max === 0) return <span className="fine-print behavior-nomatch">Matches nothing in this deck.</span>;
  const how = hit.varies && hit.min !== hit.max ? `${hit.min} to ${hit.max}` : String(hit.max);
  return (
    <span className="fine-print">
      Matches {how} of {matcher.total} cards in this deck{hit.varies && hit.min !== hit.max ? ', depending on X' : ''}.
    </span>
  );
}

/** The steps a fresh rule of each kind opens on. */
const firstStep = (kind: RuleKind): BehaviorStep =>
  kind === 'static'
    ? { op: 'pump', x: { kind: 'fixed', n: 1 } }
    : kind === 'tap'
      ? { op: 'tapsfor', x: { kind: 'fixed', n: 1 }, colors: 'C' }
      : emptyStep();

/** The fields only one verb reads, dropped when the verb changes so none of them hides in the row. */
const VERB_FIELDS: (keyof BehaviorStep)[] = ['colors', 'oneColor', 'tk', 'tp', 'tt', 'ty', 'kw', 'ck', 'sub'];

function RuleEditor({
  rule,
  matcher,
  hasX,
  permanent,
  creature,
  kicker,
  onChange,
  onRemove,
}: {
  rule: BehaviorRule;
  matcher: DeckMatcher;
  /** The card's printed cost has an `{X}`. */
  hasX: boolean;
  /** The card can be on the battlefield, so "when it enters" is offered. */
  permanent: boolean;
  /** And it can attack, which is a shorter list than that. */
  creature: boolean;
  /** The draft has a kicker, so "the times it was kicked" means something. */
  kicker: boolean;
  onChange: (next: BehaviorRule) => void;
  onRemove: () => void;
}) {
  const setStep = (i: number, next: BehaviorRule['steps'][number]) =>
    onChange({ ...rule, steps: rule.steps.map((s, k) => (k === i ? next : s)) });
  const trigger = BEHAVIOR_TRIGGERS.find((t) => t.id === rule.on);
  const kind = ruleKind(rule.on);
  // A trigger the card cannot have is hidden, unless the rule is already on it:
  // a type line read one way today and another way tomorrow must not silently
  // orphan a rule somebody wrote.
  const triggers = BEHAVIOR_TRIGGERS.filter(
    (t) => !t.needs || rule.on === t.id || (t.needs === 'creature' ? creature : permanent),
  );
  /** "The mana you spent on X" is a number only while the cast is resolving. */
  const xAvailable = hasX && rule.on === 'play';
  /** And the kick count, while it is being cast or arriving from that cast. */
  const kickAvailable = kicker && (rule.on === 'play' || rule.on === 'etb');
  /** The amounts that read a moment make no sense in a standing effect. */
  const momentary = kind === 'trigger';

  /**
   * Moving a rule off `play` takes its X with it, so any amount reading one
   * becomes a fixed zero rather than a select with nothing selected in it.
   * Moving it to a different kind of rule (a trigger to a static) starts the
   * steps over, because none of them would fit.
   */
  const changeTrigger = (on: BehaviorTrigger) => {
    const next = BEHAVIOR_TRIGGERS.find((t) => t.id === on);
    const nextKind = ruleKind(on);
    // The criteria belongs to the moment, not to the rule: move off a watched
    // trigger and there is nothing for it to narrow, so it goes rather than
    // sitting in the row invisibly and coming back on the way past.
    const q = next?.watches || nextKind === 'static' ? rule.q : undefined;
    if (nextKind !== kind) {
      onChange({ on, q, steps: [firstStep(nextKind)] });
      return;
    }
    if (on === 'play' || !hasX) {
      onChange({ ...rule, on, q });
      return;
    }
    const drop = (a: BehaviorAmount | undefined): BehaviorAmount | undefined =>
      a?.kind === 'xpaid' ? { kind: 'fixed', n: 0 } : a;
    onChange({
      ...rule,
      on,
      q,
      steps: rule.steps.map((s) => {
        const x = drop(s.x) ?? s.x;
        const qx = drop(s.qx);
        return qx ? { ...s, x, qx } : { ...s, x };
      }),
    });
  };

  /**
   * Switching verbs carries over what still applies and drops what does not.
   * The zones and the criteria only mean anything on a move, and "all that
   * match" is bounded by a source zone that a draw step does not have.
   */
  const changeOp = (i: number, step: BehaviorStep, op: BehaviorStepKind) => {
    // The fields one verb reads belong to that verb, and nothing else can read
    // them. Dropped on the way out rather than kept invisibly and revived on
    // the way past.
    const base = without(step, ...VERB_FIELDS);
    const counted = base.x.kind === 'all' ? { kind: 'fixed' as const, n: 1 } : base.x;
    const one = { kind: 'fixed' as const, n: 1 };
    switch (op) {
      case 'flicker':
        // The criteria and any `[X]` in it carry over from a move; the zones do
        // not, because a flicker does not have any, and neither does how it lands.
        setStep(i, { ...without(base, 'from', 'to', 'untapped'), op });
        return;
      case 'move': {
        const from = base.from && BEHAVIOR_FROM_ZONES.some((z) => z.id === base.from) ? base.from : 'library';
        const to = base.to === from ? 'hand' : (base.to ?? 'hand');
        setStep(i, { ...base, op, from, to, ...(to === 'battlefield' && base.untapped ? { untapped: true } : {}) });
        return;
      }
      case 'self': {
        // One card, no criteria, and the amount is not a choice — see the step's
        // own note below. Exile is the default because self-exile is the case
        // this exists for.
        const to = base.to ?? 'exile';
        setStep(i, { op, x: one, to, ...(to === 'battlefield' && base.untapped ? { untapped: true } : {}) });
        return;
      }
      case 'token':
        setStep(i, { op, x: counted, tk: 'beast' });
        return;
      case 'counter':
        setStep(i, { op, x: counted, ck: 'p1p1' });
        return;
      case 'pump':
        setStep(i, { op, x: counted, ...(kind === 'trigger' && base.q ? { q: base.q } : {}) });
        return;
      case 'keyword':
        setStep(i, { op, x: one, kw: 'H', ...(kind === 'trigger' && base.q ? { q: base.q } : {}) });
        return;
      case 'addtype':
        setStep(i, { op, x: one, ty: 'L', sub: 'G' });
        return;
      case 'landfrom':
        setStep(i, { op, x: one, from: 'graveyard' });
        return;
      case 'nomaxhand':
        setStep(i, { op, x: one });
        return;
      case 'extramana':
        setStep(i, { op, x: counted, colors: 'G' });
        return;
      case 'tapsfor':
        setStep(i, { op, x: counted, colors: 'C' });
        return;
      default:
        setStep(i, { op, x: counted });
    }
  };

  /**
   * The two zones can never be the same one, so picking a clash pushes the
   * other end somewhere else. Not always a swap: the top and the bottom of the
   * library are destinations only, so a clash on the destination end falls back
   * to the first source zone that is not the one just picked.
   */
  const changeZone = (i: number, step: BehaviorStep, end: 'from' | 'to', zone: BehaviorZone) => {
    if (end === 'from') {
      setStep(i, { ...step, from: zone, to: step.to === zone ? (step.from ?? 'hand') : step.to });
      return;
    }
    const from = step.from === zone ? BEHAVIOR_FROM_ZONES.find((z) => z.id !== zone)?.id : step.from;
    // Only the battlefield has two ways to arrive, so moving the destination
    // anywhere else takes the answer with it.
    const base = zone === 'battlefield' ? step : without(step, 'untapped');
    setStep(i, { ...base, to: zone, from });
  };

  const verbs = BEHAVIOR_STEPS.filter((o) => stepFits(o.id, kind) || o.id === rule.steps[0]?.op);
  const maxSteps = kind === 'tap' ? 1 : MAX_BEHAVIOR_STEPS;

  return (
    <div className="behavior-rule">
      <div className="behavior-rule-head">
        {/* A dropdown and not the segmented row it used to be. Two triggers fit
            abreast on a 393px phone and three just did; five is 60px apiece,
            which is "Each up" and "When it e". Same control as every other
            choice in this editor, which is the other half of the argument. */}
        <label className="field behavior-trigger">
          <select
            value={rule.on}
            aria-label="When this happens"
            onChange={(e) => changeTrigger(e.target.value as BehaviorTrigger)}
          >
            {triggers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="behavior-drop" onClick={onRemove} aria-label="Remove this trigger">
          <Icon name="trash" />
        </button>
      </div>
      {trigger && <p className="fine-print">{trigger.hint}</p>}

      {/* A watched trigger's criteria: which cards wake the rule. Above the
          steps rather than beside them, because it says *when* this happens and
          the steps say what. Landfall is one word in a box. A static rule's
          criteria says which of your permanents it applies to, and sits in the
          same place for the same reason. */}
      {(trigger?.watches || kind === 'static') && (
        <div className="behavior-q behavior-rule-q">
          <label className="field">
            <input
              type="text"
              value={rule.q ?? ''}
              maxLength={MAX_BEHAVIOR_QUERY}
              aria-label={kind === 'static' ? 'Which of your permanents it applies to' : 'Which cards wake this'}
              placeholder={
                kind === 'static'
                  ? 'All of them, or t:creature, t:elf, …'
                  : rule.on === 'cast'
                    ? 'Any spell, or t:instant or t:sorcery, …'
                    : 'Any permanent, or t:land, t:creature, …'
              }
              onChange={(e) => onChange({ ...rule, q: e.target.value })}
            />
          </label>
          <MatchNote q={rule.q ?? ''} matcher={matcher} />
          {/* The examples live in the trigger's hint, right above this. What is
              left is what that hint does not say: where the syntax comes from,
              what blank means, and where the chain stops. */}
          <p className="fine-print">
            {kind === 'static'
              ? 'Card search syntax, matched against this deck. Types a rule adds count here too: with Ashaya out, t:land finds your creatures.'
              : 'Card search syntax, matched against this deck, same as a move step\'s. Leave it empty and anything wakes it. Triggers chain two deep, so an engine that feeds itself stops rather than spinning.'}
          </p>
        </div>
      )}

      {rule.steps.map((step, i) => {
        const move = step.op === 'move';
        const flicker = step.op === 'flicker';
        const self = step.op === 'self';
        const colorsStep = step.op === 'mana' || step.op === 'extramana' || step.op === 'tapsfor';
        const info = BEHAVIOR_STEPS.find((o) => o.id === step.op);
        // Both of them narrow what they reach with a criteria box; only a move
        // has two zones to pick. A pump or a haste grant on a trigger narrows
        // which creatures get it; on a static the rule's own criteria does.
        const creatureQuery = (step.op === 'pump' || step.op === 'keyword') && kind === 'trigger';
        const narrows = move || flicker || creatureQuery;
        const objectControls = step.op === 'token' || step.op === 'counter' || step.op === 'addtype' || step.op === 'landfrom';
        // The one destination with two ways to arrive, and the only place the
        // question is worth asking.
        const lands = (move || self) && step.to === 'battlefield';
        const colors = manaStepColors(step);
        // The grid rows this step has, top to bottom.
        const areas = [
          "'op drop'",
          !info?.noAmount && "'x drop'",
          (self || move) && "'zones drop'",
          objectControls && "'obj drop'",
          colorsStep && "'colors drop'",
          narrows && "'q drop'",
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div className="behavior-step" style={{ gridTemplateAreas: areas }} key={i}>
            {/* The verb on its own line and the number under it: three controls
                abreast on a 393px phone truncates every one of them, and "X = cards
                in your h" is not a choice anybody can make. */}
            <label className="field behavior-op">
              <select value={step.op} aria-label="What happens" onChange={(e) => changeOp(i, step, e.target.value as BehaviorStepKind)}>
                {verbs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {/* A `self` step moves one card and that card is this one, so an
                amount picker on it would be a control with a single setting. */}
            {!info?.noAmount && (
              <AmountPicker
                value={step.x}
                label="Where X comes from"
                matcher={matcher}
                offer={(o) =>
                  (move || flicker || !o.moveOnly) &&
                  (!o.needsX || (xAvailable && momentary)) &&
                  (!o.needsPrev || (i > 0 && momentary)) &&
                  (!o.needsKicker || kickAvailable) &&
                  (!o.needsPermanent || permanent)
                }
                onChange={(x) => setStep(i, { ...step, x })}
              />
            )}
            {self && (
              <div className="behavior-zones">
                <label className="field">
                  <select
                    value={step.to ?? 'exile'}
                    aria-label="Where this card goes"
                    onChange={(e) => setStep(i, { ...step, to: e.target.value as BehaviorZone })}
                  >
                    {BEHAVIOR_ZONES.map((z) => (
                      <option key={z.id} value={z.id}>
                        Into {z.toLabel ?? z.label}
                      </option>
                    ))}
                  </select>
                </label>
                {lands && <TapPicker step={step} onChange={(next) => setStep(i, next)} />}
              </div>
            )}
            {/* Only a move picks zones. A flicker's two ends are both the
                battlefield, which is what makes it a different verb. */}
            {move && (
              <div className="behavior-zones">
                <label className="field">
                  <select
                    value={step.from ?? 'library'}
                    aria-label="Move from"
                    onChange={(e) => changeZone(i, step, 'from', e.target.value as BehaviorZone)}
                  >
                    {BEHAVIOR_FROM_ZONES.map((z) => (
                      <option key={z.id} value={z.id}>
                        From {z.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <select
                    value={step.to ?? 'hand'}
                    aria-label="Move to"
                    onChange={(e) => changeZone(i, step, 'to', e.target.value as BehaviorZone)}
                  >
                    {BEHAVIOR_ZONES.map((z) => (
                      <option key={z.id} value={z.id}>
                        To {z.toLabel ?? z.label}
                      </option>
                    ))}
                  </select>
                </label>
                {lands && <TapPicker step={step} onChange={(next) => setStep(i, next)} />}
              </div>
            )}
            {objectControls && <ObjectControls step={step} onChange={(next) => setStep(i, next)} />}
            {colorsStep && (
              <div className="behavior-colors">
                <div className="behavior-swatches" role="group" aria-label="Which colors this mana can be">
                  {BEHAVIOR_MANA_COLORS.map((c) => {
                    const on = colors.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`behavior-swatch${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        aria-label={c.label}
                        onClick={() => setStep(i, toggleManaColor(step, c.id))}
                      >
                        <ManaCost cost={c.symbol} />
                      </button>
                    );
                  })}
                </div>
                {/* Only with something to choose between. One color on offer is
                    already all of one color, and a checkbox that cannot change
                    the answer is §12.2's lie wearing a tick box. */}
                {colors.length > 1 && step.op !== 'extramana' && (
                  <label className="behavior-check">
                    <input
                      type="checkbox"
                      checked={!!step.oneColor}
                      onChange={(e) => setStep(i, e.target.checked ? { ...step, oneColor: true } : without(step, 'oneColor'))}
                    />
                    <span>All of it the same color</span>
                  </label>
                )}
                {step.op === 'mana' && (
                  <span className="fine-print">
                    {colors.length === 1
                      ? 'Every mana this adds is that color, the way a Dark Ritual adds three black.'
                      : step.oneColor
                        ? 'One color, picked as it resolves, and all of the mana is that one: a Lotus Field, not a Burnt Offering.'
                        : 'Each mana can be any of these, picked as it is spent. All five is any color, which is the default.'}
                  </span>
                )}
              </div>
            )}
            {narrows && (
              <div className="behavior-q">
                <label className="field">
                  <input
                    type="text"
                    value={step.q ?? ''}
                    maxLength={MAX_BEHAVIOR_QUERY}
                    aria-label={creatureQuery ? 'Which creatures' : 'Which cards'}
                    placeholder={
                      creatureQuery
                        ? 'All your creatures, or t:elf, …'
                        : flicker
                          ? 'Any permanent, or t:creature, …'
                          : 'Any card, or t:basic, t:creature mv<=3, …'
                    }
                    onChange={(e) => setStep(i, { ...step, q: e.target.value })}
                  />
                </label>
                <MatchNote q={step.q ?? ''} matcher={matcher} />
                {/* The control appears because the query asked for it. No
                    placeholder, no dropdown, and nothing to explain away. */}
                {!creatureQuery && queryHasX(step.q) && (
                  <>
                    <span className="fine-print behavior-plug-lead">[X] in that query is:</span>
                    <AmountPicker
                      value={step.qx ?? { kind: 'fixed', n: 0 }}
                      label="What [X] in the criteria is worth"
                      offer={(o) => !o.moveOnly && !o.hasQuery && (!o.needsX || xAvailable) && (!o.needsPrev || i > 0) && (!o.needsKicker || kickAvailable)}
                      onChange={(qx) => setStep(i, { ...step, qx })}
                    />
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              className="behavior-drop"
              onClick={() => onChange({ ...rule, steps: rule.steps.filter((_s, k) => k !== i) })}
              aria-label="Remove this step"
            >
              <Icon name="close" />
            </button>
          </div>
        );
      })}

      <StepNotes rule={rule} kind={kind} />

      {rule.steps.length < maxSteps && (
        <button
          type="button"
          className="behavior-add"
          onClick={() => onChange({ ...rule, steps: [...rule.steps, firstStep(kind)] })}
        >
          <Icon name="plus" />
          <span>Then…</span>
        </button>
      )}
    </div>
  );
}

/** The extra controls of the object-layer steps (rebuild plan F): which token, which counter, which type, which zone. */
function ObjectControls({ step, onChange }: { step: BehaviorStep; onChange: (next: BehaviorStep) => void }) {
  if (step.op === 'token') {
    const custom = step.tk === 'custom';
    const types = step.ty || 'C';
    const creature = types.includes('C');
    const toggleType = (letter: string) => {
      const next = types.includes(letter) ? types.replace(letter, '') : types + letter;
      // A token is something. Unticking the last type is refused, the way the
      // mana colors refuse their last one.
      if (!next) return;
      const ordered = [...'CAE'].filter((t) => next.includes(t)).join('');
      const base = { ...step, ty: ordered };
      onChange(ordered.includes('C') ? { ...base, tp: step.tp ?? 1, tt: step.tt ?? 1 } : without(base, 'tp', 'tt', 'kw'));
    };
    return (
      <div className="behavior-obj">
        <label className="field">
          <select
            value={step.tk ?? 'beast'}
            aria-label="Which token"
            onChange={(e) =>
              onChange(
                e.target.value === 'custom'
                  ? { ...step, tk: 'custom', ty: 'C', tp: 1, tt: 1 }
                  : without({ ...step, tk: e.target.value }, 'ty', 'tp', 'tt', 'kw'),
              )
            }
          >
            {BEHAVIOR_TOKENS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {custom && (
          <>
            <div className="behavior-obj-row" role="group" aria-label="Its card types">
              {BEHAVIOR_TYPES.filter((t) => t.id !== 'L').map((t) => (
                <label key={t.id} className="behavior-check">
                  <input type="checkbox" checked={types.includes(t.id)} onChange={() => toggleType(t.id)} />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
            {creature && (
              <div className="behavior-obj-row">
                <label className="field behavior-n">
                  <input
                    type="number"
                    min={0}
                    max={MAX_TOKEN_PT}
                    inputMode="numeric"
                    aria-label="Power"
                    value={step.tp ?? 1}
                    onChange={(e) => onChange({ ...step, tp: Math.max(0, Math.min(MAX_TOKEN_PT, Math.round(Number(e.target.value) || 0))) })}
                  />
                </label>
                <span className="behavior-pt-slash">/</span>
                <label className="field behavior-n">
                  <input
                    type="number"
                    min={1}
                    max={MAX_TOKEN_PT}
                    inputMode="numeric"
                    aria-label="Toughness"
                    value={step.tt ?? 1}
                    onChange={(e) => onChange({ ...step, tt: Math.max(1, Math.min(MAX_TOKEN_PT, Math.round(Number(e.target.value) || 1))) })}
                  />
                </label>
                <label className="behavior-check">
                  <input
                    type="checkbox"
                    checked={!!step.kw?.includes('H')}
                    onChange={(e) => onChange(e.target.checked ? { ...step, kw: 'H' } : without(step, 'kw'))}
                  />
                  <span>Haste</span>
                </label>
              </div>
            )}
          </>
        )}
      </div>
    );
  }
  if (step.op === 'counter') {
    return (
      <div className="behavior-obj">
        <label className="field">
          <select
            value={step.ck ?? 'p1p1'}
            aria-label="Which counters"
            onChange={(e) => onChange({ ...step, ck: e.target.value === 'charge' ? 'charge' : 'p1p1' })}
          >
            <option value="p1p1">+1/+1 counters</option>
            <option value="charge">Charge counters (or any other kind)</option>
          </select>
        </label>
      </div>
    );
  }
  if (step.op === 'addtype') {
    return (
      <div className="behavior-obj behavior-zones">
        <label className="field">
          <select
            value={step.ty ?? 'L'}
            aria-label="Which type"
            onChange={(e) => {
              const ty = e.target.value;
              onChange(ty === 'L' ? { ...step, ty } : without({ ...step, ty }, 'sub'));
            }}
          >
            {BEHAVIOR_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {step.ty === 'L' && (
          <label className="field">
            <select
              value={step.sub ?? ''}
              aria-label="Which basic land type"
              onChange={(e) => onChange(e.target.value ? { ...step, sub: e.target.value } : without(step, 'sub'))}
            >
              <option value="">No basic land type</option>
              {Object.entries(BASIC_BY_COLOR).map(([color, name]) => (
                <option key={color} value={color}>
                  {name} (taps for {`{${color}}`})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    );
  }
  if (step.op === 'landfrom') {
    return (
      <div className="behavior-obj">
        <label className="field">
          <select
            value={step.from ?? 'graveyard'}
            aria-label="From where"
            onChange={(e) => onChange({ ...step, from: e.target.value as BehaviorZone })}
          >
            <option value="graveyard">From your graveyard</option>
            <option value="librarytop">From the top of your library</option>
          </select>
        </label>
      </div>
    );
  }
  return null;
}

/** What a rule's steps need explaining, behind one disclosure. */
function StepNotes({ rule, kind }: { rule: BehaviorRule; kind: RuleKind }) {
  const has = (...ops: BehaviorStepKind[]) => rule.steps.some((s) => ops.includes(s.op));
  const amounts = rule.steps.flatMap((s) => [s.x, ...(s.qx ? [s.qx] : [])]);
  const notes: { key: string; text: React.ReactNode }[] = [];
  if (has('move', 'flicker')) {
    notes.push({
      key: 'q',
      text: (
        <>
          Criteria use the card search syntax, matched against this deck: <code>t:basic</code>, <code>t:creature mv&lt;=3</code>,{' '}
          <code>o:"draw a card"</code>. Leave it empty for any card. <code>set:</code> and <code>is:foil</code> are about a
          printing, so they never match here. The battlefield holds every permanent you control now, creatures included, so a
          sacrifice can go and find one; how a card lands there is the picker beside the zones.
        </>
      ),
    });
  }
  if (has('mana')) {
    notes.push({
      key: 'mana',
      text: '"Add X mana" is your mana pool, not a permanent: the mana is there for the rest of the turn you make it and gone at the end of it, spent or not. A Treasure is the same mana with a keep attached, so use this for the mana that vanishes, like a landfall trigger or a ritual, and the Treasure step for the mana that waits.',
    });
  }
  if (has('flicker')) {
    notes.push({
      key: 'flicker',
      text: 'A flicker takes permanents off the battlefield and puts them straight back, which fires everything they do on the way in. What it costs is what they were already doing: the mana arrives tapped again, and a creature is summoning sick again, so it cannot attack this turn. A token that leaves does not come back.',
    });
  }
  if (rule.steps.some((s) => (s.op === 'move' || s.op === 'self') && (s.to ?? '').startsWith('library'))) {
    notes.push({
      key: 'library',
      text: 'Into the library on its own means a random spot, which is what shuffling a card back in comes to. Top and bottom go where they say. Send more than one card to either and they arrive in a random order, because nothing decided which went first. Only the library is ever searched from the top down, so it is also the only zone you can take cards out of.',
    });
  }
  if (has('self')) {
    notes.push({
      key: 'self',
      text: '"Put this card into a zone" is the card talking about itself, and it happens instead of where the card would otherwise go: a spell that exiles itself rather than hitting the graveyard, or one that shuffles back into the library. On a permanent it also takes the card off the battlefield, so anything it was doing there stops. A commander goes back to the command zone instead, and costs two more each time.',
    });
  }
  if (has('token')) {
    notes.push({
      key: 'token',
      text: 'Tokens are permanents like any other: they count as creatures, wake "enters" rules, and attack when combat says so, from the turn after they arrive unless they have haste. A Treasure pays for something and is sacrificed; a Food or a Clue sits there, since eating or cracking one is not modelled yet. A token that leaves the battlefield is gone.',
    });
  }
  if (has('counter')) {
    notes.push({
      key: 'counter',
      text: 'The counters go on this card, the copy that just arrived if there are two. +1/+1 counters add to its power; any other kind is only counted, which is what "the counters on it" reads, so an Everflowing Chalice is an entry rule putting "the times it was kicked" charge counters on it and a mana rule tapping for that many.',
    });
  }
  if (has('pump', 'keyword')) {
    notes.push({
      key: 'pump',
      text:
        kind === 'static'
          ? 'For as long as this card is out, every creature the criteria above finds gets it, the ones that arrive later included. The amount is read again whenever the battlefield changes.'
          : 'Until end of turn, for the creatures on the battlefield now: a Craterhoof\'s +X/+X, read once as it resolves. Combat comes after the turn\'s spells, so a pump in a play or entry rule is in time for the attack.',
    });
  }
  if (has('addtype')) {
    notes.push({
      key: 'addtype',
      text: 'The permanents the criteria finds are that type as well, for everything that asks: t:land in another rule, "lands you control", landfall. The criteria reads what cards are printed as, so a rule cannot feed on the type it adds. A basic land type is a mana ability: a creature made a Forest taps for {G} from the next turn.',
    });
  }
  if (has('extramana')) {
    notes.push({
      key: 'extramana',
      text: 'Each permanent the criteria finds adds this much more, in these colors, whenever it taps for mana. Badgermole Cub is t:creature, 1, green.',
    });
  }
  if (has('landfrom')) {
    notes.push({
      key: 'landfrom',
      text: 'Your land drop can come from there as well as from your hand, and does when it is as good: a land you play from the graveyard or the library is one your hand keeps. A fetch played from the graveyard goes back there when it cracks, so Ramunap Excavator plays it again next turn.',
    });
  }
  if (has('tapsfor')) {
    notes.push({
      key: 'tapsfor',
      text: 'This replaces the mana ability the card database read, and makes the card a mana source if it was not one. The amount is read every turn the pool is built, so it can count the charge counters on it or your creatures (Gaea\'s Cradle). A creature is summoning sick the turn it arrives, and one that taps for mana does not attack that turn.',
    });
  }
  if (amounts.some((x) => x.kind === 'prev')) {
    notes.push({
      key: 'prev',
      text: '"The previous X" is what the step before it actually reached, not what it asked for. That is what makes a Windfall writable: discard X where X is your hand, then draw the previous X. A step that found less than it wanted hands on the smaller number, and the first step of a rule has nothing before it, so it reads zero.',
    });
  }
  if (amounts.some((x) => x.kind === 'matching')) {
    notes.push({
      key: 'matching',
      text: '"Your permanents matching" counts what you control right now against the criteria under it: t:elf is Distant Melody. Empty counts every permanent, tokens and lands included.',
    });
  }
  if (amounts.some((x) => !!x.op)) {
    notes.push({
      key: 'op',
      text: (
        <>
          <code>÷</code> rounds down and <code>÷↑</code> rounds up, because the cards print both. Nothing is capped: half a
          99-card library really is 49 cards, and a step stops only when the zone it is working on runs out.
        </>
      ),
    });
  }
  if (rule.steps.some((s) => s.op === 'move' && queryHasX(s.q))) {
    notes.push({
      key: 'x',
      text: (
        <>
          <code>[X]</code> is the one thing here the card search does not know. Write it anywhere a number goes, say what it is
          worth below, and <code>mv&lt;=[X]</code> becomes <code>mv&lt;=5</code> as the rule resolves. <code>[X-1]</code> and{' '}
          <code>[X+2]</code> work too; nothing fancier does, and nothing goes below zero. This one <em>is</em> capped, at{' '}
          {MAX_QUERY_X}: the query is compiled once per value of X before the game starts, so the range has to be a short one.
        </>
      ),
    });
  }
  if (notes.length === 0) return null;
  return (
    <HowWorked label="How these steps work">
      {notes.map((n) => (
        <p key={n.key} className="fine-print">
          {n.text}
        </p>
      ))}
    </HowWorked>
  );
}

/**
 * Other ways to cast the card (rebuild plan F5): a price and a zone rather than
 * something the card does, so they sit under the rules instead of among them.
 * The rules still run whichever way it was cast.
 */
function CastOptionsEditor({
  options,
  onChange,
  permanent,
}: {
  options: CastOption[];
  onChange: (next: CastOption[]) => void;
  permanent: boolean;
}) {
  const used = new Set(options.map((o) => o.kind));
  // Flashback, retrace and mayhem cast a spell again; a permanent cast from the
  // graveyard stays out, which only escape prints.
  const offered = CAST_OPTIONS.filter((o) => !permanent || !o.graveyard || o.id === 'escape');
  const set = (i: number, next: CastOption) => onChange(options.map((o, k) => (k === i ? next : o)));
  const add = () => {
    const kind = offered.find((o) => !used.has(o.id));
    if (kind) onChange([...options, { kind: kind.id, ...(kind.hasCost ? { cost: '' } : {}), ...(kind.n ? { n: kind.id === 'suspend' ? 4 : 3 } : {}) }]);
  };
  return (
    <>
      {options.length > 0 && <h4 className="deck-stats-head">Other ways to cast it</h4>}
      {options.map((o, i) => {
        const info = CAST_OPTIONS.find((c) => c.id === o.kind)!;
        const bad = info.hasCost && !normalizeCost(o.cost);
        return (
          <div className="behavior-rule behavior-cast" key={i}>
            <div className="behavior-rule-head">
              <label className="field behavior-trigger">
                <select
                  value={o.kind}
                  aria-label="How it is cast"
                  onChange={(e) => {
                    const next = CAST_OPTIONS.find((c) => c.id === e.target.value)!;
                    set(i, {
                      kind: next.id as CastOptionKind,
                      ...(next.hasCost ? { cost: o.cost ?? '' } : {}),
                      ...(next.n ? { n: o.n ?? (next.id === 'suspend' ? 4 : 3) } : {}),
                    });
                  }}
                >
                  {offered
                    .filter((c) => c.id === o.kind || !used.has(c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="behavior-drop"
                onClick={() => onChange(options.filter((_o, k) => k !== i))}
                aria-label="Remove this way to cast it"
              >
                <Icon name="trash" />
              </button>
            </div>
            <p className="fine-print">{info.hint}</p>
            {(info.hasCost || info.n) && (
              <div className="behavior-zones">
                {info.hasCost && (
                  <label className="field">
                    <input
                      type="text"
                      value={o.cost ?? ''}
                      maxLength={40}
                      aria-label="Its cost"
                      placeholder="Cost, like {2}{U}"
                      onChange={(e) => set(i, { ...o, cost: e.target.value })}
                    />
                  </label>
                )}
                {info.n && (
                  <label className="field behavior-n behavior-cast-n">
                    <input
                      type="number"
                      min={info.id === 'suspend' ? 1 : 0}
                      max={MAX_CAST_N}
                      inputMode="numeric"
                      aria-label={info.n}
                      value={o.n ?? 1}
                      onChange={(e) => set(i, { ...o, n: Math.max(0, Math.min(MAX_CAST_N, Math.round(Number(e.target.value) || 0))) })}
                    />
                  </label>
                )}
                {info.n && <span className="fine-print">{info.n}</span>}
              </div>
            )}
            {bad && <p className="fine-print behavior-nomatch">Write the cost in mana symbols, like {'{2}{U}'} or {'{0}'}. It is not saved until it reads as one.</p>}
          </div>
        );
      })}
      {options.length < MAX_CAST_OPTIONS && offered.some((o) => !used.has(o.id)) && (
        <button type="button" className="behavior-add" onClick={add}>
          <Icon name="plus" />
          <span>Cast it another way</span>
        </button>
      )}
    </>
  );
}
