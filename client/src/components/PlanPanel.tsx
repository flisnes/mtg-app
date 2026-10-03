import { useState } from 'react';
import {
  DEFAULT_GAMES,
  GOAL_PRESETS,
  GOAL_TERMS,
  MAX_GOAL_QUERY,
  MAX_GOAL_TERM_N,
  MAX_GOAL_TERMS,
  MAX_GOALS,
  describeGoal,
  halfWidth,
  newGoalId,
  type GoalPreset,
  type GoalTerm,
  type GoalTermKind,
  type SimGoal,
  type SimResult,
} from '@mtg/sim';
import { HowWorked } from './HowWorked.js';
import { Step } from './MulliganPanel.js';

// The Plan tab (rebuild plan E1): the deck's game plan as goals, each a
// sentence ("four lands and a creature on the battlefield by turn 4") and a
// number (how often the simulated games get there). A goal is a conjunction,
// which is the one question the exact panels cannot answer and the simulator
// answers for free: every game is a yes or a no.
//
// The goals also steer the game: a search in a card rule goes for the first
// piece the plan is missing (E2), so writing the plan down changes what the
// tutors fetch.

const pct = (p: number) => `${Math.round(p * 100)}%`;
const plural = (n: number) => (n === 1 ? '' : 's');

/** Below this at its turn, a goal reads as a problem rather than a plan. */
const SHAKY = 0.5;

