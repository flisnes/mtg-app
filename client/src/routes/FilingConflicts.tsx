import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { REMOVAL_REASONS, type OracleCard, type Priced, type Printing, type RemovalReason } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { addToCollection, removeDeckCardsMatching, removeFromCollection } from '../db/dataAccess.js';
import { usePlacementIndex, type FilingConflict } from '../db/usePlacements.js';
import { CONTAINER_META } from '../deck/containers.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { SetSymbol } from '../components/SetSymbol.js';

// "Where is this card, actually?" — one conflict at a time.
//
// A conflict is one piece of cardboard promised to more containers than you own
// copies of it: your NM English Sol Ring is in two decks, and you have one. The
// app never blocks that (brewing needs the freedom, and a mis-tap shouldn't lose
// data), so this is where the pile of them gets worked through.
//
// Three ways a conflict is genuinely resolved, matching the three things that can
// actually be true:
//   - it's in one of these places and not the others  → unfile it from the rest
//   - you own more copies than the app knew about     → add them
//   - you don't have it any more                      → remove it and unfile it
// Plus Skip, for "not now" — skipping is per session, nothing is written.

const REASON_LABELS: Record<RemovalReason, string> = {
  sold: 'Sold it',
  traded: 'Traded it away',
  lost: 'Lost it',
  corrected: 'Fixed incorrect card information',
  other: 'Something else',
};

/** A conflict with the card-DB bits needed to show it. */
interface Joined {
  conflict: FilingConflict;
  key: string;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
}

const keyOf = (c: FilingConflict) => `${c.scryfallId}|${c.condition}|${c.finish}|${c.lang}`;

