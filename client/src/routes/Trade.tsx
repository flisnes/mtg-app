import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import type { CollectionEntry, OracleCard, Priced, Printing, Seat, TradeLine, WishLine } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { searchCards } from '../cardDb/search.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, CardList, ViewToggle, useViewMode, type CardItem, type ViewMode } from '../components/CardViews.js';
import { TRADE_ENABLED } from '../trade/config.js';
import {
  getPersistedTrade,
  otherSeat,
  useTradeSession,
  type ActiveTrade,
} from '../trade/useTradeSession.js';

const lineKey = (l: { scryfallId: string; condition: string; finish: string; lang: string }) =>
  `${l.scryfallId}|${l.condition}|${l.finish}|${l.lang}`;

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

function linePrice(p?: Priced<Printing>): string | undefined {
  if (p?.priceEur != null) return `€${p.priceEur.toFixed(2)}`;
  if (p?.priceUsd != null) return `$${p.priceUsd.toFixed(2)}`;
  return undefined;
}

export function Trade() {
  const trade = useTradeSession();
  const [joinCode, setJoinCode] = useState('');
  const [resumable, setResumable] = useState<ActiveTrade | null>(null);

  useEffect(() => {
    if (trade.status === 'idle') void getPersistedTrade().then((t) => setResumable(t ?? null));
  }, [trade.status]);

  if (!TRADE_ENABLED) {
    return (
      <Page title="Trade" subtitle="Trade in person: share a code, build offers, confirm after inspecting.">
        <EmptyState phase="a later update">
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
              <button onClick={() => { void db.settings.delete('activeTrade'); setResumable(null); }}>Discard</button>
            </div>
          </div>
        )}
        <div className="trade-actions">
          <button className="primary" onClick={trade.create}>
            Start a trade
          </button>
        </div>
        <div className="list-toolbar">
          <input
            className="search-input grow"
            placeholder="Enter code…"
            value={joinCode}
            maxLength={6}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            aria-label="Join code"
          />
          <button onClick={() => trade.join(joinCode)} disabled={joinCode.length < 6}>
            Join
          </button>
        </div>
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

function TradeBoard({ trade, seat }: { trade: ReturnType<typeof useTradeSession>; seat: Seat }) {
  const snap = trade.snapshot!;
  const peer = otherSeat(seat);
  const [myOffer, setMyOffer] = useState<TradeLine[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showTheirs, setShowTheirs] = useState(false);
  const [view, setView] = useViewMode();
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

  function setQty(key: string, qty: number) {
    const next = myOffer.map((l) => (lineKey(l) === key ? { ...l, quantity: qty } : l)).filter((l) => l.quantity > 0);
    commit(next);
  }

  // Printings (images + prices) and oracle cards for both offers.
  const scryfallIds = [...myOffer, ...theirOffer].map((l) => l.scryfallId);
  const oracleIds = [...myOffer, ...theirOffer].map((l) => l.oracleId);
  const printMap = useLiveQuery(() => getPrintingsByIds(scryfallIds), [scryfallIds.join(',')]);
  const oracleMap = useLiveQuery(() => getOracleCardsByIds(oracleIds), [oracleIds.join(',')]);
  const totalOf = (lines: TradeLine[]) =>
    lines.reduce((sum, l) => sum + (printMap?.get(l.scryfallId)?.priceEur ?? 0) * l.quantity, 0);
  const openInfo = (oracle: Priced<OracleCard>, scryfallId?: string) => setInfo({ oracle, scryfallId });

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

  return (
    <Page title="Trade">
      <div className="trade-status">
        <div>
          Code <strong className="trade-code">{snap.code}</strong>
        </div>
        <div className={trade.peerPresent ? 'presence-on' : 'presence-off'}>
          {snap.present[peer] ? 'Other User connected' : 'Waiting for other user…'}
        </div>
      </div>

      <div className="meta-row">
        <p className="search-meta">Tap a card for details.</p>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      <MatchesPanel
        peerWishlist={trade.peerWishlist}
        peerTradelist={trade.peerTradelist}
        view={view}
        editable={editable}
        onAdd={addLine}
        onInfo={openInfo}
      />

      <div className="offer-panes">
        <div className="offer-pane">
          <h3>
            Your offer <span className="badge">€{totalOf(myOffer).toFixed(2)}</span>
          </h3>
          <OfferList
            lines={myOffer}
            editable={editable}
            onQty={setQty}
            ownership={ownership}
            view={view}
            printings={printMap}
            oracles={oracleMap}
            onInfo={openInfo}
          />
          {editable && (
            <button onClick={() => setShowPicker((s) => !s)}>{showPicker ? 'Done adding' : '＋ Add cards'}</button>
          )}
          {showPicker && editable && <AddCardsPanel ownership={ownership} onAdd={addLine} onInfo={openInfo} />}
        </div>

        <div className="offer-pane">
          <h3>
            Other User’s offer <span className="badge">€{totalOf(theirOffer).toFixed(2)}</span>
          </h3>
          <OfferList lines={theirOffer} editable={false} view={view} printings={printMap} oracles={oracleMap} onInfo={openInfo} />
          <p className="fine-print">{peerAccepted ? '✓ they accepted' : '…not accepted yet'}</p>
          {showTheirs ? (
            <PeerTradelistPanel
              lines={trade.peerTradelist}
              loading={trade.peerTradelistLoading}
              view={view}
              onInfo={openInfo}
              onRefresh={trade.requestTradelist}
              onHide={() => setShowTheirs(false)}
            />
          ) : (
            <>
              <button
                disabled={!trade.peerPresent}
                onClick={() => {
                  setShowTheirs(true);
                  trade.requestTradelist();
                }}
              >
                View their tradelist
              </button>
              <p className="fine-print">Either side can ask to see the other’s tradelist during a trade.</p>
            </>
          )}
        </div>
      </div>

      <div className="trade-footer">
        {snap.state === 'agreed' ? (
          <>
            <p className="gate-msg">Both accepted. Inspect the cards, then confirm.</p>
            <div className="trade-actions">
              <button onClick={trade.cancel}>Cancel</button>
              <button className="primary" onClick={trade.confirmComplete} disabled={iConfirmed}>
                {iConfirmed ? 'Waiting for other…' : 'Confirm completed'}
              </button>
            </div>
            <p className="fine-print">
              {iConfirmed ? 'You confirmed. ' : ''}
              {peerConfirmed ? 'Other User confirmed.' : 'Other User has not confirmed yet.'}
            </p>
          </>
        ) : (
          <div className="trade-actions">
            <button onClick={trade.cancel}>Cancel</button>
            {iAccepted ? (
              <button className="primary" onClick={trade.unaccept}>
                Un-accept ({peerAccepted ? 'they accepted' : 'waiting for them'})
              </button>
            ) : (
              <button className="primary" onClick={trade.accept}>
                Accept offers
              </button>
            )}
          </div>
        )}
      </div>

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}

function OfferList({
  lines,
  editable,
  onQty,
  ownership,
  view,
  printings,
  oracles,
  onInfo,
}: {
  lines: TradeLine[];
  editable: boolean;
  onQty?: (key: string, qty: number) => void;
  /** When given (own offer), each line shows an ownership indicator. */
  ownership?: Map<string, Owned>;
  view: ViewMode;
  printings: Map<string, Priced<Printing>> | undefined;
  oracles: Map<string, Priced<OracleCard>> | undefined;
  onInfo: (oracle: Priced<OracleCard>, scryfallId?: string) => void;
}) {
  if (lines.length === 0) return <p className="fine-print">No cards yet.</p>;
  return (
    <CardItems
      view={view}
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
          sub: (
            <>
              {l.condition} · {l.finish}
              {l.lang !== 'en' ? ` · ${l.lang}` : ''}
            </>
          ),
          price: linePrice(printing),
          onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
          actions:
            editable && onQty ? (
              <>
                <button onClick={() => onQty(lineKey(l), l.quantity - 1)} aria-label="One fewer">−</button>
                <button onClick={() => onQty(lineKey(l), l.quantity + 1)} aria-label="One more">＋</button>
              </>
            ) : undefined,
        };
      })}
    />
  );
}

