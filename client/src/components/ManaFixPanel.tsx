import { useMemo } from 'react';
import type { DeckFormat } from '@mtg/shared';
import { ManaCost } from './ManaCost.js';
import { Icon } from './icons.js';
import { colorName, type ManaReport } from '@mtg/sim';
import type { GroupRow } from '@mtg/sim';
import { commanderIdentity } from '../deck/legality.js';
import { CONTAINER_META } from '../deck/containers.js';
import { fixCandidates, manaNeeds, planFixes, type FixPlan, type ManaFix, type ManaNeed } from '../deck/manaFixes.js';
import { useOwnedSources } from '../db/useOwnedSources.js';
import type { PlacementIndex } from '../db/usePlacements.js';

// The answer to the question the panel above it asks. "Two white sources short"
// is a diagnosis; "you have three Plains in a bulk box, tap to file them" is a
// fix, and it is one only a collection app can offer.
//
// It never suggests a card you don't own, and never suggests one another deck
// is holding — see deck/manaFixes.ts for why both of those are on purpose.

export function ManaFixPanel({
  report,
  rows,
  deckId,
  format,
  placements,
  onAdd,
}: {
  report: ManaReport;
  rows: readonly GroupRow[];
  deckId: string;
  format: DeckFormat | undefined;
  placements: PlacementIndex | undefined;
  onAdd: (fix: ManaFix) => void;
}) {
  const needs = useMemo(() => (report.hasManaData ? manaNeeds(report) : []), [report]);
  const sources = useOwnedSources(deckId, placements, needs.length > 0);

  const plan = useMemo(() => {
    if (needs.length === 0 || !sources) return null;
    const identity = commanderIdentity(format, rows);
    return planFixes(needs, fixCandidates(sources, rows, format, identity));
  }, [needs, sources, rows, format]);

  if (needs.length === 0) return null;

  return (
    <>
      <h3 className="deck-stats-head">Fixes from your collection</h3>
      {!plan ? (
        <p className="fine-print">Looking through your collection…</p>
      ) : (
        <>
          <p className="deck-stats-verdict">{verdict(plan)}</p>
          {plan.fixes.length > 0 && (
            <ul className="fix-rows">
              {plan.fixes.map((f) => (
                <li key={f.candidate.oracleId}>
                  <button type="button" className="fix-row" onClick={() => onAdd(f)}>
                    <span className="fix-row-add">
                      <Icon name="plus" size={14} />
                      {f.copies}
                    </span>
                    <span className="source-row-name">{f.candidate.name}</span>
                    <ManaCost cost={f.covers.map((c) => `{${c}}`).join('')} className="source-row-cost" />
                    <span className="source-row-note">{whereText(f)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {plan.fixes.length > 0 && (
            <p className="fine-print">
              Tapping a row files those copies into the mainboard, out of the pile they're in now. It takes nothing out, so the odds above
              only move all the way once you cut {plan.added} card{plural(plan.added)} to make room: a bigger deck draws its lands later,
              which is the whole reason the count matters. Which {plan.added === 1 ? 'spell' : 'spells'} to cut isn't a question
              arithmetic answers.
            </p>
          )}
          {plan.spokenFor.length > 0 && (
            <p className="fine-print">
              You own {listNames(plan.spokenFor.map((s) => s.name))} too, but{' '}
              {plan.spokenFor.length === 1 ? `it's in ${plan.spokenFor[0]!.where}` : "they're in other decks"}. Cards in a binder or a box
              are spare; cards in another deck are that deck's.
            </p>
          )}
          <p className="fine-print">
            Only what your collection holds, checked against this deck's format and color identity. A fetchland is counted for the lands
            this decklist actually runs, the same way the report above counts one.
          </p>
        </>
      )}
    </>
  );
}

const plural = (n: number) => (n === 1 ? '' : 's');

/** "1 spare · Binder: Duals", or where it is when it isn't filed anywhere. */
function whereText(fix: ManaFix): string {
  const { free, where, slow } = fix.candidate;
  const place = where[0] ? `${CONTAINER_META[where[0].kind].Noun}: ${where[0].name}` : 'unfiled';
  return `${free} spare · ${place}${slow ? ' · enters tapped' : ''}`;
}

/** "Plains", "Plains and Sacred Foundry", "Plains, Sacred Foundry and Tundra". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "2 white sources", or "1 white-or-blue source" for a hybrid requirement. */
function needText(need: ManaNeed): string {
  return `${need.short} ${colorName(need.colors)} source${plural(need.short)}`;
}

function verdict(plan: FixPlan) {
  if (plan.fixes.length === 0) {
    const missing = listNames(plan.needs.map(needText));
    return plan.spokenFor.length > 0 ? (
      <>Nothing <em>spare</em> in your collection makes up the {missing}.</>
    ) : (
      <>Nothing in your collection makes up the {missing}.</>
    );
  }
  if (plan.remaining.length === 0) {
    return (
      <>
        <strong className="tone-ok">Your collection covers it.</strong> {plan.added} card{plural(plan.added)} you own and aren't using,
        swapped in for {plan.added} you can spare.
      </>
    );
  }
  return (
    <>
      <strong>Most of the way.</strong> These {plan.added} close everything but {listNames(plan.remaining.map(needText))}.
    </>
  );
}
