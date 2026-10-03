import { SPEED_NOTE, type BracketCard, type BracketReport, type BracketSpeed } from '@mtg/sim';
import { HowWorked } from './HowWorked.js';

// The Bracket tab (rebuild plan D1): what the Commander Brackets count in this
// deck, read off the cards, and the lowest bracket those counts fit. The
// criteria are data in the sim package (bracketCriteria.json), so a WotC
// revision is an edit there and nothing here.
//
// Plus the clock (D2): how often the simulated games have one opponent dead
// by a turn, against the turn each bracket is built around. Still honest
// about its edges: two-card combos (D3) are not read, so the bracket named is
// a floor set by the cardboard and the clock.

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function BracketPanel({ report, commander, games }: { report: BracketReport; commander: boolean; games: number }) {
  const { level, reasons } = report;
  const flagged = report.gameChangers.length + report.massLandDenial.length + report.extraTurns.length;
  const tutors = report.tutors;
  return (
    <>
      <p className={`deck-stats-verdict ${level.id >= 4 ? 'tone-warn' : 'tone-ok'}`}>
        <strong>
          Bracket {level.id}: {level.name}
        </strong>{' '}
        {reasons.length > 0
          ? `at least, because of ${reasons.join(' and ')}.`
          : flagged === 0
            ? 'by the cards and the clock: no Game Changers, no mass land denial, no extra turns, no early kills.'
            : 'by the cards and the clock.'}
        {!commander && ' This is a Commander question; the counts below still hold for any deck.'}
      </p>
      <p className="fine-print">
        A floor, not a verdict. Two-card combos are not read here, and Exhibition is a way of playing rather than a list of
        cards, so the lowest this names is Core.
      </p>

      <Speed speed={report.speed} games={games} />

      <Section title="Game Changers" cards={report.gameChangers} none="None. Bracket 3 allows up to three; Core allows none." />
      <Section title="Mass land denial" cards={report.massLandDenial} none="None. Allowed from Bracket 4." why />
      <Section
        title="Extra turns"
        cards={report.extraTurns}
        none="None. One extra-turn card is fine through Bracket 3; two or more can chain, which Bracket 4 allows."
        why
      />
      {tutors ? (
        <Section title={`Tutors (${tutors.length})`} cards={tutors} none="None." folded />
      ) : (
        <>
          <h3 className="deck-stats-head">Tutors</h3>
          <p className="fine-print">The tag vocabulary has not loaded, so the tutors could not be counted. Open the app online once and it will.</p>
        </>
      )}

      <HowWorked>
        <p className="fine-print">
          Game Changers are Scryfall's flag for the current list, which rides with the card data and updates with it. Mass
          land denial and extra turns are read off each card's text: "destroy all lands", "each player sacrifices X lands",
          "nonbasic lands are Mountains", "players can't untap more than one land", "take an extra turn". Tutors are every
          card Scryfall tags as one, cheap cantrips included, so the count runs high.
        </p>
        <p className="fine-print">
          The ladder: {report.levels.map((l) => `${l.id} ${l.name}`).join(', ')}. Core and Exhibition allow no Game Changers,
          Upgraded up to three, Optimized any number; mass land denial and chained extra turns start at Optimized.
        </p>
        <p className="fine-print">
          Speed: {SPEED_NOTE} The kill is counted when the damage dealt reaches one starting life total, or the poison reaches ten.
          Nothing blocks and nobody answers, so it reads fast; every card the model cannot read deals nothing, so it reads slow.
          The higher of the cards and the clock names the bracket.
        </p>
        <p className="fine-print">{report.source}</p>
      </HowWorked>
    </>
  );
}

/** The clock (rebuild plan D2): one opponent dead by each turn, and the lines that would move the bracket. */
function Speed({ speed, games }: { speed: BracketSpeed | null; games: number }) {
  if (!speed) {
    return (
      <>
        <h3 className="deck-stats-head">Speed</h3>
        <p className="deck-stats-verdict sim-waiting">Dealing {games.toLocaleString()} games…</p>
      </>
    );
  }
  const turns = Array.from({ length: speed.maxTurn }, (_, i) => i + 1);
  const head =
    speed.halfTurn !== null
      ? `One opponent is dead by turn ${speed.halfTurn} in half the games.`
      : speed.lethalByEnd >= 0.005
        ? `One opponent is dead by turn ${speed.maxTurn} in ${pct(speed.lethalByEnd)} of games.`
        : `No game kills an opponent inside ${speed.maxTurn} turns.`;
  return (
    <>
      <h3 className="deck-stats-head">Speed</h3>
      <p className="deck-stats-verdict">
        <strong>{head}</strong> {speed.why ? `That reads as Bracket ${speed.level}: ${speed.why}.` : 'Under every bracket line, so the clock says nothing here.'}
      </p>
      <div className="curve odds-curve plan-curve" role="img" aria-label={turns.map((t) => `dead by turn ${t} ${pct(speed.lethalByTurn[t] ?? 0)}`).join(', ')}>
        {turns.map((t) => {
          const p = speed.lethalByTurn[t] ?? 0;
          return (
            <div key={t} className="curve-col">
              <div className="odds-track">
                <div className="curve-bar" style={{ height: `${p * 100}%` }}>
                  <span className="curve-count">{Math.round(p * 100)}</span>
                </div>
              </div>
              <span className="curve-tick">{t}</span>
            </div>
          );
        })}
      </div>
      <p className="fine-print">
        What would move it:{' '}
        {[...speed.signals]
          .sort((a, b) => a.bracket - b.bracket)
          .map((s) => `a kill by turn ${s.lethalBy} in ${pct(s.share)} of games reads as Bracket ${s.bracket} (now ${pct(speed.lethalByTurn[s.lethalBy] ?? 0)})`)
          .join('; ')}
        . A goldfish on one of three opponents, with nothing in the way.
      </p>
    </>
  );
}

function Section({ title, cards, none, why = false, folded = false }: { title: string; cards: BracketCard[]; none: string; why?: boolean; folded?: boolean }) {
  const label = title.includes('(') || cards.length === 0 ? title : `${title} (${cards.length})`;
  if (cards.length === 0) {
    return (
      <>
        <h3 className="deck-stats-head">{label}</h3>
        <p className="fine-print">{none}</p>
      </>
    );
  }
  const list = (
    <ul className="bracket-list">
      {cards.map((c) => (
        <li key={c.oracleId}>
          <span className="bracket-name">
            {c.name}
            {c.commander ? ' (commander)' : c.copies > 1 ? ` ×${c.copies}` : ''}
          </span>
          {why && c.why && <span className="fine-print">{c.why}</span>}
        </li>
      ))}
    </ul>
  );
  if (folded) {
    return (
      <details className="behavior-fold bracket-fold">
        <summary>
          <span className="deck-stats-head">{label}</span>
        </summary>
        {list}
      </details>
    );
  }
  return (
    <>
      <h3 className="deck-stats-head">{label}</h3>
      {list}
    </>
  );
}