/**
 * Wishlist⇄tradelist matches, both directions: cards on your tradelist that
 * the partner wishes for, and cards on their tradelist that you wish for.
 * Lists are exchanged automatically once both sides are connected.
 */
function MatchesPanel({
  peerWishlist,
  peerTradelist,
  view,
  editable,
  onAdd,
  onInfo,
}: {
  peerWishlist: WishLine[] | null;
  peerTradelist: TradeLine[] | null;
  view: ViewMode;
  editable: boolean;
  onAdd: (line: TradeLine, max: number) => void;
  onInfo: (oracle: Priced<OracleCard>, scryfallId?: string) => void;
}) {
  // My tradelist entries (with display data) and my wishlist wants per oracle.
  const mine = useLiveQuery(async () => {
    const entries = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
    const wish = await db.wishlist.toArray();
    const [oracles, printings] = await Promise.all([
      getOracleCardsByIds(entries.map((e) => e.oracleId)),
      getPrintingsByIds(entries.map((e) => e.scryfallId)),
    ]);
    const wishQty = new Map<string, number>();
    for (const w of wish) wishQty.set(w.oracleId, (wishQty.get(w.oracleId) ?? 0) + w.quantity);
    return { entries, oracles, printings, wishQty };
  }, []);

  // How many copies the partner wishes for, per oracle card.
  const theirWishQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of peerWishlist ?? []) m.set(w.oracleId, (m.get(w.oracleId) ?? 0) + w.quantity);
    return m;
  }, [peerWishlist]);

  // Display data for the partner's tradelist lines.
  const theirs = useLiveQuery(async () => {
    const lines = peerTradelist ?? [];
    const [oracles, printings] = await Promise.all([
      getOracleCardsByIds(lines.map((l) => l.oracleId)),
      getPrintingsByIds(lines.map((l) => l.scryfallId)),
    ]);
    return { oracles, printings };
  }, [(peerTradelist ?? []).map((l) => l.scryfallId).join(',')]);

  if (!mine) return null;
  const theyWant = peerWishlist === null ? [] : mine.entries.filter((e) => theirWishQty.has(e.oracleId));
  const iWant = (peerTradelist ?? []).filter((l) => mine.wishQty.has(l.oracleId));

  // Quiet until both lists have arrived; then either the matches or one line.
  if (peerWishlist === null && peerTradelist === null) return null;
  if (theyWant.length === 0 && iWant.length === 0) {
    if (peerWishlist === null || peerTradelist === null) return null;
    return <p className="fine-print">No wishlist matches between you two.</p>;
  }

  return (
    <div className="offer-pane matches-pane">
      <h3>
        Wishlist matches <span className="badge badge-wish">⭐ {theyWant.length + iWant.length}</span>
      </h3>
      {theyWant.length > 0 && (
        <>
          <p className="fine-print">You have — they want:</p>
          <CardItems
            view={view}
            items={theyWant.map((e): CardItem => {
              const oracle = mine.oracles.get(e.oracleId);
              const printing = mine.printings.get(e.scryfallId);
              const name = oracle?.name ?? '(unknown card)';
              const wanted = theirWishQty.get(e.oracleId) ?? 1;
              return {
                key: e.id,
                name,
                image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
                count: e.quantityForTrade,
                badge: '⭐',
                badgeClass: 'badge-wish',
                badgeTitle: `They want ×${wanted}`,
                sub: (
                  <>
                    {e.condition} · {e.finish} · they want ×{wanted}
                  </>
                ),
                price: linePrice(printing),
                onClick: oracle ? () => onInfo(oracle, e.scryfallId) : undefined,
                actions: editable ? (
                  <button
                    title="Add to your offer"
                    onClick={() =>
                      onAdd(
                        { oracleId: e.oracleId, scryfallId: e.scryfallId, name, quantity: 1, condition: e.condition, finish: e.finish, lang: e.lang },
                        e.quantityForTrade,
                      )
                    }
                  >
                    ＋
                  </button>
                ) : undefined,
              };
            })}
          />
        </>
      )}
      {iWant.length > 0 && (
        <>
          <p className="fine-print">They have — you want:</p>
          <CardItems
            view={view}
            items={iWant.map((l): CardItem => {
              const oracle = theirs?.oracles.get(l.oracleId);
              const printing = theirs?.printings.get(l.scryfallId);
              const wanted = mine.wishQty.get(l.oracleId) ?? 1;
              return {
                key: lineKey(l),
                name: l.name,
                image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
                count: l.quantity,
                badge: '⭐',
                badgeClass: 'badge-wish',
                badgeTitle: `On your wishlist (×${wanted})`,
                sub: (
                  <>
                    {l.condition} · {l.finish} · {l.quantity} for trade · you want ×{wanted}
                  </>
                ),
                price: linePrice(printing),
                onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
              };
            })}
          />
          <p className="fine-print">Ask them to add these to their offer.</p>
        </>
      )}
    </div>
  );
}