export function PlanPanel({
  goals,
  onGoals,
  result,
  games,
  maxTurn,
  hasManaData,
  commander,
}: {
  goals: readonly SimGoal[];
  onGoals: (goals: SimGoal[]) => void;
  result: SimResult | undefined;
  games: number;
  maxTurn: number;
  hasManaData: boolean;
  /** The deck has a commander, so the commander presets make sense. */
  commander: boolean;
}) {
  // The goal being written, or null. A new one starts from a preset or blank.
  const [draft, setDraft] = useState<SimGoal | null>(null);
  const byId = new Map((result?.goals ?? []).map((g) => [g.id, g]));
  const presets = GOAL_PRESETS.filter((p) => commander || !p.terms.some((t) => t.kind === 'commander'));

  const save = (goal: SimGoal) => {
    const cleaned: SimGoal = { ...goal, terms: goal.terms.map((t) => (t.q?.trim() ? { ...t, q: t.q.trim() } : { kind: t.kind, n: t.n })) };
    const at = goals.findIndex((g) => g.id === goal.id);
    onGoals(at < 0 ? [...goals, cleaned] : goals.map((g, i) => (i === at ? cleaned : g)));
    setDraft(null);
  };
  const remove = (id: string) => onGoals(goals.filter((g) => g.id !== id));
  const startFrom = (p: GoalPreset) => setDraft({ id: newGoalId(), turn: Math.min(p.turn, maxTurn), terms: p.terms.map((t) => ({ ...t })) });

  const worst = goals.length > 0 && result ? Math.min(...goals.map((g) => byId.get(g.id)?.p ?? 0)) : null;

  return (
    <>
      <h3 className="deck-stats-head">Game plan</h3>
      {goals.length === 0 ? (
        <p className="deck-stats-verdict">
          <strong>No goals yet.</strong> Say what the deck wants to have done by a turn, and the simulator counts how often its games get
          there. Start from one below or write your own.
        </p>
      ) : !hasManaData ? (
        <p className="fine-print">Your card database predates this data. Refresh it from About to see how the plan plays out.</p>
      ) : !result ? (
        <p className="deck-stats-verdict sim-waiting">Dealing {games.toLocaleString()} games…</p>
      ) : (
        <p className={`deck-stats-verdict ${worst !== null && worst < SHAKY ? 'tone-warn' : 'tone-ok'}`}>
          <strong>
            {goals.length === 1
              ? `${pct(byId.get(goals[0]!.id)?.p ?? 0)} of games get there.`
              : `${goals.length} goals; the shakiest gets there in ${pct(worst ?? 0)} of games.`}
          </strong>{' '}
          Read at the end of each turn, every part at once. Searches in your card rules go for what the plan is missing first.
        </p>
      )}

      {goals.length > 0 && (
        <ul className="plan-goals">
          {goals.map((g) => {
            const r = byId.get(g.id);
            const p = r?.p;
            return (
              <li key={g.id} className="plan-goal">
                {draft?.id === g.id ? (
                  <GoalEditor draft={draft} maxTurn={maxTurn} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
                ) : (
                  <>
                    <div className="plan-goal-head">
                      <span className="plan-goal-text">{describeGoal(g)}</span>
                      <strong className={`plan-pct ${p === undefined ? '' : p < SHAKY ? 'tone-warn' : 'tone-ok'}`}>{p === undefined ? '…' : pct(p)}</strong>
                    </div>
                    {r && <ByTurn byTurn={r.byTurn} turn={g.turn} maxTurn={maxTurn} />}
                    {r && result && result.games < DEFAULT_GAMES && (
                      <p className="fine-print">
                        ±{Math.round(halfWidth(r.p, result.games) * 100)} points on {result.games.toLocaleString()} games so far.
                      </p>
                    )}
                    <div className="plan-actions">
                      <button type="button" className="linklike" onClick={() => setDraft({ ...g, terms: g.terms.map((t) => ({ ...t })) })}>
                        Edit
                      </button>
                      <button type="button" className="linklike" onClick={() => remove(g.id)}>
                        Remove
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {draft && !goals.some((g) => g.id === draft.id) && (
        <div className="plan-goal plan-goal-new">
          <GoalEditor draft={draft} maxTurn={maxTurn} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
        </div>
      )}

      {!draft && goals.length < MAX_GOALS && (
        <>
          <h4 className="source-live-head">Add a goal</h4>
          <div className="odds-presets">
            {presets.map((p) => (
              <button key={p.label} type="button" className="odds-chip" onClick={() => startFrom(p)}>
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className="odds-chip"
              onClick={() => setDraft({ id: newGoalId(), turn: Math.min(4, maxTurn), terms: [{ kind: 'inPlay', n: 1, q: '' }] })}
            >
              Write your own…
            </button>
          </div>
        </>
      )}

      <HowWorked>
        <p className="fine-print">
          A goal holds in a game when every part of it is true at the end of the same turn, on or before the turn you named. "Cast or
          played" and "seen" count everything so far in the game; "on the battlefield", "in hand" and "mana available" are read as the
          turn ends. Criteria use the card search syntax, matched against this deck: <code>t:land</code>, <code>t:creature mv&lt;=3</code>
          , <code>otag:ramp</code>. Empty is any card.
        </p>
        <p className="fine-print">
          With goals written, a search or a look in a card rule (yours or a shipped one) takes a card that fills the first missing piece
          of the first unmet goal, within what the rule allows; a rule that names its own pick keeps it. Tutors the card database read
          without a rule still draw a random card. Goals are kept on this device beside the play style and keep rule.
        </p>
      </HowWorked>
    </>
  );
}

/** "By turn" bars, one per simulated turn, the goal's own turn marked. */
function ByTurn({ byTurn, turn, maxTurn }: { byTurn: number[]; turn: number; maxTurn: number }) {
  const turns = Array.from({ length: maxTurn }, (_, i) => i + 1);
  return (
    <div className="curve odds-curve plan-curve" role="img" aria-label={turns.map((t) => `by turn ${t} ${pct(byTurn[t] ?? 0)}`).join(', ')}>
      {turns.map((t) => {
        const p = byTurn[t] ?? 0;
        return (
          <div key={t} className="curve-col">
            <div className="odds-track">
              <div className={`curve-bar${t === turn ? ' sim-bar-curve' : ''}`} style={{ height: `${p * 100}%` }}>
                <span className="curve-count">{Math.round(p * 100)}</span>
              </div>
            </div>
            <span className={`curve-tick${t === turn ? ' sim-tick-curve' : ''}`}>{t}</span>
          </div>
        );
      })}
    </div>
  );
}

function GoalEditor({
  draft,
  maxTurn,
  onChange,
  onSave,
  onCancel,
}: {
  draft: SimGoal;
  maxTurn: number;
  onChange: (g: SimGoal) => void;
  onSave: (g: SimGoal) => void;
  onCancel: () => void;
}) {
  const setTerm = (i: number, next: GoalTerm) => onChange({ ...draft, terms: draft.terms.map((t, k) => (k === i ? next : t)) });
  const dropTerm = (i: number) => onChange({ ...draft, terms: draft.terms.filter((_t, k) => k !== i) });
  const addTerm = () => onChange({ ...draft, terms: [...draft.terms, { kind: 'inPlay', n: 1, q: '' }] });
  const changeKind = (i: number, t: GoalTerm, kind: GoalTermKind) => {
    const opt = GOAL_TERMS.find((o) => o.id === kind)!;
    setTerm(i, opt.cards ? { kind, n: t.n, q: t.q ?? '' } : { kind, n: kind === 'commander' ? 1 : t.n });
  };
  const ok = draft.terms.length > 0;
  return (
    <div className="plan-editor">
      <p className="plan-goal-text">{describeGoal(draft)}</p>
      <ul className="plan-terms">
        {draft.terms.map((t, i) => {
          const opt = GOAL_TERMS.find((o) => o.id === t.kind)!;
          return (
            <li key={i} className="plan-term">
              <label className="field">
                <select value={t.kind} aria-label="What has to be true" onChange={(e) => changeKind(i, t, e.target.value as GoalTermKind)}>
                  {GOAL_TERMS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {t.kind !== 'commander' && (
                <label className="field behavior-n">
                  <input
                    type="number"
                    min={1}
                    max={MAX_GOAL_TERM_N}
                    inputMode="numeric"
                    aria-label="At least this many"
                    value={t.n}
                    onChange={(e) => setTerm(i, { ...t, n: Math.max(1, Math.min(MAX_GOAL_TERM_N, Math.round(Number(e.target.value) || 1))) })}
                  />
                </label>
              )}
              {opt.cards && (
                <input
                  className="odds-query plan-query"
                  value={t.q ?? ''}
                  maxLength={MAX_GOAL_QUERY}
                  onChange={(e) => setTerm(i, { ...t, q: e.target.value })}
                  placeholder="any card, or t:land, t:creature, otag:ramp…"
                  aria-label="Which cards count"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              )}
              {draft.terms.length > 1 && (
                <button type="button" className="linklike" onClick={() => dropTerm(i)} aria-label="Remove this part">
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="odds-controls">
        {draft.terms.length < MAX_GOAL_TERMS && (
          <button type="button" className="linklike" onClick={addTerm}>
            + and also…
          </button>
        )}
        <div className="odds-stepper">
          <span>by turn</span>
          <Step value={draft.turn} lo={1} hi={maxTurn} label="goal turn" onChange={(n) => onChange({ ...draft, turn: n })} />
        </div>
      </div>
      <div className="plan-actions">
        <button type="button" className="primary" disabled={!ok} onClick={() => onSave(draft)}>
          Save goal
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="fine-print">
        Up to {MAX_GOAL_TERMS} part{plural(MAX_GOAL_TERMS)} per goal, all of them at once.
      </p>
    </div>
  );
}
