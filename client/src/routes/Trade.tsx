import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import type { CollectionEntry, OracleCard, Priced, Printing, Seat, TradeLine } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { collectionKey } from '../db/dataAccess.js';
import { getOracleCardsByIds, getPrintingsByIds, joinCollectionEntries } from '../db/queries.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { useCardSearch } from '../cardDb/useCardSearch.js';
import { CardSheet } from '../components/CardSheet.js';
import { formatPrice } from '../components/CardSorting.js';
import { CardItems, CardList, type CardItem } from '../components/CardViews.js';
import { CodeJoinForm } from '../components/CodeJoinForm.js';
import { Icon } from '../components/icons.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { useEscapeToClose } from '../components/useEscapeToClose.js';
import { TRADE_ENABLED } from '../trade/config.js';
import {
  clearPersistedTrade,
  getPersistedTrade,
  otherSeat,
  useTradeSession,
  type ActiveTrade,
} from '../trade/useTradeSession.js';

/** Offer lines merge on the same compound key as collection entries. */
const lineKey = collectionKey;

/** Per-oracle ownership summary, for the "do I actually have this?" indicators. */
interface Owned {
  qty: number;
  forTrade: number;
  /** A representative entry (prefers one marked for trade) for sensible add defaults. */
  entry: CollectionEntry;
}

function useOwnership(): Map<string, Owned> | undefined {
  return useLiveQuery(async () => {
    const entries = await db.collection.toArray();
    const map = new Map<string, Owned>();
    for (const e of entries) {
      const cur = map.get(e.oracleId);
      if (cur) {
        cur.qty += e.quantity;
        cur.forTrade += e.quantityForTrade;
        if (e.quantityForTrade > 0 && cur.entry.quantityForTrade === 0) cur.entry = e;
      } else {
        map.set(e.oracleId, { qty: e.quantity, forTrade: e.quantityForTrade, entry: e });
      }
    }
    return map;
  }, []);
}

/** ⇄ in tradelist / ✓ owned / ❓ not in collection. */
function ownIndicator(own: Owned | undefined): { icon: string; label: string; cls: string } {
  if (!own) return { icon: '❓', label: 'Not in your collection', cls: 'own-unknown' };
  if (own.forTrade > 0) return { icon: '⇄', label: `In your tradelist (${own.forTrade} for trade)`, cls: 'own-trade' };
  return { icon: '✓', label: `In your collection (×${own.qty}), but not marked for trade`, cls: 'own-yes' };
}

function OwnBadge({ own }: { own: Owned | undefined }) {
  const ind = ownIndicator(own);
  const text = !own ? 'not in collection' : own.forTrade > 0 ? `tradelist ×${own.forTrade}` : `owned ×${own.qty}`;
  return (
    <span className={`badge ${ind.cls}`} title={ind.label}>
      {ind.icon} {text}
    </span>
  );
}

/** What the card-info sheet should show when a trade line is tapped. */
type InfoTarget = { oracle: Priced<OracleCard>; scryfallId?: string };
type OpenInfo = (oracle: Priced<OracleCard>, scryfallId?: string) => void;
/** How many copies a wishlist wants of a given printing (0 = no match). */
type WantFn = (oracleId: string, scryfallId: string) => number;

/**
 * Wishlist⇄tradelist match rule: a wish with scryfallId null ("any printing")
 * matches every printing of that card; a wish for a specific printing matches
 * only that printing. Returns how many copies the wishlist wants of a given
 * (oracleId, scryfallId) — 0 means no match.
 */
function wishMatcher(lines: Array<{ oracleId: string; scryfallId: string | null; quantity: number }>): WantFn {
  const byOracle = new Map<string, Array<{ scryfallId: string | null; quantity: number }>>();
  for (const w of lines) {
    const list = byOracle.get(w.oracleId) ?? [];
    list.push({ scryfallId: w.scryfallId, quantity: w.quantity });
    byOracle.set(w.oracleId, list);
  }
  return (oracleId: string, scryfallId: string): number =>
    (byOracle.get(oracleId) ?? []).reduce(
      (sum, w) => sum + (w.scryfallId === null || w.scryfallId === scryfallId ? w.quantity : 0),
      0,
    );
}

