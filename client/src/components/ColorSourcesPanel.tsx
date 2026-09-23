import { useState } from 'react';
import { ManaCost } from './ManaCost.js';
import { shortfallHeadline, colorName, type CastCheck, type ManaReport } from '../analysis/manaSources.js';
import type { PipColor } from '../analysis/manaCost.js';
import { MASK_BITS } from '../analysis/simDeck.js';
import type { SimResult } from '../analysis/simulate.js';

// "Can I actually cast this?" — the colored-source half of the deck's mana,
// where the land-count verdict is the colorless half.
//
// It leads with the worst offender rather than a table, because a table of
// thirty cards at 94% buries the one at 61% that is losing you games. The
// table is still there underneath it, worst first, and stops before it becomes
// a decklist.
//
// §14 added the second half of the panel, and it is the more honest half. The
// chips at the top count every copy in the decklist as though all of it were on
// the battlefield at once, which is the assumption five separate paragraphs of
// fine print here used to apologise for. The block under them counts what the
// simulator actually had in play. Both stay: the printed count is a fact about
// the pile of cards and the reader needs it, and the measured one is a fact
// about the games.

/** Enough rows to see a pattern, few enough that the sheet stays a sheet. */
const MAX_ROWS = 6;

/**
 * The turn the measured block opens on.
 *
 * Four, because it is where both formats are still deciding the game: a 60-card
 * deck is casting its three- and four-drops and a commander deck is casting its
 * commander. Turn one every deck reads the same and turn eight every deck
 * reads fine.
 */
const DEFAULT_TURN = 4;

const pct = (p: number) => `${Math.round(p * 100)}%`;
const one = (n: number) => n.toFixed(1);

export function ColorSourcesPanel({ report, sim, onPlay }: { report: ManaReport; sim: SimResult | null; onPlay: boolean }) {
  return (
    <>
      <h3 className="deck-stats-head">Colored sources</h3>
      {!report.hasManaData ? (
        <p className="fine-print">
          Your card database predates this data. Refresh it from About to see whether your colors line up with your costs.
        </p>
      ) : (
        <>
          <div className="source-chips">
            {report.byColor.map((c) => (
              <span key={c.color} className="source-chip" title={`${c.count} ${colorName([c.color])} sources`}>
                <ManaCost cost={`{${c.color}}`} />
                <strong>{c.count}</strong>
                {c.slow > 0 && <span className="source-chip-slow">{c.slow} tapped</span>}
              </span>
            ))}
          </div>
          {/* Directly under the chips, because the whole content of this block
              is the gap between the two, and a reader who has to scroll to
              compare them will not. */}
          <h4 className="source-live-head">In play, simulated</h4>
          {sim ? (
            <MeasuredSources report={report} sim={sim} />
          ) : (
            <p className="fine-print">Dealing the games that answer this…</p>
          )}

          <p className="deck-stats-verdict">{verdict(report.checks, report.shortfalls)}</p>
          {report.shortfalls.length > 0 && (
            <ul className="source-rows">
              {report.shortfalls.slice(0, MAX_ROWS).map((c) => (
                <li key={c.oracleId} className={c.uncastable ? 'source-row source-row-bad' : 'source-row'}>
                  <span className="source-row-name">{c.name}</span>
                  <ManaCost cost={c.manaCost} className="source-row-cost" />
                  <span className="source-row-p">{c.uncastable ? 'never' : pct(c.p)}</span>
                  <span className="source-row-note">{rowNote(c)}</span>
                </li>
              ))}
            </ul>
          )}
          {report.shortfalls.length > MAX_ROWS && (
            <p className="fine-print">And {report.shortfalls.length - MAX_ROWS} more below 90%.</p>
          )}
          {report.fetches > 0 && (
            <p className="fine-print">
              {report.fetches} fetchland{report.fetches === 1 ? '' : 's'} counted as {report.fetches === 1 ? 'a source' : 'sources'} of
              everything {report.fetches === 1 ? 'it' : 'they'} could find in this deck. Each land can only be found once, so a pile of
              fetches over a single Island is friendlier here than at the table.
            </p>
          )}
          {report.granted.length > 0 && (
            <p className="fine-print">
              Something in this deck gives every land you control {grantedName(report.granted)} — an Urborg, a Chromatic Lantern or the
              like — so every land is counted as a source of {report.granted.length === 1 ? 'it' : 'them'} here. That assumes you have
              drawn it, the same way a fetchland is counted as everything it could find. The on-curve simulation does not assume it: there
              a granter only widens your lands once it is on the battlefield.
            </p>
          )}
          {(report.genericOnly > 0 || report.restricted > 0 || report.expiring > 0) && (
            <p className="fine-print">
              {report.genericOnly > 0 &&
                `${report.genericOnly} source${report.genericOnly === 1 ? '' : 's'} here read an opponent's lands for their colors, so they count toward generic mana and no colored pip. `}
              {report.restricted > 0 &&
                `${report.restricted} can only be spent on part of your deck, and are counted in full anyway. `}
              {report.expiring > 0 &&
                `${report.expiring} run out after a turn or two and are counted as if they didn't.`}
            </p>
          )}
          <p className="fine-print">
            Each card is held to its mana value as the turn to cast it, at a 90% bar, worked out exactly for a library of{' '}
            {report.library} {onPlay ? 'on the play' : 'on the draw'} with no mulligans. Karsten's published tables ask two to four fewer, because his simulations get
            to mulligan for a source. Lands that always enter tapped count from turn two, rocks and dorks a turn after you could cast them.
            Colors are checked one at a time, so a two-color card can pass both halves and still stumble on the draw that gives you one of
            each.
            {report.unmodelled > 0 && ` ${report.unmodelled} cost${report.unmodelled === 1 ? '' : 's'} here use {X} or snow, taken at face value.`}
          </p>
        </>
      )}
    </>
  );
}

