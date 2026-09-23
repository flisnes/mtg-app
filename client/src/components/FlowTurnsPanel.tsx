import { useState } from 'react';
import { MANA_BINS, type SimResult } from '../analysis/simulate.js';
import { HowWorked } from './HowWorked.js';

// Screw and flood (rebuild plan B2): the same games as the trajectory charts,
// sorted a turn at a time instead of averaged. An average of 4.7 mana on turn
// six hides the game on three lands and the one on eight; this is where they
// show up.

/** The turn the verdict is read on, the same one the Overview's Flow row uses. */
export const FLOW_TURN = 6;

const pct = (p: number) => `${Math.round(p * 100)}%`;
const one = (n: number) => n.toFixed(1);

/** Turns 2 to `through`: turn one casts nothing in most decks and says nothing. */
export function idleTurns(result: SimResult, through: number): number {
  let sum = 0;
  for (let t = 2; t <= through; t++) sum += result.idleByTurn[t] ?? 0;
  return sum;
}

/** Mana available and not spent, summed over turns 1 to `through`. */
export function manaUnspent(result: SimResult, through: number): number {
  let sum = 0;
  for (let t = 1; t <= through; t++) sum += Math.max(0, (result.manaByTurn[t] ?? 0) - (result.manaSpentByTurn[t] ?? 0));
  return sum;
}

export function FlowTurnsPanel({ result }: { result: SimResult }) {
  const t = Math.min(FLOW_TURN, result.maxTurn);
  const [turn, setTurn] = useState(t);
  const turns = Array.from({ length: result.maxTurn }, (_, i) => i + 1);
  const screw = result.screwEverByTurn[t] ?? 0;
  const flood = result.floodEverByTurn[t] ?? 0;

  return (
    <>
      <h3 className="deck-stats-head">Screw and flood</h3>
      <p className="deck-stats-verdict">
        <strong>
          By turn {t}: screwed at least once in {pct(screw)} of games, flooded in {pct(flood)}.
        </strong>{' '}
        You cast nothing on {one(idleTurns(result, t))} of turns 2 to {t}, and leave {one(manaUnspent(result, t))} mana
        unspent across turns 1 to {t}.
      </p>
      <p className="fine-print">Cards that do nothing (yet) never refill your hand, so flood reads high until they are written.</p>

      <table className="cast-table flow-table">
        <thead>
          <tr>
            <th scope="col">Turn</th>
            <th scope="col" className="cast-p">
              Screwed
            </th>
            <th scope="col" className="cast-p">
              Flooded
            </th>
            <th scope="col" className="cast-p">
              Cast nothing
            </th>
            <th scope="col" className="cast-p">
              Mana on curve
            </th>
          </tr>
        </thead>
        <tbody>
          {turns.map((n) => (
            <tr key={n} className={n === t ? 'flow-row-mark' : undefined}>
              <td className="cast-turn">{n}</td>
              <td className="cast-p">{pct(result.screwByTurn[n] ?? 0)}</td>
              <td className="cast-p">{pct(result.floodByTurn[n] ?? 0)}</td>
              <td className="cast-p">{pct(result.idleByTurn[n] ?? 0)}</td>
              <td className="cast-p">{pct(result.manaAtLeast[n]?.[n] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className="source-live-head">Mana on turn</h4>
      <select
        className="sim-pick"
        value={turn}
        onChange={(e) => setTurn(Number(e.target.value))}
        aria-label="Turn to chart"
      >
        {turns.map((n) => (
          <option key={n} value={n}>
            Turn {n}
          </option>
        ))}
      </select>
      <ManaChart atLeast={result.manaAtLeast[turn] ?? []} turn={turn} />
      <p className="fine-print">{manaCaption(result.manaAtLeast[turn] ?? [], turn)}</p>

      <HowWorked>
        <p className="fine-print">
          Screwed: two or more mana behind the turn number, holding a spell that costs more than you have. One behind is an
          ordinary Commander turn six, and behind with nothing to cast costs you nothing.
        </p>
        <p className="fine-print">
          Flooded: two or more mana left over and no spell in hand to spend it on. An empty hand counts, since the fix is the
          same: more cards. Your commander counts as a spell in hand until it is cast.
        </p>
        <p className="fine-print">
          Cast nothing: no spell at all that turn, whatever the reason. Mana on curve: at least as much mana as the turn
          number.
        </p>
      </HowWorked>
    </>
  );
}

/**
 * "At least k" bars from 1 to a few past the turn, cut where the odds are no
 * longer worth a bar. The column for k equal to the turn is the on-curve one.
 */
function ManaChart({ atLeast, turn }: { atLeast: number[]; turn: number }) {
  const ks = barRange(atLeast, turn);
  return (
    <div className="curve odds-curve" role="img" aria-label={ks.map((k) => `at least ${k} mana ${pct(atLeast[k] ?? 0)}`).join(', ')}>
      {ks.map((k) => {
        const p = atLeast[k] ?? 0;
        return (
          <div key={k} className="curve-col">
            <div className="odds-track">
              <div className={`curve-bar${k === turn ? ' sim-bar-curve' : ''}`} style={{ height: `${p * 100}%` }}>
                <span className="curve-count">{Math.round(p * 100)}</span>
              </div>
            </div>
            <span className={`curve-tick${k === turn ? ' sim-tick-curve' : ''}`}>
              {k}
              {k === MANA_BINS - 1 ? '+' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function barRange(atLeast: number[], turn: number): number[] {
  const out: number[] = [];
  const last = Math.min(MANA_BINS - 1, turn + 4);
  for (let k = 1; k <= last; k++) {
    // Past the turn, stop once it rounds to nothing.
    if (k > turn && (atLeast[k] ?? 0) < 0.005) break;
    out.push(k);
  }
  return out;
}

function manaCaption(atLeast: number[], turn: number): string {
  const on = atLeast[turn] ?? 0;
  const ahead = atLeast[turn + 1] ?? 0;
  const behind = 1 - (atLeast[turn - 1] ?? 1);
  const bits = [`At least ${turn} mana on turn ${turn} in ${pct(on)} of games`];
  if (turn + 1 < MANA_BINS && ahead >= 0.005) bits.push(`${turn + 1} or more in ${pct(ahead)}`);
  if (turn > 1 && behind >= 0.005) bits.push(`${turn === 2 ? 'none' : `${turn - 2} or less`} in ${pct(behind)}`);
  return `${bits.join(', ')}.`;
}