/** Values below this (EUR) count as "the trade is even". */
const BALANCE_EPSILON = 0.5;

export function Trade() {
  const trade = useTradeSession();
  const [resumable, setResumable] = useState<ActiveTrade | null>(null);

  useEffect(() => {
    if (trade.status === 'idle') void getPersistedTrade().then((t) => setResumable(t ?? null));
  }, [trade.status]);

  if (!TRADE_ENABLED) {
    return (
      <Page title="Trade" subtitle="Trade in person: share a code, build offers, confirm after inspecting.">
        <EmptyState hint="Coming in a later update.">
          Trading needs a secure connection to the trade server, which isn’t configured for this build yet.
        </EmptyState>
      </Page>
    );
  }

  if (trade.status === 'idle' || trade.status === 'error') {
    return (
      <Page title="Trade" subtitle="Trade in person: share a code, build offers, confirm after inspecting.">
        {trade.error && <p className="gate-error">{trade.error}</p>}
        {resumable && (
          <div className="empty-state">
            <p>You have an unfinished trade ({resumable.code}).</p>
            <div className="confirm-row" style={{ justifyContent: 'center' }}>
              <button className="primary" onClick={() => trade.resume(resumable)}>
                Resume
              </button>
              <button onClick={() => { void clearPersistedTrade(); setResumable(null); }}>Discard</button>
            </div>
          </div>
        )}
        <div className="trade-actions">
          <button className="primary" onClick={trade.create}>
            Start a trade
          </button>
        </div>
        <CodeJoinForm label="Join code" submitLabel="Join" onSubmit={trade.join} />
      </Page>
    );
  }

  if (trade.status === 'connecting' || !trade.snapshot || !trade.seat) {
    return (
      <Page title="Trade">
        <p className="gate-msg">Connecting…</p>
      </Page>
    );
  }

  return <TradeBoard trade={trade} seat={trade.seat} />;
}

type SheetKind = 'add' | 'theirs' | 'balance';

