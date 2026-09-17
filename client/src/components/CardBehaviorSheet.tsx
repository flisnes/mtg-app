import { useMemo, useState } from 'react';
import {
  BEHAVIOR_AMOUNTS,
  BEHAVIOR_STEPS,
  BEHAVIOR_TRIGGERS,
  CARD_BEHAVIOR_VERSION,
  MAX_BEHAVIOR_AMOUNT,
  MAX_BEHAVIOR_RULES,
  MAX_BEHAVIOR_STEPS,
  behaviorFromEffect,
  decodeEffectProfile,
  describeBehavior,
  describeRule,
  type BehaviorAmountKind,
  type BehaviorRule,
  type BehaviorStepKind,
  type BehaviorTrigger,
  type CardBehavior,
  type EffectProfile,
} from '@mtg/shared';
import { Sheet } from './Sheet.js';
import { Icon } from './icons.js';
import { setCardBehavior } from '../db/dataAccess.js';
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
  /** What the card database reads, or null when it reads nothing. */
  derived: EffectProfile | null;
  /** What the user said, or null when they have not said anything. */
  authored: CardBehavior | null;
}

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
      derived: decodeEffectProfile(o.effect),
      authored: behaviors.get(o.oracleId) ?? null,
    });
  }
  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The line under a card's name in the list. */
function summaryOf(card: BehaviorCard): string {
  const lines = describeBehavior(card.authored ?? behaviorFromEffect(card.derived));
  return lines.length > 0 ? lines.join('. ') : 'Do nothing';
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

  return (
    <Sheet
      onClose={onClose}
      title={open ? open.name : `Card behavior: ${deckName}`}
      className="behavior-sheet"
    >
      {open ? (
        <BehaviorEditor key={open.oracleId} deckId={deckId} card={open} onBack={() => setOpenId(null)} />
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
  const blank = cards.filter((c) => !c.authored && !c.derived);
  const read = cards.filter((c) => !c.authored && c.derived);

  if (cards.length === 0) {
    return <p className="fine-print">Nothing in the mainboard yet.</p>;
  }

  return (
    <>
      <p className="fine-print">
        The card database reads oracle text conservatively: only what a card does unconditionally, on resolution, to you. Anything
        behind a trigger or an "if" reaches the simulator as a blank. Tell it what a card really does and it plays it out. A
        behavior covers your hand, library and graveyard; lands still make their mana whatever it says here.
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

function BehaviorEditor({ deckId, card, onBack }: { deckId: string; card: BehaviorCard; onBack: () => void }) {
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

      {card.derived && !card.authored && (
        <p className="fine-print">
          Read off this card's oracle text. Change anything below and it becomes yours instead.
          {card.derived.unknown && ' One of these amounts is a floor we could not read exactly.'}
          {card.derived.tutor && ' The database calls this a tutor; the simulator resolves one as a draw off the top either way.'}
        </p>
      )}
      {!card.derived && !card.authored && (
        <p className="fine-print">
          The card database reads nothing unconditional off this one, so it currently resolves as a blank. Add a rule and it stops
          being one.
        </p>
      )}

      {rules.map((rule, i) => (
        <RuleEditor
          key={i}
          rule={rule}
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
      <p className="deck-stats-verdict">
        {preview.length > 0 ? preview.map(describeRule).join('. ') : 'Nothing. This card resolves as a blank.'}
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

function RuleEditor({
  rule,
  onChange,
  onRemove,
}: {
  rule: BehaviorRule;
  onChange: (next: BehaviorRule) => void;
  onRemove: () => void;
}) {
  const setStep = (i: number, next: BehaviorRule['steps'][number]) =>
    onChange({ ...rule, steps: rule.steps.map((s, k) => (k === i ? next : s)) });
  const trigger = BEHAVIOR_TRIGGERS.find((t) => t.id === rule.on);

  return (
    <div className="behavior-rule">
      <div className="behavior-rule-head">
        <div className="seg-row" role="radiogroup" aria-label="When this happens">
          {BEHAVIOR_TRIGGERS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`seg${rule.on === t.id ? ' seg-active' : ''}`}
              role="radio"
              aria-checked={rule.on === t.id}
              onClick={() => onChange({ ...rule, on: t.id as BehaviorTrigger })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="behavior-drop" onClick={onRemove} aria-label="Remove this trigger">
          <Icon name="trash" />
        </button>
      </div>
      {trigger && <p className="fine-print">{trigger.hint}</p>}

      {rule.steps.map((step, i) => (
        <div className="behavior-step" key={i}>
          {/* The verb on its own line and the number under it: three controls
              abreast on a 393px phone truncates every one of them, and "X = cards
              in your h" is not a choice anybody can make. */}
          <label className="field behavior-op">
            <select
              value={step.op}
              aria-label="What happens"
              onChange={(e) => setStep(i, { ...step, op: e.target.value as BehaviorStepKind })}
            >
              {BEHAVIOR_STEPS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="behavior-x">
            <label className="field">
              <select
                value={step.x.kind}
                aria-label="Where X comes from"
                onChange={(e) => {
                  const kind = e.target.value as BehaviorAmountKind;
                  setStep(i, { ...step, x: kind === 'fixed' ? { kind, n: step.x.n ?? 1 } : { kind } });
                }}
              >
                {BEHAVIOR_AMOUNTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    X = {o.label}
                  </option>
                ))}
              </select>
            </label>
            {step.x.kind === 'fixed' && (
              <label className="field behavior-n">
                <input
                  type="number"
                  min={0}
                  max={MAX_BEHAVIOR_AMOUNT}
                  inputMode="numeric"
                  aria-label="How many"
                  value={step.x.n ?? 0}
                  onChange={(e) => {
                    const n = Math.max(0, Math.min(MAX_BEHAVIOR_AMOUNT, Math.round(Number(e.target.value) || 0)));
                    setStep(i, { ...step, x: { kind: 'fixed', n } });
                  }}
                />
              </label>
            )}
          </div>
          <button
            type="button"
            className="behavior-drop"
            onClick={() => onChange({ ...rule, steps: rule.steps.filter((_s, k) => k !== i) })}
            aria-label="Remove this step"
          >
            <Icon name="close" />
          </button>
        </div>
      ))}

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