/**
 * Add cards to the offer: with no query, quick-picks from your tradelist;
 * typing searches the whole card database (you can offer cards you haven't
 * registered — they get a ❓ indicator).
 */
function AddCardsPanel({
  ownership,
  onAdd,
  onInfo,
}: {
  ownership: Map<string, Owned> | undefined;
  onAdd: (line: TradeLine, max: number) => void;
  onInfo: (oracle: Priced<OracleCard>, scryfallId?: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Priced<OracleCard>[]>([]);

  const tradelist = useLiveQuery(async () => {
    const entries = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
    const oracleMap = await getOracleCardsByIds(entries.map((e) => e.oracleId));
    return entries.map((e) => ({ e, oracle: oracleMap.get(e.oracleId) }));
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const h = setTimeout(async () => setResults((await searchCards(q, {}, 20)).cards), 120);
    return () => clearTimeout(h);
  }, [q]);

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
            items={tradelist.map(({ e, oracle }): CardItem => {
              const name = oracle?.name ?? '(unknown card)';
              return {
                key: e.id,
                name,
                image: oracle?.imageSmall ?? null,
                sub: (
                  <>
                    {e.condition} · {e.finish} · {e.quantityForTrade} for trade
                  </>
                ),
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

/** The partner's tradelist, shown on request (view-only). */
function PeerTradelistPanel({
  lines,
  loading,
  view,
  onInfo,
  onRefresh,
  onHide,
}: {
  lines: TradeLine[] | null;
  loading: boolean;
  view: ViewMode;
  onInfo: (oracle: Priced<OracleCard>, scryfallId?: string) => void;
  onRefresh: () => void;
  onHide: () => void;
}) {
  // Their lines reference cards by id; the local card DB has the display data.
  const printMap = useLiveQuery(
    () => getPrintingsByIds((lines ?? []).map((l) => l.scryfallId)),
    [(lines ?? []).map((l) => l.scryfallId).join(',')],
  );
  const oracleMap = useLiveQuery(
    () => getOracleCardsByIds((lines ?? []).map((l) => l.oracleId)),
    [(lines ?? []).map((l) => l.oracleId).join(',')],
  );
  return (
    <div className="picker-panel">
      <div className="meta-row">
        <strong>Their tradelist{lines ? ` (${lines.length})` : ''}</strong>
        <span>
          <button className="chip" onClick={onRefresh} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>{' '}
          <button className="chip" onClick={onHide}>
            Hide
          </button>
        </span>
      </div>
      {!lines ? (
        <p className="fine-print">{loading ? 'Waiting for their tradelist…' : 'No tradelist received yet.'}</p>
      ) : lines.length === 0 ? (
        <p className="fine-print">Their tradelist is empty.</p>
      ) : (
        <CardItems
          view={view}
          className="picker-scroll"
          items={lines.map((l): CardItem => {
            const printing = printMap?.get(l.scryfallId);
            const oracle = oracleMap?.get(l.oracleId);
            return {
              key: lineKey(l),
              name: l.name,
              image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
              count: l.quantity,
              sub: (
                <>
                  {l.condition} · {l.finish} · {l.quantity} for trade
                  {l.lang !== 'en' ? ` · ${l.lang}` : ''}
                </>
              ),
              price: linePrice(printing),
              onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
            };
          })}
        />
      )}
    </div>
  );
}
