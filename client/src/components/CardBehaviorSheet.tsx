import { useMemo, useState } from 'react';
import {
  BEHAVIOR_AMOUNTS,
  BEHAVIOR_AMOUNT_OPS,
  BEHAVIOR_FROM_ZONES,
  BEHAVIOR_STEPS,
  BEHAVIOR_TRIGGERS,
  BEHAVIOR_ZONES,
  CARD_BEHAVIOR_VERSION,
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
  describeFetch,
  describeLandRamp,
  describeRule,
  queryHasX,
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
import { Sheet } from './Sheet.js';
import { Icon } from './icons.js';
import { setCardBehavior } from '../db/dataAccess.js';
import { compileCardQuery, toSearchableEntry, type SearchableEntry } from '../cardDb/querySyntax.js';
import type { GroupRow } from '../analysis/groups.js';

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
function behaviorCards(rows: readonly GroupRow[], behaviors: ReadonlyMap<string, CardBehavior>): BehaviorCard[] {
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
      authored: behaviors.get(o.oracleId) ?? null,
      image: o.imageNormal ?? o.imageSmall ?? null,
      permanent: isPermanent(o.typeLine),
      creature: isCreature(o.typeLine),
    });
  }
  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The line under a card's name in the list. */
function summaryOf(card: BehaviorCard): string {
  const lines = describeBehavior(card.authored ?? behaviorFromEffect(card.derived));
  if (lines.length > 0) return lines.join('. ');
  // A Harrow used to read "Do nothing" here while the simulator was ramping off
  // it, which is exactly the card somebody then writes out by hand.
  if (card.ramp) return `${PLAY_LEAD}: ${card.ramp}`;
  if (card.fetch) return `${PLAY_LEAD}: ${card.fetch}`;
  return 'Do nothing';
}

/** How many of the deck's distinct cards a move step's criteria would find. */
export interface DeckMatcher {
  total: number;
  /** A range rather than a number, because a `[X]` query has one answer per X. */
  count: (q: string) => { min: number; max: number; varies: boolean };
}

