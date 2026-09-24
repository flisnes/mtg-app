import type { SimResult } from '../analysis/simulate.js';
import { FLOW_TURN } from './FlowTurnsPanel.js';

// What a saved rule did to the numbers (rebuild plan C2). Before and after are
// the same seed, so the two runs deal the same games and the difference is the
// rule rather than the shuffle. The quick pass answers first; the full run
// replaces it when it lands.

const pct = (p: number) => `${Math.round(p * 100)}%`;
const one = (n: number) => n.toFixed(1);

/** The most lines worth reading on a toast. The card's own come first. */
const MAX_LINES = 4;

export interface ToastLine {
  label: string;
  before: string;
  after: string;
  /** Up is good, down is good, or the card's own line, which has no verdict. */
  tone: 'ok' | 'bad' | 'plain';
}

interface Measure {
  label: string;
  of: (r: SimResult) => number | undefined;
  show: (n: number) => string;
  /** Below this, the difference is not worth a line. */
  noise: number;
  better: 'up' | 'down';
}

function deckMeasures(t: number): Measure[] {
  return [
    { label: 'Commander on time', of: (r) => r.commanders[0]?.onCurvePay, show: pct, noise: 0.005, better: 'up' },
    { label: `Mana on turn ${t}`, of: (r) => r.manaByTurn[t], show: one, noise: 0.05, better: 'up' },
    { label: `Cards seen by turn ${t}`, of: (r) => r.cardsSeenByTurn[t], show: one, noise: 0.05, better: 'up' },
    { label: `Screwed by turn ${t}`, of: (r) => r.screwEverByTurn[t], show: pct, noise: 0.005, better: 'down' },
    { label: `Flooded by turn ${t}`, of: (r) => r.floodEverByTurn[t], show: pct, noise: 0.005, better: 'down' },
  ];
}

/** What changed, the card's own work first, then the deck lines that moved. */
export function changeLines(oracleId: string, before: SimResult, after: SimResult): ToastLine[] {
  const lines: ToastLine[] = [];
  const cb = before.contributions.find((c) => c.oracleId === oracleId);
  const ca = after.contributions.find((c) => c.oracleId === oracleId);
  const cards = [cb?.cards ?? 0, ca?.cards ?? 0];
  const mana = [cb?.mana ?? 0, ca?.mana ?? 0];
  if (Math.abs(cards[1]! - cards[0]!) >= 0.05) {
    lines.push({ label: 'It draws, per game', before: one(cards[0]!), after: one(cards[1]!), tone: 'plain' });
  }
  if (Math.abs(mana[1]! - mana[0]!) >= 0.05) {
    lines.push({ label: 'It makes, mana per game', before: one(mana[0]!), after: one(mana[1]!), tone: 'plain' });
  }
  const t = Math.min(FLOW_TURN, after.maxTurn);
  for (const m of deckMeasures(t)) {
    if (lines.length >= MAX_LINES) break;
    const b = m.of(before);
    const a = m.of(after);
    if (b === undefined || a === undefined || Math.abs(a - b) < m.noise) continue;
    // Compared as shown, so a line never reads "31% -> 31%".
    if (m.show(a) === m.show(b)) continue;
    const up = a > b;
    lines.push({ label: m.label, before: m.show(b), after: m.show(a), tone: up === (m.better === 'up') ? 'ok' : 'bad' });
  }
  return lines;
}

export function ModelChangeToast({
  name,
  cleared,
  lines,
  games,
  final,
  noBase,
  onUndo,
  onClose,
}: {
  name: string;
  /** The rule was removed ("back to the database") rather than written. */
  cleared: boolean;
  /** Null while the first answer deals. */
  lines: ToastLine[] | null;
  games: number | null;
  final: boolean;
  /** Saved while the previous games were still dealing, so there is no before. */
  noBase: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  return (
    <div className="model-toast" role="status" aria-live="polite">
      <div className="model-toast-head">
        <strong>
          {name} {cleared ? 'is back to the database' : 'saved'}
        </strong>
        <button type="button" className="model-toast-undo" onClick={onUndo}>
          Undo
        </button>
        <button type="button" className="model-toast-close" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      </div>
      {noBase ? (
        <p className="model-toast-note">
          Saved while the last change was still dealing, so there is no before to compare it with.
        </p>
      ) : lines === null ? (
        <p className="model-toast-note">Dealing the games again…</p>
      ) : lines.length === 0 ? (
        <p className="model-toast-note">
          No number moved{final ? '' : ' yet'}. If it should have, watch one game play out on the Flow tab and see whether the rule fires.
        </p>
      ) : (
        <table className="model-toast-lines">
          <tbody>
            {lines.map((l) => (
              <tr key={l.label}>
                <th scope="row">{l.label}</th>
                <td>{l.before}</td>
                <td aria-hidden="true">→</td>
                <td className={l.tone === 'plain' ? undefined : `tone-${l.tone}`}>{l.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {games !== null && (
        <p className="model-toast-note">
          {games.toLocaleString()} games, same shuffles before and after{final ? '.' : '. The full run is on its way.'}
        </p>
      )}
    </div>
  );
}
