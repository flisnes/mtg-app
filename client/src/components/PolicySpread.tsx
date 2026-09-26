import { SPEND_POLICIES, type SimResult, type SpendPolicy, type SpendRun } from '@mtg/sim';
import { FLOW_TURN } from './FlowTurnsPanel.js';
import { HowWorked } from './HowWorked.js';

// What the spend order is worth (rebuild plan C6). Every other number on the
// page is read under one spend order; this is the same deck under all four, at
// the quick pass's size and seed, so the rows deal the same games and the
// spread is the policy. A deck where the spread is small can stop arguing about
// its sequencing. One where it is large has a number that depends on how you
// play it, and should know which way.

const pct = (p: number) => `${Math.round(p * 100)}%`;
const one = (n: number) => n.toFixed(1);

interface Measure {
  key: string;
  head: string;
  of: (r: SimResult) => number | undefined;
  show: (n: number) => string;
  /** A spread under this is noise at 2k games, and nothing is marked best. */
  noise: number;
}

function measures(t: number, commander: boolean): Measure[] {
  const all: Measure[] = [
    { key: 'cmdr', head: 'Commander', of: (r) => r.commanders[0]?.onCurvePay, show: pct, noise: 0.03 },
    { key: 'mana', head: `Mana t${t}`, of: (r) => r.manaByTurn[t], show: one, noise: 0.15 },
    { key: 'spent', head: `Spent t${t}`, of: (r) => r.manaSpentByTurn[t], show: one, noise: 0.15 },
    { key: 'cards', head: `Cards t${t}`, of: (r) => r.cardsSeenByTurn[t], show: one, noise: 0.15 },
  ];
  return commander ? all : all.slice(1);
}

const labelOf = (spend: SpendPolicy) => SPEND_POLICIES.find((p) => p.id === spend)?.short ?? spend;

/** The one sentence: the measure the spend order moves most, against its own noise. */
export function spreadVerdict(runs: readonly SpendRun[], current: SpendPolicy): { text: string; /** A different order does better on the measure that moved most. */ moves: boolean } {
  const first = runs[0]?.result;
  if (!first) return { text: '', moves: false };
  const t = Math.min(FLOW_TURN, first.maxTurn);
  let best: { m: Measure; lo: SpendRun; hi: SpendRun; ratio: number } | null = null;
  for (const m of measures(t, first.commanders.length > 0)) {
    let lo: SpendRun | null = null;
    let hi: SpendRun | null = null;
    for (const r of runs) {
      const v = m.of(r.result);
      if (v === undefined) continue;
      if (!lo || v < m.of(lo.result)!) lo = r;
      if (!hi || v > m.of(hi.result)!) hi = r;
    }
    if (!lo || !hi) continue;
    const ratio = (m.of(hi.result)! - m.of(lo.result)!) / m.noise;
    if (!best || ratio > best.ratio) best = { m, lo, hi, ratio };
  }
  if (!best || best.ratio < 1) {
    return { text: 'The spend order barely moves this deck. Pick the one you would play.', moves: false };
  }
  const { m, lo } = best;
  // A tie with yours, as shown, is yours: "Ramp first 4.4" when yours reads 4.4 too would send you off for nothing.
  const mine = runs.find((r) => r.spend === current);
  const mineV = mine && m.of(mine.result);
  const hi = mine && mineV !== undefined && m.show(mineV) === m.show(m.of(best.hi.result)!) ? mine : best.hi;
  const what =
    m.key === 'cmdr'
      ? 'your commander on time'
      : m.key === 'mana'
        ? `mana on turn ${t}`
        : m.key === 'spent'
          ? `mana spent on turn ${t}`
          : `cards seen by turn ${t}`;
  const tail = hi.spend === current ? ', and yours is the top one' : '';
  return {
    text: `The spend order moves ${what}: ${labelOf(hi.spend)} ${m.show(m.of(hi.result)!)}, ${labelOf(lo.spend)} ${m.show(m.of(lo.result)!)}${tail}.`,
    moves: hi.spend !== current,
  };
}

export function PolicySpread({
  runs,
  current,
  stale,
  onSpend,
}: {
  /** Every spend order's short run, or undefined until the first set lands. */
  runs: readonly SpendRun[] | undefined;
  current: SpendPolicy;
  /** The runs are from before the latest change and a new set is dealing. */
  stale: boolean;
  onSpend: (spend: SpendPolicy) => void;
}) {
  if (!runs || runs.length === 0) {
    return <p className="fine-print sim-waiting">Trying the other spend orders…</p>;
  }
  const first = runs[0]!.result;
  const t = Math.min(FLOW_TURN, first.maxTurn);
  const cols = measures(t, first.commanders.length > 0);
  // Best per column, only where the column moved past its noise.
  const bestOf = new Map<string, SpendPolicy>();
  for (const m of cols) {
    const vals = runs.map((r) => ({ spend: r.spend, v: m.of(r.result) })).filter((x) => x.v !== undefined);
    if (vals.length < 2) continue;
    const hi = vals.reduce((a, b) => (b.v! > a.v! ? b : a));
    const lo = vals.reduce((a, b) => (b.v! < a.v! ? b : a));
    if (hi.v! - lo.v! >= m.noise) bestOf.set(m.key, hi.spend);
  }
  const verdict = spreadVerdict(runs, current);
  return (
    <div className={`policy-spread${stale ? ' is-stale' : ''}`}>
      <p className={`deck-stats-verdict${verdict.moves ? ' tone-warn' : ''}`}>{verdict.text}</p>
      <table className="cast-table">
        <thead>
          <tr>
            <th scope="col">Spend order</th>
            {cols.map((m) => (
              <th key={m.key} scope="col" className="cast-p">
                {m.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.spend} className={r.spend === current ? 'is-current' : undefined}>
              <th scope="row" className="policy-spread-name">
                {r.spend === current ? (
                  <>
                    {labelOf(r.spend)} <span className="policy-spread-yours">yours</span>
                  </>
                ) : (
                  <button type="button" className="policy-spread-use" onClick={() => onSpend(r.spend)}>
                    {labelOf(r.spend)}
                  </button>
                )}
              </th>
              {cols.map((m) => {
                const v = m.of(r.result);
                return (
                  <td key={m.key} className={`cast-p${bestOf.get(m.key) === r.spend ? ' tone-ok' : ''}`}>
                    {v === undefined ? '-' : m.show(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine-print">
        {first.games.toLocaleString()} games each, same shuffles, combat and instants as set. Tap an order to play the deck that way.
      </p>
      <HowWorked>
        <p className="fine-print">
          Commander is its on-time rate. Mana is what you could make on turn {t}, spent is what went into spells that turn, cards is
          everything drawn by then. Green marks the best in a column when the gap is bigger than the shuffle noise at this many
          games (3 points, or 0.15).
        </p>
      </HowWorked>
    </div>
  );
}