function TradeBoard({ trade, seat }: { trade: ReturnType<typeof useTradeSession>; seat: Seat }) {
  const snap = trade.snapshot!;
  const peer = otherSeat(seat);
  const [myOffer, setMyOffer] = useState<TradeLine[]>([]);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const ownership = useOwnership();
  const inited = useRef(false);

  // On (re)connect, seed the local offer from the server snapshot once.
  useEffect(() => {
    if (!inited.current && snap.offers[seat].length > 0) {
      inited.current = true;
      setMyOffer(snap.offers[seat]);
    }
  }, [snap, seat]);

  const theirOffer = snap.offers[peer];
  const editable = snap.state !== 'completed' && snap.state !== 'cancelled';

  // Exchange wishlists + tradelists whenever the partner (re)appears, so
  // wishlist⇄tradelist matches surface without anyone pressing anything.
  const { requestWishlist, requestTradelist } = trade;
  useEffect(() => {
    if (trade.peerPresent) {
      requestWishlist();
      requestTradelist();
    }
  }, [trade.peerPresent, requestWishlist, requestTradelist]);

  function commit(next: TradeLine[]) {
    setMyOffer(next);
    trade.sendOffer(next);
  }

  function addLine(line: TradeLine, max: number) {
    const key = lineKey(line);
    const next = [...myOffer];
    const idx = next.findIndex((l) => lineKey(l) === key);
    if (idx >= 0) {
      if (next[idx]!.quantity >= max) return;
      next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
    } else next.push({ ...line, quantity: 1 });
    commit(next);
  }

  /** Add several lines at once (balance "Add all") — one commit, no stale-state races. */
  function addMany(adds: Array<{ line: TradeLine; count: number; max: number }>) {
    const next = [...myOffer];
    for (const { line, count, max } of adds) {
      const key = lineKey(line);
      const idx = next.findIndex((l) => lineKey(l) === key);
      if (idx >= 0) next[idx] = { ...next[idx]!, quantity: Math.min(max, next[idx]!.quantity + count) };
      else next.push({ ...line, quantity: Math.min(max, count) });
    }
    commit(next);
  }

  function setQty(key: string, qty: number) {
    const next = myOffer.map((l) => (lineKey(l) === key ? { ...l, quantity: qty } : l)).filter((l) => l.quantity > 0);
    commit(next);
  }

  // Printings (images + prices) and oracle cards for both offers.
  const { printMap, oracleMap } = useCardMaps([...myOffer, ...theirOffer]);
  const totalOf = (lines: TradeLine[]) =>
    lines.reduce((sum, l) => sum + (printMap?.get(l.scryfallId)?.priceEur ?? 0) * l.quantity, 0);
  const openInfo: OpenInfo = (oracle, scryfallId) => setInfo({ oracle, scryfallId });

  // Wishlist⇄tradelist matchers, both directions (for ⭐ badges and balance).
  const lists = useLiveQuery(async () => {
    const wish = await db.wishlist.toArray();
    const tradelist = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
    return { wish, tradelist };
  }, []);
  const theirWanted = useMemo(() => wishMatcher(trade.peerWishlist ?? []), [trade.peerWishlist]);
  const myWanted = useMemo(() => wishMatcher(lists?.wish ?? []), [lists?.wish]);
  const theyWantCount = (lists?.tradelist ?? []).filter((e) => theirWanted(e.oracleId, e.scryfallId) > 0).length;
  const iWantCount = (trade.peerTradelist ?? []).filter((l) => myWanted(l.oracleId, l.scryfallId) > 0).length;

  const myTotal = totalOf(myOffer);
  const theirTotal = totalOf(theirOffer);
  const diff = myTotal - theirTotal;

  const iAccepted = snap.accepted[seat];
  const peerAccepted = snap.accepted[peer];
  const iConfirmed = snap.confirmed[seat];
  const peerConfirmed = snap.confirmed[peer];

  if (snap.state === 'completed') {
    return (
      <Page title="Trade complete 🎉">
        <p className="gate-msg">Your collection has been updated.</p>
        <div className="trade-actions">
          <Link className="chip" to="/history">
            View trade history
          </Link>
          <button className="primary" onClick={trade.reset}>
            New trade
          </button>
        </div>
      </Page>
    );
  }
  if (snap.state === 'cancelled') {
    return (
      <Page title="Trade cancelled">
        <p className="gate-msg">No changes were made.</p>
        <button className="primary" onClick={trade.reset}>
          New trade
        </button>
      </Page>
    );
  }

  const barStatus =
    snap.state === 'agreed'
      ? iConfirmed
        ? 'You confirmed — waiting for them.'
        : peerConfirmed
          ? 'They confirmed. Inspect the cards, then confirm.'
          : 'Both accepted. Swap the cards, then confirm.'
      : iAccepted
        ? 'You accepted — waiting for them. Editing an offer resets acceptance.'
        : peerAccepted
          ? 'They accepted this deal. Accept to lock it in.'
          : trade.peerPresent
            ? 'Build the trade, then accept.'
            : 'Waiting for the other user to connect…';

  return (
    <Page
      title="Trade"
      menu={
        <OptionsMenu
          label="Trade options"
          actions={[
            { label: 'Refresh partner lists', icon: '↻', onClick: () => { requestWishlist(); requestTradelist(); } },
            { label: 'Cancel trade', icon: '✕', danger: true, onClick: trade.cancel },
          ]}
        />
      }
    >
      <div className="trade-status">
        <div>
          Code <strong className="trade-code">{snap.code}</strong>
        </div>
        <div className={trade.peerPresent ? 'presence-on' : 'presence-off'}>
          {snap.present[peer] ? 'Other User connected' : 'Waiting for other user…'}
        </div>
      </div>

      {(theyWantCount > 0 || iWantCount > 0) && (
        <div className="match-chips">
          {theyWantCount > 0 && (
            <button className="chip chip-wish" onClick={() => setSheet('add')}>
              ⭐ They want {theyWantCount} of your cards
            </button>
          )}
          {iWantCount > 0 && (
            <button className="chip chip-wish" onClick={() => setSheet('theirs')}>
              ⭐ You want {iWantCount} of theirs
            </button>
          )}
        </div>
      )}

      <div className="trade-board">
        <section className="trade-col" aria-label="Cards you give">
          <h3>You give</h3>
          <OfferColumn
            lines={myOffer}
            editable={editable}
            onQty={setQty}
            ownership={ownership}
            printings={printMap}
            oracles={oracleMap}
            onInfo={openInfo}
          />
          {myOffer.length === 0 && <p className="trade-empty">No cards yet.</p>}
          {editable && (
            <button className="trade-add" onClick={() => setSheet('add')}>
              <Icon name="plus" size={15} /> Add cards
            </button>
          )}
        </section>

        <div className="trade-rail" aria-label="Trade tools">
          <button
            className="rail-btn"
            title="Balance the trade"
            aria-label="Balance the trade"
            onClick={() => setSheet('balance')}
            disabled={!editable}
          >
            <Icon name="balance" />
          </button>
          <button
            className="rail-btn"
            title="Their tradelist"
            aria-label="View their tradelist"
            onClick={() => {
              setSheet('theirs');
              requestTradelist();
            }}
            disabled={!trade.peerPresent && trade.peerTradelist === null}
          >
            <Icon name="tradelist" />
          </button>
        </div>

        <section className="trade-col" aria-label="Cards you get">
          <h3>You get</h3>
          <OfferColumn lines={theirOffer} editable={false} printings={printMap} oracles={oracleMap} onInfo={openInfo} />
          {theirOffer.length === 0 && <p className="trade-empty">Nothing yet — they add cards on their device.</p>}
        </section>
      </div>

      <div className="trade-dock">
        <div className="trade-totals">
          <div className="trade-total" aria-label="Total you give">
            €{myTotal.toFixed(2)}
          </div>
          <DiffBadge diff={diff} />
          <div className="trade-total" aria-label="Total you get">
            €{theirTotal.toFixed(2)}
          </div>
        </div>

        <div className="trade-bar">
          <div className="trade-bar-status">{barStatus}</div>
          {snap.state === 'agreed' ? (
            <button className="primary" onClick={trade.confirmComplete} disabled={iConfirmed}>
              {iConfirmed ? 'Waiting…' : 'Confirm done'}
            </button>
          ) : iAccepted ? (
            <button onClick={trade.unaccept}>Un-accept</button>
          ) : (
            <button className="primary" onClick={trade.accept} disabled={myOffer.length + theirOffer.length === 0}>
              Accept trade
            </button>
          )}
        </div>
      </div>

      {sheet === 'add' && editable && (
        <TradeSheet title="Add to your offer" onClose={() => setSheet(null)}>
          <AddCardsPanel ownership={ownership} theirWanted={theirWanted} onAdd={addLine} onInfo={openInfo} />
        </TradeSheet>
      )}
      {sheet === 'theirs' && (
        <TradeSheet
          title={`Their tradelist${trade.peerTradelist ? ` (${trade.peerTradelist.length})` : ''}`}
          onClose={() => setSheet(null)}
        >
          <PeerTradelistPanel
            lines={trade.peerTradelist}
            loading={trade.peerTradelistLoading}
            myWanted={myWanted}
            onInfo={openInfo}
            onRefresh={requestTradelist}
          />
        </TradeSheet>
      )}
      {sheet === 'balance' && (
        <TradeSheet title="Balance the trade" onClose={() => setSheet(null)}>
          <BalancePanel
            diff={diff}
            myOffer={myOffer}
            theirOffer={theirOffer}
            peerTradelist={trade.peerTradelist}
            theirWanted={theirWanted}
            myWanted={myWanted}
            onAdd={addLine}
            onAddMany={(adds) => {
              addMany(adds);
              setSheet(null);
            }}
            onInfo={openInfo}
          />
        </TradeSheet>
      )}

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}

/** The value gap between the two columns, shown under the central rail. */
function DiffBadge({ diff }: { diff: number }) {
  const even = Math.abs(diff) < BALANCE_EPSILON;
  return (
    <div className={`trade-diff ${even ? 'diff-even' : 'diff-off'}`} aria-label="Value difference">
      <strong>€{Math.abs(diff).toFixed(2)}</strong>
      <span>{even ? 'balanced' : diff > 0 ? 'you give more' : 'you get more'}</span>
    </div>
  );
}

/** One column of the board: card tiles with per-card value (and ± for your own offer). */
function OfferColumn({
  lines,
  editable,
  onQty,
  ownership,
  printings,
  oracles,
  onInfo,
}: {
  lines: TradeLine[];
  editable: boolean;
  onQty?: (key: string, qty: number) => void;
  /** When given (own offer), each line shows an ownership indicator. */
  ownership?: Map<string, Owned>;
  printings: Map<string, Priced<Printing>> | undefined;
  oracles: Map<string, Priced<OracleCard>> | undefined;
  onInfo: OpenInfo;
}) {
  if (lines.length === 0) return null;
  return (
    <CardItems
      view="grid"
      items={lines.map((l): CardItem => {
        const ind = ownership ? ownIndicator(ownership.get(l.oracleId)) : null;
        const printing = printings?.get(l.scryfallId);
        const oracle = oracles?.get(l.oracleId);
        return {
          key: lineKey(l),
          name: l.name,
          image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
          count: l.quantity,
          badge: ind?.icon,
          badgeClass: ind?.cls,
          badgeTitle: ind?.label,
          onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
          actions: (
            <>
              {editable && onQty && (
                <button onClick={() => onQty(lineKey(l), l.quantity - 1)} aria-label="One fewer">
                  −
                </button>
              )}
              <span className="tile-price">{formatPrice(printing) ?? '—'}</span>
              {editable && onQty && (
                <button onClick={() => onQty(lineKey(l), l.quantity + 1)} aria-label="One more">
                  ＋
                </button>
              )}
            </>
          ),
        };
      })}
    />
  );
}

/** Generic bottom sheet for the trade tools (portals to <body>, like CardSheet). */
function TradeSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEscapeToClose(onClose);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-title-row">
          <strong>{title}</strong>
          <button className="chip" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A card that could help close the value gap. */
interface BalanceCandidate {
  key: string;
  line: TradeLine;
  max: number;
  name: string;
  price: number;
  /** Copies still available (tradelist quantity minus copies already offered). */
  qty: number;
  /** Copies the receiving side's wishlist asks for (0 = no match). */
  wanted: number;
  oracle: Priced<OracleCard> | undefined;
  printing: Priced<Printing> | undefined;
}

/**
 * Greedy best-fit: repeatedly pick the card that brings the remaining gap
 * closest to zero; stop when no card improves it. The pool is pre-sorted
 * wishlist-matches-first, so ties favor cards someone actually wants.
 */
function suggestBalance(gap: number, pool: BalanceCandidate[]): Map<string, number> {
  const picks = new Map<string, number>();
  let remaining = gap;
  for (let n = 0; n < 40; n++) {
    let best: BalanceCandidate | undefined;
    let bestAfter = Math.abs(remaining);
    for (const c of pool) {
      if ((picks.get(c.key) ?? 0) >= c.qty) continue;
      const after = Math.abs(remaining - c.price);
      if (after < bestAfter - 1e-9) {
        best = c;
        bestAfter = after;
      }
    }
    if (!best) break;
    picks.set(best.key, (picks.get(best.key) ?? 0) + 1);
    remaining -= best.price;
  }
  return picks;
}

/**
 * The scales button: suggests cards from the lighter side's tradelist to even
 * out the value. Your own suggestions can be added directly; for their side it
 * produces a list to show the partner (only they can edit their offer).
 */
function BalancePanel({
  diff,
  myOffer,
  theirOffer,
  peerTradelist,
  theirWanted,
  myWanted,
  onAdd,
  onAddMany,
  onInfo,
}: {
  diff: number;
  myOffer: TradeLine[];
  theirOffer: TradeLine[];
  peerTradelist: TradeLine[] | null;
  theirWanted: WantFn;
  myWanted: WantFn;
  onAdd: (line: TradeLine, max: number) => void;
  onAddMany: (adds: Array<{ line: TradeLine; count: number; max: number }>) => void;
  onInfo: OpenInfo;
}) {
  // My tradelist (with prices) plus display data for their tradelist.
  const data = useLiveQuery(async () => {
    const entries = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
    const peerLines = peerTradelist ?? [];
    const [printings, oracles] = await Promise.all([
      getPrintingsByIds([...entries.map((e) => e.scryfallId), ...peerLines.map((l) => l.scryfallId)]),
      getOracleCardsByIds([...entries.map((e) => e.oracleId), ...peerLines.map((l) => l.oracleId)]),
    ]);
    return { entries, printings, oracles };
  }, [(peerTradelist ?? []).map((l) => l.scryfallId).join(',')]);

  if (!data) return <p className="fine-print">Loading…</p>;

  const gap = Math.abs(diff);
  if (gap < BALANCE_EPSILON) {
    return <p className="fine-print">This trade is already balanced (difference €{gap.toFixed(2)}).</p>;
  }
  const iGiveMore = diff > 0;
  if (iGiveMore && peerTradelist === null) {
    return <p className="fine-print">You’re giving more, but their tradelist hasn’t arrived yet — try again in a moment.</p>;
  }

  // What's already in the lighter side's offer can't be suggested again.
  const offered = new Map<string, number>();
  for (const l of iGiveMore ? theirOffer : myOffer) {
    offered.set(lineKey(l), (offered.get(lineKey(l)) ?? 0) + l.quantity);
  }

  const pool: BalanceCandidate[] = (
    iGiveMore
      ? (peerTradelist ?? []).map((l): BalanceCandidate => {
          const printing = data.printings.get(l.scryfallId);
          const line = { ...l, quantity: 1 };
          return {
            key: lineKey(l),
            line,
            max: l.quantity,
            name: l.name,
            price: printing?.priceEur ?? 0,
            qty: l.quantity - (offered.get(lineKey(l)) ?? 0),
            wanted: myWanted(l.oracleId, l.scryfallId),
            oracle: data.oracles.get(l.oracleId),
            printing,
          };
        })
      : data.entries.map((e): BalanceCandidate => {
          const oracle = data.oracles.get(e.oracleId);
          const printing = data.printings.get(e.scryfallId);
          const line: TradeLine = {
            oracleId: e.oracleId,
            scryfallId: e.scryfallId,
            name: oracle?.name ?? '(unknown card)',
            quantity: 1,
            condition: e.condition,
            finish: e.finish,
            lang: e.lang,
          };
          return {
            key: lineKey(line),
            line,
            max: e.quantityForTrade,
            name: line.name,
            price: printing?.priceEur ?? 0,
            qty: e.quantityForTrade - (offered.get(lineKey(line)) ?? 0),
            wanted: theirWanted(e.oracleId, e.scryfallId),
            oracle,
            printing,
          };
        })
  )
    .filter((c) => c.qty > 0 && c.price > 0)
    .sort((a, b) => b.wanted - a.wanted || b.price - a.price);

  const picks = suggestBalance(gap, pool);
  const suggestions = pool.filter((c) => picks.has(c.key));
  if (suggestions.length === 0) {
    return (
      <p className="fine-print">
        Nothing on {iGiveMore ? 'their' : 'your'} tradelist (with a known price) can close the €{gap.toFixed(2)} gap.
      </p>
    );
  }

  const pickCount = suggestions.reduce((s, c) => s + picks.get(c.key)!, 0);
  const pickedTotal = suggestions.reduce((s, c) => s + c.price * picks.get(c.key)!, 0);
  const after = Math.abs(gap - pickedTotal);

  return (
    <>
      <p className="fine-print">
        {iGiveMore ? (
          <>
            You’re giving <strong>€{gap.toFixed(2)}</strong> more. From <strong>their</strong> tradelist, ask them to add:
          </>
        ) : (
          <>
            You’re getting <strong>€{gap.toFixed(2)}</strong> more. From <strong>your</strong> tradelist, you could add:
          </>
        )}
      </p>
      <CardList
        className="picker-scroll"
        items={suggestions.map((c): CardItem => {
          const oracle = c.oracle;
          return {
            key: c.key,
            name: c.name,
            image: c.printing?.imageSmall ?? oracle?.imageSmall ?? null,
            count: picks.get(c.key),
            badge: c.wanted > 0 ? '⭐' : undefined,
            badgeClass: 'badge-wish',
            badgeTitle:
              c.wanted > 0 ? (iGiveMore ? `On your wishlist (×${c.wanted})` : `They want ×${c.wanted}`) : undefined,
            sub: (
              <>
                {c.line.condition} · {c.line.finish}
              </>
            ),
            price: `€${c.price.toFixed(2)}`,
            onClick: oracle ? () => onInfo(oracle, c.line.scryfallId) : undefined,
            actions: !iGiveMore ? (
              <button title="Add to your offer" onClick={() => onAdd(c.line, c.max)}>
                ＋
              </button>
            ) : undefined,
          };
        })}
      />
      <p className="fine-print">
        Adds €{pickedTotal.toFixed(2)}, bringing the difference from €{gap.toFixed(2)} down to €{after.toFixed(2)}.
        Prices are EUR estimates; unpriced cards are skipped.
      </p>
      {iGiveMore ? (
        <p className="fine-print">Only they can add cards to their side — show them this list.</p>
      ) : (
        <button
          className="primary"
          onClick={() => onAddMany(suggestions.map((c) => ({ line: c.line, count: picks.get(c.key)!, max: c.max })))}
        >
          Add all ({pickCount} {pickCount === 1 ? 'card' : 'cards'})
        </button>
      )}
    </>
  );
}

/**
 * Add cards to the offer: with no query, quick-picks from your tradelist
 * (partner-wishlist matches starred and sorted first); typing searches the
 * whole card database (you can offer cards you haven't registered — they get
 * a ❓ indicator).
 */
function AddCardsPanel({
  ownership,
  theirWanted,
  onAdd,
  onInfo,
}: {
  ownership: Map<string, Owned> | undefined;
  theirWanted: WantFn;
  onAdd: (line: TradeLine, max: number) => void;
  onInfo: OpenInfo;
}) {
  const [q, setQ] = useState('');
  const { results } = useCardSearch(q, { limit: 20 });

  const tradelist = useLiveQuery(async () => {
    const entries = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
    return joinCollectionEntries(entries);
  }, []);

  const addFromSearch = (card: OracleCard) => {
    const own = ownership?.get(card.oracleId);
    const e = own?.entry;
    onAdd(
      e
        ? { oracleId: e.oracleId, scryfallId: e.scryfallId, name: card.name, quantity: 1, condition: e.condition, finish: e.finish, lang: e.lang }
        : { oracleId: card.oracleId, scryfallId: card.defaultScryfallId, name: card.name, quantity: 1, condition: 'NM', finish: 'nonfoil', lang: 'en' },
      999,
    );
  };

  const sortedTradelist = (tradelist ?? [])
    .map((t) => ({ ...t, wanted: theirWanted(t.entry.oracleId, t.entry.scryfallId) }))
    .sort((a, b) => b.wanted - a.wanted);

  return (
    <div className="picker-panel">
      <input
        className="search-input"
        placeholder="Search any card…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search cards to add"
      />
      {q.trim() ? (
        results.length === 0 ? (
          <p className="fine-print">No cards match.</p>
        ) : (
          <CardList
            className="picker-scroll"
            items={results.map(
              (c): CardItem => ({
                key: c.oracleId,
                name: c.name,
                image: c.imageSmall ?? null,
                sub: (
                  <>
                    {c.typeLine} <OwnBadge own={ownership?.get(c.oracleId)} />
                  </>
                ),
                onClick: () => onInfo(c),
                actions: (
                  <button title="Add to offer" onClick={() => addFromSearch(c)}>
                    ＋
                  </button>
                ),
              }),
            )}
          />
        )
      ) : !tradelist ? (
        <p className="fine-print">Loading tradelist…</p>
      ) : tradelist.length === 0 ? (
        <p className="fine-print">Your tradelist is empty — search above to add any card.</p>
      ) : (
        <>
          <p className="fine-print">From your tradelist (or search above for any card):</p>
          <CardList
            className="picker-scroll"
            items={sortedTradelist.map(({ entry: e, oracle, printing, wanted }): CardItem => {
              const name = oracle?.name ?? '(unknown card)';
              return {
                key: e.id,
                name,
                image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
                badge: wanted > 0 ? '⭐' : undefined,
                badgeClass: 'badge-wish',
                badgeTitle: wanted > 0 ? `They want ×${wanted}` : undefined,
                sub: (
                  <>
                    {e.condition} · {e.finish} · {e.quantityForTrade} for trade
                    {wanted > 0 ? ` · they want ×${wanted}` : ''}
                  </>
                ),
                price: formatPrice(printing),
                onClick: oracle ? () => onInfo(oracle, e.scryfallId) : undefined,
                actions: (
                  <button
                    title="Add to offer"
                    onClick={() =>
                      onAdd(
                        { oracleId: e.oracleId, scryfallId: e.scryfallId, name, quantity: 1, condition: e.condition, finish: e.finish, lang: e.lang },
                        e.quantityForTrade,
                      )
                    }
                  >
                    ＋
                  </button>
                ),
              };
            })}
          />
        </>
      )}
    </div>
  );
}

/** The partner's tradelist (view-only), your wishlist matches starred and sorted first. */
function PeerTradelistPanel({
  lines,
  loading,
  myWanted,
  onInfo,
  onRefresh,
}: {
  lines: TradeLine[] | null;
  loading: boolean;
  myWanted: WantFn;
  onInfo: OpenInfo;
  onRefresh: () => void;
}) {
  // Their lines reference cards by id; the local card DB has the display data.
  const { printMap, oracleMap } = useCardMaps(lines ?? []);

  const sorted = [...(lines ?? [])]
    .map((l) => ({ l, wanted: myWanted(l.oracleId, l.scryfallId) }))
    .sort((a, b) => b.wanted - a.wanted);

  return (
    <div className="picker-panel">
      <div className="meta-row">
        <span className="fine-print">Ask them to add cards you want to their offer.</span>
        <button className="chip" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>
      {!lines ? (
        <p className="fine-print">{loading ? 'Waiting for their tradelist…' : 'No tradelist received yet.'}</p>
      ) : lines.length === 0 ? (
        <p className="fine-print">Their tradelist is empty.</p>
      ) : (
        <CardList
          className="picker-scroll"
          items={sorted.map(({ l, wanted }): CardItem => {
            const printing = printMap?.get(l.scryfallId);
            const oracle = oracleMap?.get(l.oracleId);
            return {
              key: lineKey(l),
              name: l.name,
              image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
              count: l.quantity,
              badge: wanted > 0 ? '⭐' : undefined,
              badgeClass: 'badge-wish',
              badgeTitle: wanted > 0 ? `On your wishlist (×${wanted})` : undefined,
              sub: (
                <>
                  {l.condition} · {l.finish}
                  {l.lang !== 'en' ? ` · ${l.lang}` : ''}
                  {wanted > 0 ? ` · you want ×${wanted}` : ''}
                </>
              ),
              price: formatPrice(printing),
              onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
            };
          })}
        />
      )}
    </div>
  );
}