export function FilingConflicts() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const placements = usePlacementIndex();
  const conflicts = placements?.conflicts;
  // Set when we're linked here straight off a trade's "sort this out" prompt —
  // lets the affected conflicts (and only those) ask "which did you trade
  // away" instead of the generic "where is it".
  const tradedKeys = (location.state as { tradedKeys?: string[] } | null)?.tradedKeys;
  const fromTrade = useMemo(() => new Set(tradedKeys ?? []), [tradedKeys]);
  // "Not now" is a view state, not a stored one: nothing is written, and coming
  // back to the page offers them again.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState<RemovalReason>('sold');

  const cards = useLiveQuery(async () => {
    if (!conflicts || conflicts.length === 0) return { oracles: new Map(), printings: new Map() };
    const [oracles, printings] = await Promise.all([
      getOracleCardsByIds(conflicts.map((c) => c.oracleId)),
      getPrintingsByIds(conflicts.map((c) => c.scryfallId)),
    ]);
    return { oracles, printings };
  }, [conflicts]);

  const joined = useMemo((): Joined[] => {
    if (!conflicts) return [];
    return conflicts
      .map((conflict) => ({
        conflict,
        key: keyOf(conflict),
        oracle: cards?.oracles.get(conflict.oracleId),
        printing: cards?.printings.get(conflict.scryfallId),
      }))
      .sort((a, b) => (a.oracle?.name ?? '').localeCompare(b.oracle?.name ?? ''));
  }, [conflicts, cards]);

  const remaining = joined.filter((j) => !skipped.has(j.key));
  const current = remaining[0];
  const skippedCount = joined.length - remaining.length;

  // A fresh conflict deserves a fresh question — don't leave the removal panel
  // hanging open over the next card.
  useEffect(() => {
    setRemoving(false);
    setReason('sold');
  }, [current?.key]);

  /** Every container claiming this copy loses it, except `keepId` if given. */
  async function unfile(j: Joined, keepId?: string) {
    const { conflict } = j;
    for (const place of conflict.places) {
      if (place.containerId === keepId) continue;
      await removeDeckCardsMatching(place.containerId, [
        {
          oracleId: conflict.oracleId,
          scryfallId: conflict.scryfallId,
          quantity: place.quantity,
          wants: { condition: conflict.condition, finish: conflict.finish, lang: conflict.lang },
        },
      ]);
    }
  }

  async function keepOnlyIn(j: Joined, containerId: string, name: string) {
    setBusy(true);
    try {
      await unfile(j, containerId);
      toast(`Filed only in ${name} now`);
    } finally {
      setBusy(false);
    }
  }

  async function ownMore(j: Joined) {
    const { conflict } = j;
    const extra = conflict.claimed - conflict.owned;
    setBusy(true);
    try {
      await addToCollection({
        oracleId: conflict.oracleId,
        scryfallId: conflict.scryfallId,
        condition: conflict.condition,
        finish: conflict.finish,
        lang: conflict.lang,
        quantity: extra,
      });
      toast(`Added ${extra} more to your collection`);
    } finally {
      setBusy(false);
    }
  }

  async function goneForGood(j: Joined) {
    const { conflict } = j;
    setBusy(true);
    try {
      // Take the copies off the shelves first, then out of every container: the
      // card is gone, so no slot can be holding it.
      // Every row of this copy identity, not just the first: an altered copy of
      // the same printing and grade is its own line, and "gone for good" means
      // all of them are.
      const entries = await db.collection
        .where('[scryfallId+condition+finish+lang]')
        .equals([conflict.scryfallId, conflict.condition, conflict.finish, conflict.lang])
        .toArray();
      for (const entry of entries) await removeFromCollection(entry.id, entry.quantity, reason);
      await unfile(j);
      toast(entries.length ? 'Removed from your collection and unfiled' : 'Unfiled everywhere');
    } finally {
      setBusy(false);
    }
  }

  if (!placements || !cards) {
    return (
      <Page title="Filing conflicts">
        <p className="search-meta">Loading…</p>
      </Page>
    );
  }

  if (joined.length === 0) {
    return (
      <Page title="Filing conflicts" subtitle="Every card is filed in exactly one place.">
        <div className="empty-state">
          <p>Nothing to sort out. Your collection and your containers agree.</p>
          <p className="empty-phase">
            <button className="linklike" onClick={() => navigate('/collection')}>
              Back to your collection
            </button>
          </p>
        </div>
      </Page>
    );
  }

  if (!current) {
    return (
      <Page title="Filing conflicts" subtitle={`${skippedCount} left for later.`}>
        <div className="empty-state">
          <p>That’s everything you wanted to deal with.</p>
          <p className="empty-phase">
            <button className="linklike" onClick={() => setSkipped(new Set())}>
              Go through the {skippedCount} skipped {skippedCount === 1 ? 'card' : 'cards'} again
            </button>
          </p>
        </div>
      </Page>
    );
  }

  const { conflict, oracle, printing } = current;
  const image = printing?.imageNormal ?? printing?.imageSmall ?? oracle?.imageNormal ?? oracle?.imageSmall ?? null;
  const traits = [conflict.condition, conflict.finish, conflict.lang !== 'en' ? conflict.lang : null]
    .filter(Boolean)
    .join(' · ');
  const isTradeCaused = fromTrade.has(current.key);

  return (
    <Page
      title="Filing conflicts"
      subtitle={`${remaining.length} to sort out${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}`}
    >
      <div className="conflict-card">
        {image ? (
          <img className="conflict-art" src={image} alt={oracle?.name ?? 'card'} />
        ) : (
          <div className="conflict-art conflict-art-ph">{oracle?.name ?? '(unknown card)'}</div>
        )}
        <div className="conflict-detail">
          <h2 className="conflict-name">{oracle?.name ?? '(unknown card)'}</h2>
          <p className="result-sub">
            {printing && <SetSymbol set={printing.set} className="sub-set-symbol" title={printing.setName} />}
            {printing ? `${printing.setName} · #${printing.collectorNumber} · ` : ''}
            {traits}
          </p>
          <p className="conflict-sum">
            {isTradeCaused ? (
              <>
                You traded one of these away, but <strong>{conflict.claimed}</strong>{' '}
                {conflict.claimed === 1 ? 'is' : 'are'} still filed. Which copy was it?
              </>
            ) : (
              <>
                You own <strong>{conflict.owned}</strong>, but {conflict.claimed}{' '}
                {conflict.claimed === 1 ? 'is' : 'are'} filed away. A card can only be in one place.
              </>
            )}
          </p>
        </div>
      </div>

      <h3 className="conflict-q">{isTradeCaused ? 'Which copy did you trade away?' : 'Where is it?'}</h3>
      <ul className="menu-list">
        {conflict.places.map((place) => {
          const meta = CONTAINER_META[place.kind];
          return (
            <li key={place.containerId}>
              <button
                className="menu-item menu-item-btn"
                disabled={busy}
                onClick={() => void keepOnlyIn(current, place.containerId, place.name)}
              >
                <span className="menu-icon" aria-hidden>
                  <Icon name={meta.icon} />
                </span>
                <span className="deck-line">
                  <span className="deck-name">{place.name}</span>
                  <span className="deck-meta">
                    <span className="search-meta">
                      It’s here — take it out of the other {conflict.places.length === 2 ? 'one' : 'places'}
                      {place.quantity > 1 ? ` (keeps all ${place.quantity})` : ''}
                    </span>
                  </span>
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <h3 className="conflict-q">Or the collection is out of date</h3>
      <div className="conflict-actions">
        <button disabled={busy} onClick={() => void ownMore(current)}>
          <Icon name="plus" size={14} /> I actually own {conflict.claimed} of{' '}
          {conflict.claimed === 1 ? 'it' : 'these'}
        </button>
        <button disabled={busy} onClick={() => setRemoving((v) => !v)}>
          <Icon name="minus" size={14} /> I don’t have {conflict.owned === 1 ? 'it' : 'them'} any more
        </button>
        <button
          disabled={busy}
          onClick={() => setSkipped((s) => new Set(s).add(current.key))}
          title="Leave this one as it is for now"
        >
          Skip
        </button>
      </div>

      {removing && (
        <div className="conflict-removal">
          <label className="field">
            What happened to it?
            <select value={reason} onChange={(e) => setReason(e.target.value as RemovalReason)}>
              {REMOVAL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <p className="fine-print">
            {conflict.owned > 0
              ? `Removes ${conflict.owned} from your collection and takes the card out of all ${conflict.places.length} places it's filed.`
              : `Takes the card out of all ${conflict.places.length} places it's filed. You don't own it, so there's nothing to remove from your collection.`}
            {reason === 'corrected' &&
              ' Your history records a correction, not a card that left the collection.'}
          </p>
          <div className="sheet-actions">
            <button onClick={() => setRemoving(false)}>Never mind</button>
            <button className="primary" disabled={busy} onClick={() => void goneForGood(current)}>
              {reason === 'corrected' ? 'Clear it out' : 'It’s gone'}
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}