/**
 * The measured half of the panel: per color, the sources that were on the
 * battlefield on a chosen turn.
 *
 * Counted in sources rather than in mana, because the chips above it are in
 * sources and a comparison between two different units would be a trick. The
 * share is against the sources in play that turn and not against the printed
 * count, which is what makes it read on a granter: a deck whose chips say every
 * land is green reads 100% here only in the games where the Yavimaya was
 * actually out.
 *
 * The turn is a control rather than a fixed row per turn. Six colors by eight
 * turns is a 48-cell table, which on a phone is either a horizontal scroll or
 * a font nobody can read.
 */
function MeasuredSources({ report, sim }: { report: ManaReport; sim: SimResult }) {
  const [picked, setPicked] = useState(DEFAULT_TURN);
  const turn = Math.min(picked, sim.maxTurn);
  const inPlay = sim.sourcesInPlayByTurn[turn] ?? 0;
  // A color the deck holds no source of has no share to report, and a row
  // reading "0.0 of 4.0 sources, 0%, 0 printed" is three ways of saying what the
  // chip above already said with one digit. The chips keep those colors, because
  // "a cost asks for black and you have no black" is the point of the chips.
  const rows = report.byColor.filter((c) => c.count > 0);
  return (
    <>
      <div className="seg-row source-turns" role="radiogroup" aria-label="Turn to measure">
        {Array.from({ length: sim.maxTurn }, (_i, n) => n + 1).map((n) => (
          <button
            key={n}
            type="button"
            className={`seg${n === turn ? ' seg-active' : ''}`}
            role="radio"
            aria-checked={n === turn}
            aria-label={`Turn ${n}`}
            onClick={() => setPicked(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {inPlay === 0 || rows.length === 0 ? (
        <p className="fine-print">
          {inPlay === 0 ? `Nothing is on the battlefield yet on turn ${turn}.` : 'This deck holds no source of the colors it asks for.'}
        </p>
      ) : (
        <ul className="source-rows">
          {rows.map((c) => {
            const at = MASK_BITS.indexOf(c.color);
            const live = at < 0 ? 0 : (sim.sourcesByTurn[at]?.[turn] ?? 0);
            const share = live / inPlay;
            return (
              <li key={c.color} className="source-row source-live">
                <ManaCost cost={`{${c.color}}`} className="source-row-cost" />
                <span className="source-live-count">
                  <strong>{one(live)}</strong> of {one(inPlay)} sources
                </span>
                <span className="source-row-p source-live-p">{pct(share)}</span>
                <span className="source-live-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(share * 100)}%` }} />
                </span>
                <span className="source-row-note">{c.count} printed</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="fine-print">
        Simulated · {sim.games.toLocaleString()} games, counted after your land drop and before the turn's mana is spent. The chips above
        count every copy in the deck as though it were already on the battlefield; these count the ones that were. A fetchland is whatever
        it went and got, a granter only widens your lands once it is in play, and a filter land makes nothing on its own: the assumptions
        the small print above has to make, this block does not.
      </p>
      <p className="fine-print">
        Expect the early turns to read high and settle. The simulation plays the land that most widens your colors first, so turn one is
        your best land far more often than the decklist would suggest, and every turn after that drifts back toward what the deck actually
        holds. A share that falls is the deck regressing to its own mean, not your mana getting worse.
      </p>
    </>
  );
}

/**
 * Granted colors, named for a sentence. `colorName` joins with "-or-", which is
 * right for a hybrid pip and unreadable for all five at once — a Chromatic
 * Lantern is not "white-or-blue-or-black-or-red-or-green", it is every color.
 */
function grantedName(colors: readonly PipColor[]): string {
  const wubrg = colors.filter((c) => c !== 'C');
  if (wubrg.length === 5) return colors.includes('C') ? 'every kind of mana' : 'every color';
  return colorName(colors);
}

function verdict(checks: readonly CastCheck[], shortfalls: readonly CastCheck[]) {
  if (checks.length === 0) return 'Nothing in this deck asks for colored mana.';
  if (shortfalls.length === 0) {
    return (
      <>
        <strong className="tone-ok">The mana is there.</strong> All {checks.length} colored card
        {checks.length === 1 ? '' : 's'} clear 90% on curve.
      </>
    );
  }
  const worst = shortfalls[0]!;
  const rest = shortfalls.length - 1;
  return (
    <>
      <strong>{shortfallHeadline(worst)}</strong>
      {rest > 0 && ` ${rest} other card${rest === 1 ? '' : 's'} ${rest === 1 ? 'is' : 'are'} short too.`}
    </>
  );
}

/** The right-hand clause: what is missing, how far off the count is, or when it lands. */
function rowNote(c: CastCheck): string {
  if (c.uncastable) return `no ${c.missing.map((m) => colorName([m])).join(' or ')} mana`;
  if (c.needed === null) {
    return `turn ${c.turn} · ${c.sources} ${colorName(c.colors)} · ${c.clearsAtTurn ? `clears turn ${c.clearsAtTurn}` : 'never clears'}`;
  }
  const short = Math.max(1, c.needed - c.sources);
  return `turn ${c.turn} · ${c.sources} of ${c.needed} ${colorName(c.colors)} (${short} short)`;
}
