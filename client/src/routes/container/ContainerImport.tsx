import { useMemo, useState } from 'react';
import type { DeckBoard } from '@mtg/shared';
import { getOracleCardsByIds, getPrintingsByIds } from '../../db/queries.js';
import { addDeckCardsBulk, applyImport, slotKey } from '../../db/dataAccess.js';
import { useOwnershipIndex } from '../../db/useOwnership.js';
import { isBasicLand } from '../../deck/legality.js';
import { ImportPanel } from '../../import/ImportPanel.js';
import { OverlapChoice, applyOverlap, type OverlapMode } from '../../import/ImportExtras.js';
import type { ResolvedLine } from '../../import/types.js';
import { UnownedPromptSheet, type UnownedCard } from '../../components/UnownedPromptSheet.js';
import { useToast } from '../../components/Toast.js';
import { useKeySet } from '../../components/useKeySet.js';
import { plural } from '../../util/format.js';
import { sumQty } from '../../util/groupBy.js';

/** The "Import list" panel on a container page: paste a list, add it to this
 *  container, then offer to add the cards you don't own to the collection. */
export function ContainerImport({
  deckId,
  slots,
  noun,
  basicsAnyPrinting,
  initialText,
  onDone,
}: {
  deckId: string;
  /** What's already filed here (the page's own rows), so a second paste of the
   *  same list can say so instead of quietly doubling the deck. */
  slots: readonly { oracleId: string; board: DeckBoard; quantity: number }[];
  /** "deck" / "binder" / "box", for the wording. */
  noun: string;
  /** Decks pull their basics from the lands box; a binder or box holds real cards. */
  basicsAnyPrinting: boolean;
  /** A list that arrived on the clipboard: filled in and analyzed on sight,
   *  since pasting a decklist already said what you wanted done with it. */
  initialText?: string;
  onDone: (added: number) => void;
}) {
  const [overlap, setOverlap] = useState<OverlapMode>('add');
  // The written lines, waiting on the "you don't own these" tick-list.
  const [unowned, setUnowned] = useState<{ cards: UnownedCard[]; lines: ResolvedLine[]; added: number } | null>(null);
  const picked = useKeySet();
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const ownership = useOwnershipIndex();
  // Card + board only: a pasted line overlaps any slot of that card on that board.
  const overlapKey = (l: { oracleId: string; board?: DeckBoard }) => slotKey({ oracleId: l.oracleId, board: l.board ?? 'main' });
  const have = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of slots) map.set(overlapKey(s), (map.get(overlapKey(s)) ?? 0) + s.quantity);
    return map;
  }, [slots]);

  async function confirm(lines: ResolvedLine[]) {
    const wanted = applyOverlap(lines, overlap, have, overlapKey);
    if (wanted.length === 0) {
      toast(`Nothing added: every card was already in the ${noun}`);
      onDone(0);
      return;
    }
    // A pasted list's basics are the ones you'd fetch from the lands box, not
    // copies the list expects you to own — same default as adding them by hand.
    const oracles = basicsAnyPrinting ? await getOracleCardsByIds(wanted.map((l) => l.oracleId)) : null;
    const isAny = (l: ResolvedLine) => {
      const oracle = oracles?.get(l.oracleId);
      return !!oracle && isBasicLand(oracle);
    };
    await addDeckCardsBulk(
      deckId,
      wanted.map((l) => ({
        oracleId: l.oracleId,
        quantity: l.quantity,
        board: l.board ?? 'main',
        ...(isAny(l) ? { anyBasic: true } : { scryfallId: l.scryfallId }),
      })),
    );
    const added = sumQty(wanted);

    // Scanning a pile into a container has always offered to also register it
    // as owned; pasting the same list left the collection none the wiser and
    // the container full of "you don't own this" badges. Same question now.
    const real = wanted.filter((l) => !isAny(l));
    const missing = real.filter((l) => !ownership?.lookup(l.oracleId, l.scryfallId).ownsExact);
    if (missing.length === 0) {
      onDone(added);
      return;
    }
    const printings = await getPrintingsByIds(missing.map((l) => l.scryfallId));
    const cards: UnownedCard[] = missing.map((l) => {
      const p = printings.get(l.scryfallId);
      return {
        key: `${l.scryfallId}|${l.board ?? 'main'}`,
        name: l.name,
        ...(p?.imageSmall ? { image: p.imageSmall } : {}),
        sub: [p ? `${p.set.toUpperCase()} #${p.collectorNumber}` : null, l.lang, l.quantity > 1 ? `×${l.quantity}` : null]
          .filter(Boolean)
          .join(' · '),
        qty: l.quantity,
      };
    });
    picked.reset(cards.map((c) => c.key));
    setUnowned({ cards, lines: missing, added });
  }

  async function applyUnowned() {
    if (!unowned) return;
    setBusy(true);
    try {
      const chosen = unowned.lines.filter((l) => picked.has(`${l.scryfallId}|${l.board ?? 'main'}`));
      if (chosen.length) {
        await applyImport(chosen, { source: 'import', label: `Filled ${noun}` });
        const n = sumQty(chosen);
        toast(`Added ${n} ${plural(n, 'card')} to your collection`);
      }
      const added = unowned.added;
      setUnowned(null);
      onDone(added);
    } finally {
      setBusy(false);
    }
  }

  if (unowned) {
    return (
      <div className="about-section">
        <UnownedPromptSheet
          cards={unowned.cards}
          picked={picked.set}
          busy={busy}
          intro={
            <>
              {unowned.cards.length} {plural(unowned.cards.length, 'card')} in this list {' '}
              {unowned.cards.length === 1 ? "isn't" : "aren't"} in your collection. If the {noun} is real cardboard on
              your shelf, add {unowned.cards.length === 1 ? 'it' : 'them'} too:
            </>
          }
          confirmLabel={(q) => (q > 0 ? `Add ${q} to collection` : 'Not now')}
          backLabel="Skip"
          onToggle={picked.toggle}
          onToggleAll={() => picked.toggleAll(unowned.cards.map((c) => c.key))}
          onBack={() => {
            const added = unowned.added;
            setUnowned(null);
            onDone(added);
          }}
          onConfirm={() => void applyUnowned()}
        />
      </div>
    );
  }

  // A deck slot keys on oracle + board; the panel keeps each line's board and
  // resolved printing so the deck remembers which edition the list used.
  return (
    <ImportPanel
      board
      placeholder={'4 Lightning Bolt\n2 Counterspell\n\nSideboard\n3 Duress'}
      {...(initialText ? { initialText } : {})}
      onConfirm={confirm}
      confirmLabel={(n) => `Add ${n} entries to ${noun}`}
      aboveReview={(resolved) => {
        const already = resolved.filter((l) => (have.get(overlapKey(l)) ?? 0) > 0).length;
        return already > 0 && <OverlapChoice count={already} where={`in this ${noun}`} value={overlap} onChange={setOverlap} />;
      }}
    />
  );
}