export function CardBehaviorSheet({
  deckId,
  deckName,
  rows,
  behaviors,
  onClose,
}: {
  deckId: string;
  deckName: string;
  rows: readonly GroupRow[];
  behaviors: ReadonlyMap<string, CardBehavior>;
  onClose: () => void;
}) {
  const cards = useMemo(() => behaviorCards(rows, behaviors), [rows, behaviors]);
  const [openId, setOpenId] = useState<string | null>(null);
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

  return (
    <Sheet
      onClose={onClose}
      title={open ? open.name : `Card behavior: ${deckName}`}
      className="behavior-sheet"
    >
      {open ? (
        <BehaviorEditor
          key={open.oracleId}
          deckId={deckId}
          card={open}
          matcher={matcher}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <BehaviorList cards={cards} onOpen={setOpenId} />
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Three sections rather than one alphabetical run. Your own work first because
 * it is the thing you came back to change, then the cards that do nothing
 * because they are the whole reason this screen exists, then everything the
 * card database already reads, which needs no attention and should not be in
 * the way of the two that do.
 */
function BehaviorList({ cards, onOpen }: { cards: BehaviorCard[]; onOpen: (oracleId: string) => void }) {
  const authored = cards.filter((c) => c.authored);
  const blank = cards.filter((c) => !c.authored && !c.derived && !c.ramp);
  const read = cards.filter((c) => !c.authored && (c.derived || c.ramp));

  if (cards.length === 0) {
    return <p className="fine-print">Nothing in the mainboard yet.</p>;
  }

  return (
    <>
      <p className="fine-print">
        The card database reads oracle text conservatively: only what a card does unconditionally, on resolution, to you. Anything
        behind a trigger or an "if" reaches the simulator as a blank. Tell it what a card really does and it plays it out. A
        behavior covers your hand, library, graveyard and exile, and can move cards between them with the same search syntax the
        card search uses. Your rules replace what the database read the card as <em>doing</em>; what the card <em>is</em> stays, so
        lands still make their mana whatever it says here.
      </p>
      <Section title={`Your own (${authored.length})`} cards={authored} onOpen={onOpen} />
      <Section title={`Nothing read yet (${blank.length})`} cards={blank} onOpen={onOpen} />
      <Section title={`Read from the card (${read.length})`} cards={read} onOpen={onOpen} />
      <p className="fine-print">
        Authored cards play out exactly as written, which means the trajectory curves stop being a pure floor for this deck. The
        coverage line under the charts says how many, so the number stays honest either way.
      </p>
    </>
  );
}

function Section({ title, cards, onOpen }: { title: string; cards: BehaviorCard[]; onOpen: (oracleId: string) => void }) {
  if (cards.length === 0) return null;
  return (
    <>
      <h4 className="deck-stats-head">{title}</h4>
      <ul className="behavior-list">
        {cards.map((card) => (
          <li key={card.oracleId}>
            <button type="button" className="behavior-row" onClick={() => onOpen(card.oracleId)}>
              <span className="behavior-row-text">
                <span className="behavior-row-name">
                  {card.copies > 1 && <span className="behavior-row-qty">{card.copies}×</span>}
                  {card.name}
                </span>
                <span className="behavior-row-what">{summaryOf(card)}</span>
              </span>
              {card.authored && <span className="behavior-tag">yours</span>}
              <Icon name="chevronRight" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const emptyStep = () => ({ op: 'draw' as BehaviorStepKind, x: { kind: 'fixed' as BehaviorAmountKind, n: 1 } });

function BehaviorEditor({
  deckId,
  card,
  matcher,
  onBack,
}: {
  deckId: string;
  card: BehaviorCard;
  matcher: DeckMatcher;
  onBack: () => void;
}) {
  // The draft opens on whatever is true now: your rules if you wrote some,
  // otherwise the card database's reading in the same grammar. Editing what we
  // read and writing your own are deliberately the same gesture — which is also
  // why saving *replaces* the derived reading rather than adding to it.
  const start = card.authored ?? behaviorFromEffect(card.derived);
  const [rules, setRules] = useState<BehaviorRule[]>(() => (start ? start.rules.map((r) => ({ ...r, steps: [...r.steps] })) : []));
  const [saving, setSaving] = useState(false);

  const edit = (i: number, next: BehaviorRule) => setRules(rules.map((r, k) => (k === i ? next : r)));

  const save = async () => {
    setSaving(true);
    const kept = rules.filter((r) => r.steps.length > 0);
    await setCardBehavior(deckId, card.oracleId, kept.length > 0 ? { v: CARD_BEHAVIOR_VERSION, rules: kept } : null);
    onBack();
  };

  const reset = async () => {
    setSaving(true);
    await setCardBehavior(deckId, card.oracleId, null);
    onBack();
  };

  const preview = rules.filter((r) => r.steps.length > 0);

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

      {card.derived && !card.authored && (
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
          The card database already reads this one as land ramp: <em>{card.ramp}</em>. It does not say <em>which</em> land, so the
          simulator takes whichever one best fixes your colours. Write your own rule and it replaces that reading, so put the ramp
          in as a step if you want it. What the card <em>is</em> stays either way: a land still makes its mana, a rock still taps
          for it, and an extra land drop is still an extra land drop.
        </p>
      )}
      {card.fetch && (
        <p className="fine-print">
          The card database already reads this one as a fetchland: <em>{card.fetch}</em>. It does not say <em>which</em> land, so
          the simulator takes whichever one best fixes your colours. Write your own rule and it replaces that search, so put it in
          as a step if you want it. Until this release a rule written here never fired at all.
        </p>
      )}
      {!card.derived && !card.ramp && !card.fetch && !card.authored && (
        <p className="fine-print">
          The card database reads nothing unconditional off this one, so it currently resolves as a blank. Add a rule and it stops
          being one.
        </p>
      )}

      {rules.map((rule, i) => (
        <RuleEditor
          key={i}
          rule={rule}
          matcher={matcher}
          hasX={card.hasX}
          permanent={card.permanent}
          creature={card.creature}
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

      <h4 className="deck-stats-head">Plays out as</h4>
      {/* With no rules of your own, what plays out is whatever the database
          read — which for a ramp spell is not nothing, and saying "blank" here
          is what sends someone off to write a rule the card already had. */}
      <p className="deck-stats-verdict">
        {preview.length > 0
          ? preview.map(describeRule).join('. ')
          : card.ramp || card.fetch
            ? `${PLAY_LEAD}: ${card.ramp ?? card.fetch}, read from the card`
            : 'Nothing. This card resolves as a blank.'}
      </p>

      <div className="sheet-actions">
        {card.authored && (
          <button type="button" onClick={() => void reset()} disabled={saving}>
            Back to the database
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
}: {
  value: BehaviorAmount;
  label: string;
  /** Which of the catalog's amounts make sense here. */
  offer: (o: (typeof BEHAVIOR_AMOUNTS)[number]) => boolean;
  onChange: (next: BehaviorAmount) => void;
}) {
  const adjustable = !BEHAVIOR_AMOUNTS.find((o) => o.id === value.kind)?.noAdjust;
  return (
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
              onChange(op ? { kind: value.kind, op, by: value.by ?? 1 } : { kind: value.kind });
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

function RuleEditor({
  rule,
  matcher,
  hasX,
  permanent,
  creature,
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
  onChange: (next: BehaviorRule) => void;
  onRemove: () => void;
}) {
  const setStep = (i: number, next: BehaviorRule['steps'][number]) =>
    onChange({ ...rule, steps: rule.steps.map((s, k) => (k === i ? next : s)) });
  const trigger = BEHAVIOR_TRIGGERS.find((t) => t.id === rule.on);
  // A trigger the card cannot have is hidden, unless the rule is already on it:
  // a type line read one way today and another way tomorrow must not silently
  // orphan a rule somebody wrote.
  const triggers = BEHAVIOR_TRIGGERS.filter(
    (t) => !t.needs || rule.on === t.id || (t.needs === 'creature' ? creature : permanent),
  );
  /** "The mana you spent on X" is a number only while the cast is resolving. */
  const xAvailable = hasX && rule.on === 'play';

  /**
   * Moving a rule off `play` takes its X with it, so any amount reading one
   * becomes a fixed zero rather than a select with nothing selected in it.
   */
  const changeTrigger = (on: BehaviorTrigger) => {
    // The criteria belongs to the moment, not to the rule: move off a watched
    // trigger and there is nothing for it to narrow, so it goes rather than
    // sitting in the row invisibly and coming back on the way past.
    const q = BEHAVIOR_TRIGGERS.find((t) => t.id === on)?.watches ? rule.q : undefined;
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
    if (op === 'flicker') {
      // The criteria and any `[X]` in it carry over from a move; the zones do
      // not, because a flicker does not have any.
      const { from: _from, to: _to, ...rest } = step;
      setStep(i, { ...rest, op });
      return;
    }
    if (op === 'move') {
      const from = step.from && BEHAVIOR_FROM_ZONES.some((z) => z.id === step.from) ? step.from : 'library';
      setStep(i, { ...step, op, from, to: step.to === from ? 'hand' : (step.to ?? 'hand') });
      return;
    }
    if (op === 'self') {
      // One card, no criteria, and the amount is not a choice — see the step's
      // own note below. Exile is the default because self-exile is the case
      // this exists for.
      setStep(i, { op, x: { kind: 'fixed', n: 1 }, to: step.to ?? 'exile' });
      return;
    }
    setStep(i, { op, x: step.x.kind === 'all' ? { kind: 'fixed', n: 1 } : step.x });
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
    setStep(i, { ...step, to: zone, from });
  };

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
          the steps say what. Landfall is one word in a box. */}
      {trigger?.watches && (
        <div className="behavior-q behavior-watch">
          <label className="field">
            <input
              type="text"
              value={rule.q ?? ''}
              maxLength={MAX_BEHAVIOR_QUERY}
              aria-label="Which cards wake this"
              placeholder={rule.on === 'cast' ? 'Any spell, or t:instant or t:sorcery, …' : 'Any permanent, or t:land, t:creature, …'}
              onChange={(e) => onChange({ ...rule, q: e.target.value })}
            />
          </label>
          <MatchNote q={rule.q ?? ''} matcher={matcher} />
          {/* The examples live in the trigger's hint, right above this. What is
              left is what that hint does not say: where the syntax comes from,
              what blank means, and where the chain stops. */}
          <p className="fine-print">
            Card search syntax, matched against this deck, same as a move step's. Blank means anything wakes it. Triggers chain
            two deep, so an engine that feeds itself stops rather than spinning.
          </p>
        </div>
      )}

      {rule.steps.map((step, i) => {
        const move = step.op === 'move';
        const flicker = step.op === 'flicker';
        const self = step.op === 'self';
        // Both of them narrow what they reach with a criteria box; only a move
        // has two zones to pick.
        const narrows = move || flicker;
        return (
          <div className={`behavior-step${narrows ? ' behavior-step-move' : ''}${self ? ' behavior-step-self' : ''}`} key={i}>
            {/* The verb on its own line and the number under it: three controls
                abreast on a 393px phone truncates every one of them, and "X = cards
                in your h" is not a choice anybody can make. */}
            <label className="field behavior-op">
              <select value={step.op} aria-label="What happens" onChange={(e) => changeOp(i, step, e.target.value as BehaviorStepKind)}>
                {BEHAVIOR_STEPS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {/* A `self` step moves one card and that card is this one, so an
                amount picker on it would be a control with a single setting. */}
            {!self && (
              <AmountPicker
                value={step.x}
                label="Where X comes from"
                offer={(o) => (narrows || !o.moveOnly) && (!o.needsX || xAvailable) && (!o.needsPrev || i > 0)}
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
              </div>
            )}
            {narrows && (
              <div className="behavior-q">
                <label className="field">
                  <input
                    type="text"
                    value={step.q ?? ''}
                    maxLength={MAX_BEHAVIOR_QUERY}
                    aria-label="Which cards"
                    placeholder={flicker ? 'Any permanent, or t:creature, …' : 'Any card, or t:basic, t:creature mv<=3, …'}
                    onChange={(e) => setStep(i, { ...step, q: e.target.value })}
                  />
                </label>
                <MatchNote q={step.q ?? ''} matcher={matcher} />
                {/* The control appears because the query asked for it. No
                    placeholder, no dropdown, and nothing to explain away. */}
                {queryHasX(step.q) && (
                  <>
                    <span className="fine-print behavior-plug-lead">[X] in that query is:</span>
                    <AmountPicker
                      value={step.qx ?? { kind: 'fixed', n: 0 }}
                      label="What [X] in the criteria is worth"
                      offer={(o) => !o.moveOnly && (!o.needsX || xAvailable) && (!o.needsPrev || i > 0)}
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

      {rule.steps.some((s) => s.op === 'move' || s.op === 'flicker') && (
        <p className="fine-print">
          Criteria use the card search syntax, matched against this deck: <code>t:basic</code>, <code>t:creature mv&lt;=3</code>,{' '}
          <code>o:"draw a card"</code>. Leave it blank for any card. <code>set:</code> and <code>is:foil</code> are about a
          printing, so they never match here. The battlefield holds every permanent you control now, creatures included, so a
          sacrifice can go and find one; anything moved onto it arrives tapped.
        </p>
      )}
      {rule.steps.some((s) => s.op === 'flicker') && (
        <p className="fine-print">
          A flicker takes permanents off the battlefield and puts them straight back, which fires everything they do on the way
          in. What it costs is what they were already doing: the mana arrives tapped again, and a creature is summoning sick
          again, so it cannot attack this turn.
        </p>
      )}
      {rule.steps.some((s) => (s.op === 'move' || s.op === 'self') && (s.to ?? '').startsWith('library')) && (
        <p className="fine-print">
          Into the library on its own means a random spot, which is what shuffling a card back in comes to. Top and bottom go
          where they say. Send more than one card to either and they arrive in a random order, because nothing decided which went
          first. Only the library is ever searched from the top down, so it is also the only zone you can take cards out of.
        </p>
      )}
      {rule.steps.some((s) => s.op === 'self') && (
        <p className="fine-print">
          "Put this card into a zone" is the card talking about itself, and it happens instead of where the card would otherwise
          go: a spell that exiles itself rather than hitting the graveyard, or one that shuffles back into the library. On a
          permanent it also takes the card off the battlefield, so anything it was doing there stops.
        </p>
      )}
      {rule.steps.some((s) => s.x.kind === 'prev' || s.qx?.kind === 'prev') && (
        <p className="fine-print">
          "The previous X" is what the step before it actually reached, not what it asked for. That is what makes a Windfall
          writable: discard X where X is your hand, then draw the previous X. A step that found less than it wanted hands on the
          smaller number, and the first step of a rule has nothing before it, so it reads zero.
        </p>
      )}
      {rule.steps.some((s) => !!s.x.op || !!s.qx?.op) && (
        <p className="fine-print">
          <code>÷</code> rounds down and <code>÷↑</code> rounds up, because the cards print both. Nothing is capped: half a
          99-card library really is 49 cards, and a step stops only when the zone it is working on runs out.
        </p>
      )}
      {rule.steps.some((s) => s.op === 'move' && queryHasX(s.q)) && (
        <p className="fine-print">
          <code>[X]</code> is the one thing here the card search does not know. Write it anywhere a number goes, say what it is
          worth below, and <code>mv&lt;=[X]</code> becomes <code>mv&lt;=5</code> as the rule resolves. <code>[X-1]</code> and{' '}
          <code>[X+2]</code> work too; nothing fancier does, and nothing goes below zero. This one <em>is</em> capped, at{' '}
          {MAX_QUERY_X}: the query is compiled once per value of X before the game starts, so the range has to be a short one.
        </p>
      )}

      {rule.steps.length < MAX_BEHAVIOR_STEPS && (
        <button
          type="button"
          className="behavior-add"
          onClick={() => onChange({ ...rule, steps: [...rule.steps, emptyStep()] })}
        >
          <Icon name="plus" />
          <span>Then…</span>
        </button>
      )}
    </div>
  );
}
