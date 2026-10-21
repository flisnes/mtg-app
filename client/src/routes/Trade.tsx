import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { CODE_LENGTH, wishCountMatcher, type OracleCard, type Priced, type Seat, type TradeLine } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { collectionKey } from '../db/dataAccess.js';
import { useWishes } from '../db/collectionSnapshot.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { CardSheet, type SessionCardValues } from '../components/CardSheet.js';
import { pricedForFinish } from '../components/CardSorting.js';
import { fmtEur } from '../price/rates.js';
import { ViewToggle, useTradeViewMode } from '../components/CardViews.js';
import { Icon } from '../components/icons.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheetLazy.js';
import { Sheet } from '../components/Sheet.js';
import { clearTradeScanSessions } from '../scan/tradeSessions.js';
import { TradeQr } from '../components/TradeQr.js';
import { useDismiss } from '../components/useDismiss.js';
import { tradeEnabled } from '../trade/config.js';
import { useTradePriceRefresh } from '../trade/usePriceRefresh.js';
import { otherSeat, useTradeSession, type TradeSession } from '../trade/useTradeSession.js';
import {
  BALANCE_EPSILON,
  bestAddDefault,
  bestPeerLine,
  lineKey,
  ownIndicator,
  useOwnTradeLines,
  type InfoTarget,
  type OpenInfo,
  type Side,
} from '../trade/board.js';
import { ReconnectBanner, TRADE_SUBTITLE, TradeConnecting, TradeHome } from '../trade/TradeHome.js';
import { OfferPanel } from '../trade/OfferPanel.js';
import { BalancePanel } from '../trade/BalancePanel.js';
import { QuickPickPanel } from '../trade/QuickPickPanel.js';
import { plural } from '../util/format.js';

export function Trade() {
  const trade = useTradeSession();
  // Creator chose "Start ahead": show the board while the seat is still open.
  // Not reset on 'connecting': a mid-trade reconnect keeps the board up, and
  // dropping "Start ahead" there would flip the creator back to the invite.
  const [startedAhead, setStartedAhead] = useState(false);
  useEffect(() => {
    if (trade.status === 'idle' || trade.status === 'error') setStartedAhead(false);
  }, [trade.status]);

  // Deep link from a scanned invite QR (#/trade?join=CODE): join right away —
  // scanning *is* the join gesture, no extra tap. The param is consumed once
  // and stripped so a reload doesn't re-join a dead session.
  const [searchParams, setSearchParams] = useSearchParams();
  const joinParam = searchParams.get('join');
  const { status, join } = trade;
  useEffect(() => {
    if (!tradeEnabled() || !joinParam) return;
    // The status gate is also the re-entry guard: once join() flips us to
    // 'connecting' this can't fire again. No ref — StrictMode's double-invoke
    // must re-join, because the hook's unmount cleanup closed the first socket.
    if (status !== 'idle' && status !== 'error') return;
    setSearchParams({}, { replace: true });
    const code = joinParam.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
    if (code.length === CODE_LENGTH) join(code);
  }, [joinParam, status, join, setSearchParams]);

  if (!tradeEnabled()) {
    return (
      <Page title="Trade" subtitle={TRADE_SUBTITLE}>
        <EmptyState hint="Coming in a later update.">
          Trading needs a secure connection to the trade server, which isn’t configured for this build yet.
        </EmptyState>
      </Page>
    );
  }

  if (trade.status === 'idle' || trade.status === 'error') return <TradeHome trade={trade} />;

  // No session yet. A session that drops and reconnects keeps its snapshot,
  // so it skips this and stays on the board under a "Reconnecting" banner.
  if (!trade.snapshot || !trade.seat) return <TradeConnecting trade={trade} />;

  // Freshly created, partner seat still empty: show the invite full-screen.
  // Pairing flips state to 'paired', which lands on the board automatically.
  if (trade.snapshot.state === 'open' && !startedAhead) {
    return (
      <Page title="Trade" subtitle="Have your trade partner scan the QR code, or type in the code.">
        <ReconnectBanner trade={trade} />
        <TradeQr code={trade.snapshot.code} />
        <div className="trade-actions">
          <button className="primary" onClick={() => setStartedAhead(true)}>
            Start ahead
          </button>
          <button onClick={trade.cancel}>Cancel</button>
        </div>
        <p className="fine-print">
          Start ahead to add cards while you wait; they can join whenever they’re ready.
        </p>
      </Page>
    );
  }

  return <TradeBoard trade={trade} seat={trade.seat} />;
}

type SheetKind = Side | 'balance';

function TradeBoard({ trade, seat }: { trade: TradeSession; seat: Seat }) {
  const snap = trade.snapshot!;
  const solo = trade.solo;
  const peer = otherSeat(seat);
  // Server-authoritative offers, mirrored locally so edits render instantly.
  // Either participant may edit either side (you usually hold each other's
  // binders), so every snapshot — including echoes of our own edits — simply
  // replaces the mirror.
  const [offers, setOffers] = useState<Record<Seat, TradeLine[]>>(snap.offers);
  useEffect(() => setOffers(snap.offers), [snap.offers]);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [showQr, setShowQr] = useState(false);
  // The invite QR's job is done once the seat fills — drop the sheet.
  useEffect(() => {
    if (snap.state !== 'open') setShowQr(false);
  }, [snap.state]);
  const [scanFor, setScanFor] = useState<Side | null>(null);
  const [info, setInfo] = useState<InfoTarget | null>(null);
  // A card being added by search/quick-pick: the sheet picks its edition/
  // condition/finish/language/quantity before it lands in the offer. `prefill`
  // seeds those from the best guess (an owned copy, or their tradelist line).
  const [composing, setComposing] = useState<{
    side: Side;
    oracle: Priced<OracleCard>;
    prefill?: Partial<SessionCardValues>;
  } | null>(null);
  // An offer line being edited in place: the same sheet, seeded from the line,
  // writing edition/condition/finish/language/quantity back through onApply.
  const [editingLine, setEditingLine] = useState<{ side: Side; line: TradeLine; oracle: Priced<OracleCard> } | null>(null);
  const ownership = useOwnershipIndex();

  const seatOf = (side: Side): Seat => (side === 'give' ? seat : peer);
  const myOffer = offers[seat];
  const theirOffer = offers[peer];
  const editable = snap.state !== 'completed' && snap.state !== 'cancelled';

  // Both sides price the offer from their own local shards, so an app that has
  // been open for a week quietly disagrees with its partner about what the trade
  // is worth. Opening a live session pulls today's prices.
  const { refreshing: pricesRefreshing, epoch: priceEpoch } = useTradePriceRefresh(editable);

  // Once the trade lands, check whether any card we gave away is still stuck
  // in a filing conflict — a copy filed in two places at once, so the app
  // couldn't tell which one just left. Everything else resolves itself.
  const placements = usePlacementIndex();
  const givenKeys = useMemo(() => new Set(myOffer.map((l) => collectionKey(l))), [myOffer]);
  const tradeConflicts = useMemo(
    () => (placements?.conflicts ?? []).filter((c) => givenKeys.has(collectionKey(c))),
    [placements, givenKeys],
  );

  // An interrupted scan is only worth keeping while its trade is still open:
  // sweep every other trade's leftovers, and this one's once the deal is done.
  useEffect(() => {
    clearTradeScanSessions(editable ? snap.sessionId : undefined);
  }, [snap.sessionId, editable]);

  // Exchange wishlists + tradelists whenever the partner (re)appears, so
  // wishlist⇄tradelist matches surface without anyone pressing anything.
  const { requestWishlist, requestTradelist } = trade;
  useEffect(() => {
    if (trade.peerPresent) {
      requestWishlist();
      requestTradelist();
    }
  }, [trade.peerPresent, requestWishlist, requestTradelist]);

  function commit(side: Side, next: TradeLine[]) {
    const s = seatOf(side);
    setOffers((cur) => ({ ...cur, [s]: next }));
    trade.sendOffer(s, next);
  }

  function addLine(side: Side, line: TradeLine, max: number) {
    const key = lineKey(line);
    const next = [...offers[seatOf(side)]];
    const idx = next.findIndex((l) => lineKey(l) === key);
    if (idx >= 0) {
      if (next[idx]!.quantity >= max) return;
      next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
    } else next.push({ ...line, quantity: 1 });
    commit(side, next);
  }

  /** Add several lines at once (balance "Add all") — one commit, no stale-state races. */
  function addMany(side: Side, adds: Array<{ line: TradeLine; count: number; max: number }>) {
    const next = [...offers[seatOf(side)]];
    for (const { line, count, max } of adds) {
      const key = lineKey(line);
      const idx = next.findIndex((l) => lineKey(l) === key);
      if (idx >= 0) next[idx] = { ...next[idx]!, quantity: Math.min(max, next[idx]!.quantity + count) };
      else next.push({ ...line, quantity: Math.min(max, count) });
    }
    commit(side, next);
  }

  function setQty(side: Side, key: string, qty: number) {
    const next = offers[seatOf(side)]
      .map((l) => (lineKey(l) === key ? { ...l, quantity: qty } : l))
      .filter((l) => l.quantity > 0);
    commit(side, next);
  }

  // Printings (images + prices) and oracle cards for both offers.
  const cards = useCardMaps([...myOffer, ...theirOffer], priceEpoch);
  const { printMap } = cards;
  const [view, setView] = useTradeViewMode();
  const eurOf = (l: TradeLine) => pricedForFinish(printMap?.get(l.scryfallId), l.finish)?.priceEur ?? 0;
  const totalOf = (lines: TradeLine[]) => lines.reduce((sum, l) => sum + eurOf(l) * l.quantity, 0);
  const openInfo: OpenInfo = (oracle, scryfallId, ctx) => setInfo({ oracle, scryfallId, ctx });

  // Editions "the relevant person" has, for the info sheet's edition dropdown:
  // my collection when looking at a "you give" card, their tradelist for "you get".
  function infoHighlights(target: InfoTarget): { label: string; notes: Map<string, string> } | undefined {
    if (!target.ctx) return undefined;
    if (target.ctx.side === 'give') {
      const entries = ownership?.ownedCopies(target.oracle.oracleId) ?? [];
      if (entries.length === 0) return undefined;
      const per = new Map<string, { qty: number; forTrade: number }>();
      for (const e of entries) {
        const cur = per.get(e.scryfallId) ?? { qty: 0, forTrade: 0 };
        cur.qty += e.quantity;
        cur.forTrade += e.quantityForTrade;
        per.set(e.scryfallId, cur);
      }
      const notes = new Map(
        [...per].map(([id, v]) => [id, v.forTrade > 0 ? `×${v.qty}, ${v.forTrade} for trade` : `×${v.qty}`]),
      );
      return { label: 'In your collection', notes };
    }
    const lines = (trade.peerTradelist ?? []).filter((l) => l.oracleId === target.oracle.oracleId);
    if (lines.length === 0) return undefined;
    const per = new Map<string, number>();
    for (const l of lines) per.set(l.scryfallId, (per.get(l.scryfallId) ?? 0) + l.quantity);
    return { label: 'On their tradelist', notes: new Map([...per].map(([id, q]) => [id, `×${q}`])) };
  }

  // Apply the card sheet's edits to an existing offer line. Edition/condition/
  // finish/language all feed the line key, so any of them re-keys the line;
  // quantity 0 removes it, and a re-key that collides with another line merges.
  function updateLine(side: Side, oldLine: TradeLine, v: SessionCardValues) {
    const cur = offers[seatOf(side)];
    const oldKey = lineKey(oldLine);
    if (v.quantity <= 0) {
      commit(side, cur.filter((l) => lineKey(l) !== oldKey));
      return;
    }
    const updated: TradeLine = {
      ...oldLine,
      scryfallId: v.scryfallId,
      quantity: v.quantity,
      condition: v.condition ?? oldLine.condition,
      finish: v.finish ?? oldLine.finish,
      lang: v.lang ?? oldLine.lang,
    };
    const newKey = lineKey(updated);
    if (oldKey === newKey) {
      commit(side, cur.map((l) => (lineKey(l) === oldKey ? updated : l)));
      return;
    }
    const existing = cur.find((l) => lineKey(l) === newKey);
    if (existing) {
      const merged = { ...existing, quantity: existing.quantity + updated.quantity };
      commit(side, cur.filter((l) => lineKey(l) !== oldKey).map((l) => (lineKey(l) === newKey ? merged : l)));
    } else {
      commit(side, cur.map((l) => (lineKey(l) === oldKey ? updated : l)));
    }
  }

  // Wishlist⇄tradelist matchers, both directions (for ⭐ badges and balance).
  const myWishes = useWishes();
  const myTradelist = useOwnTradeLines();
  const theirWanted = useMemo(() => wishCountMatcher(trade.peerWishlist ?? []), [trade.peerWishlist]);
  const myWanted = useMemo(() => wishCountMatcher(myWishes ?? []), [myWishes]);
  const theyWantCount = (myTradelist ?? []).filter((l) => theirWanted(l) > 0).length;
  const iWantCount = (trade.peerTradelist ?? []).filter((l) => myWanted(l) > 0).length;

  const myTotal = totalOf(myOffer);
  const theirTotal = totalOf(theirOffer);
  const diff = myTotal - theirTotal;
  // Nothing on the table yet: a green "balanced" would be a verdict on nothing.
  const emptyTable = myOffer.length === 0 && theirOffer.length === 0;

  // Cards this device can't put a number on: a printing missing from an
  // out-of-date card DB, or one with no EUR price. They count as zero in the
  // totals above, which is how two partners end up disagreeing about a trade
  // neither of them mispriced on purpose. The session-open price refresh fixes
  // most of it; this is the backstop for when that couldn't run (offline, or
  // card data the user hasn't taken yet).
  const unpricedCount = printMap ? [...myOffer, ...theirOffer].filter((l) => eurOf(l) === 0).length : 0;

  const iAccepted = snap.accepted[seat];
  const peerAccepted = snap.accepted[peer];
  const iConfirmed = snap.confirmed[seat];
  const peerConfirmed = snap.confirmed[peer];

  if (snap.state === 'completed' && trade.applyState === 'failed') {
    return (
      <Page title="Trade not saved">
        <p className="gate-msg">
          The trade went through, but this device couldn't write it to your collection. Nothing changed here yet.
        </p>
        <div className="trade-actions">
          <button className="primary" onClick={trade.retryApply}>
            Retry
          </button>
        </div>
      </Page>
    );
  }
  if (snap.state === 'completed') {
    return (
      <Page title="Trade complete 🎉">
        <p className="gate-msg">
          {trade.applyState === 'applied' ? 'Your collection has been updated.' : 'Updating your collection…'}
        </p>
        {tradeConflicts.length > 0 && (
          <p className="gate-msg">
            <Link to="/conflicts" state={{ tradedKeys: tradeConflicts.map((c) => collectionKey(c)) }}>
              Sort out {tradeConflicts.length} filing {plural(tradeConflicts.length, 'conflict')}
            </Link>
            {'. Looks like a copy was filed in two places.'}
          </p>
        )}
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

  const barStatus = solo
    ? snap.state === 'agreed'
      ? 'Swap the cards, then confirm to record the trade.'
      : 'Add the cards on both sides, then accept.'
    : snap.state === 'agreed'
      ? iConfirmed
        ? 'Waiting for their confirmation…'
        : peerConfirmed
          ? 'They confirmed. Inspect the cards, then confirm.'
          : 'Deal! Swap the cards, then both confirm.'
      : iAccepted
        ? 'Accepted, waiting for them. Any edit resets acceptance.'
        : peerAccepted
          ? 'They accepted. Review the deal and accept.'
          : trade.peerPresent
            ? 'Either of you can add cards to both sides.'
            : 'Waiting for the other user to connect…';

  return (
    <Page
      title="Trade"
      fill
      menu={
        <OptionsMenu
          label="Trade options"
          actions={[
            ...(editable ? [{ label: 'Balance the trade', icon: 'balance' as const, onClick: () => setSheet('balance') }] : []),
            ...(solo ? [] : [{ label: 'Refresh partner lists', icon: 'refresh' as const, onClick: () => { requestWishlist(); requestTradelist(); } }]),
            { label: 'Cancel trade', icon: 'close', danger: true, onClick: trade.cancel },
          ]}
        />
      }
    >
      <ReconnectBanner trade={trade} />
      <div className="trade-status">
        {solo ? (
          <div className="trade-status-code">Solo trade</div>
        ) : (
          <div className="trade-status-code">
            Code <strong className="trade-code">{snap.code}</strong>
            {snap.state === 'open' && (
              <button className="qr-btn" onClick={() => setShowQr(true)} aria-label="Show invite QR code" title="Show invite QR code">
                <Icon name="qr" size={18} />
              </button>
            )}
          </div>
        )}
        {!solo && (
          <div className={trade.peerPresent ? 'presence-on' : 'presence-off'}>
            {snap.present[peer] ? 'Other User connected' : 'Waiting for other user…'}
          </div>
        )}
        {/* Both columns share one view: a board with tiles on one side and
            stacks on the other would be a trade nobody can read across. */}
        <ViewToggle mode={view} onChange={setView} options={['grid', 'stack']} />
      </div>

      {(theyWantCount > 0 || iWantCount > 0) && (
        <div className="match-chips">
          {theyWantCount > 0 && (
            <button className="chip chip-wish" onClick={() => setSheet('give')}>
              ⭐ They want {theyWantCount} of your cards
            </button>
          )}
          {iWantCount > 0 && (
            <button className="chip chip-wish" onClick={() => setSheet('get')}>
              ⭐ You want {iWantCount} of theirs
            </button>
          )}
        </div>
      )}

      <div className="trade-board">
        <OfferPanel
          side="give"
          title="You give"
          total={myTotal}
          lines={myOffer}
          empty="No cards yet. Add or scan cards from your binder."
          editable={editable}
          onQty={setQty}
          onAdd={() => setSheet('give')}
          onScan={() => setScanFor('give')}
          badge={(l) => ownIndicator(ownership, l.oracleId, l.scryfallId)}
          cards={cards}
          onInfo={openInfo}
          onEdit={(side, line, oracle) => setEditingLine({ side, line, oracle })}
          view={view}
        />
        <OfferPanel
          side="get"
          title="You get"
          total={theirTotal}
          lines={theirOffer}
          empty={
            solo
              ? 'No cards yet. Search for them or scan their binder.'
              : 'No cards yet. Pick from their tradelist or scan their binder.'
          }
          editable={editable}
          onQty={setQty}
          onAdd={() => setSheet('get')}
          onScan={() => setScanFor('get')}
          badge={(l) => {
            const w = myWanted(l);
            return w > 0 ? { icon: '⭐', title: `On your wishlist (×${w})`, cls: 'badge-wish' } : null;
          }}
          cards={cards}
          onInfo={openInfo}
          onEdit={(side, line, oracle) => setEditingLine({ side, line, oracle })}
          view={view}
        />
      </div>

      <div className="trade-dock">
        {pricesRefreshing ? (
          <div className="trade-note">Checking for today’s prices…</div>
        ) : (
          unpricedCount > 0 && (
            <div className="trade-note trade-note-warn">
              {unpricedCount === 1
                ? '1 card has no price on this device and counts as zero.'
                : `${unpricedCount} cards have no price on this device and count as zero.`}{' '}
              Your partner’s total may differ.
            </div>
          )
        )}
        <div className="trade-bar">
          <button
            className={`trade-diff ${emptyTable ? '' : Math.abs(diff) < BALANCE_EPSILON ? 'diff-even' : 'diff-off'}`}
            title="Balance the trade"
            aria-label="Value difference. Tap to balance the trade"
            onClick={() => setSheet('balance')}
            disabled={!editable}
          >
            <strong>{fmtEur(Math.abs(diff))}</strong>
            <span>
              {emptyTable
                ? 'nothing added yet'
                : Math.abs(diff) < BALANCE_EPSILON
                  ? 'balanced'
                  : diff > 0
                    ? 'you give more'
                    : 'you get more'}
            </span>
          </button>
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

      {sheet === 'give' && editable && (
        <TradePickerOverlay title="Add cards you give" onClose={() => setSheet(null)}>
          <QuickPickPanel
            lines={myTradelist}
            wanted={theirWanted}
            wantedText={(n) => `they want ×${n}`}
            intro="From your tradelist (or search above for any card):"
            waiting="Loading tradelist…"
            emptyText="Your tradelist is empty. Search above to add any card."
            placeholder="Search any card to add…"
            // Owned cards seed the sheet with the copy you have; anything you
            // don't own starts from the printing the search result showed.
            prefillFor={(oracleId) => {
              const e = bestAddDefault(ownership?.ownedCopies(oracleId) ?? []);
              return e && { scryfallId: e.scryfallId, condition: e.condition, finish: e.finish, lang: e.lang };
            }}
            badgeFor={(card, printing) => ownIndicator(ownership, card.oracleId, printing?.scryfallId ?? card.defaultScryfallId)}
            onCompose={(oracle, prefill) => setComposing({ side: 'give', oracle, prefill })}
          />
        </TradePickerOverlay>
      )}
      {sheet === 'get' && editable && (
        <TradePickerOverlay title="Add cards you get" onClose={() => setSheet(null)}>
          <QuickPickPanel
            lines={trade.peerTradelist}
            wanted={myWanted}
            wantedText={(n) => `you want ×${n}`}
            intro="From their tradelist (or search above for any card):"
            headerEnd={
              <button className="chip" onClick={requestTradelist} disabled={trade.peerTradelistLoading}>
                {trade.peerTradelistLoading ? 'Loading…' : '↻ Refresh'}
              </button>
            }
            waiting={trade.peerTradelistLoading ? 'Waiting for their tradelist…' : 'No tradelist received yet.'}
            emptyText="Their tradelist is empty. Search above to add any card they hand you."
            placeholder="Search any card they hand you…"
            // Their tradelist knows the exact printing they registered (the
            // card-DB default is the newest edition, usually the wrong guess).
            prefillFor={(oracleId) => {
              const l = bestPeerLine(trade.peerTradelist, oracleId);
              return l && { scryfallId: l.scryfallId, condition: l.condition, finish: l.finish, lang: l.lang };
            }}
            onCompose={(oracle, prefill) => setComposing({ side: 'get', oracle, prefill })}
          />
        </TradePickerOverlay>
      )}
      {sheet === 'balance' && (
        <Sheet title="Balance the trade" onClose={() => setSheet(null)}>
          <BalancePanel
            diff={diff}
            myOffer={myOffer}
            theirOffer={theirOffer}
            myTradelist={myTradelist}
            peerTradelist={trade.peerTradelist}
            theirWanted={theirWanted}
            myWanted={myWanted}
            onAdd={addLine}
            onAddMany={(side, adds) => {
              addMany(side, adds);
              setSheet(null);
            }}
            onInfo={openInfo}
          />
        </Sheet>
      )}

      {showQr && (
        <Sheet title="Invite your trade partner" onClose={() => setShowQr(false)}>
          <TradeQr code={snap.code} />
        </Sheet>
      )}

      {info && (
        <CardSheet
          mode="info"
          oracleCard={info.oracle}
          initialScryfallId={info.scryfallId}
          highlightPrintings={infoHighlights(info)}
          onClose={() => setInfo(null)}
        />
      )}

      {composing && editable && (
        <CardSheet
          mode="session"
          oracleCard={composing.oracle}
          sessionCard={{
            scryfallId: composing.prefill?.scryfallId ?? composing.oracle.defaultScryfallId,
            quantity: composing.prefill?.quantity ?? 1,
            lang: composing.prefill?.lang ?? 'en',
            finish: composing.prefill?.finish ?? 'nonfoil',
            condition: composing.prefill?.condition ?? 'NM',
          }}
          highlightPrintings={infoHighlights({ oracle: composing.oracle, ctx: { side: composing.side } })}
          applyLabel="Add to trade"
          hideRemove
          onApply={(v) => {
            // quantity 0 = the sheet's Cancel; nothing to add.
            if (v.quantity > 0)
              addMany(composing.side, [
                {
                  line: {
                    oracleId: composing.oracle.oracleId,
                    scryfallId: v.scryfallId,
                    name: composing.oracle.name,
                    quantity: v.quantity,
                    condition: v.condition!,
                    finish: v.finish!,
                    lang: v.lang!,
                  },
                  count: v.quantity,
                  max: 999,
                },
              ]);
          }}
          onClose={() => setComposing(null)}
        />
      )}

      {editingLine && editable && (
        <CardSheet
          mode="session"
          oracleCard={editingLine.oracle}
          sessionCard={{
            scryfallId: editingLine.line.scryfallId,
            quantity: editingLine.line.quantity,
            lang: editingLine.line.lang,
            finish: editingLine.line.finish,
            condition: editingLine.line.condition,
          }}
          highlightPrintings={infoHighlights({ oracle: editingLine.oracle, ctx: { side: editingLine.side } })}
          applyLabel="Save"
          onApply={(v) => updateLine(editingLine.side, editingLine.line, v)}
          onClose={() => setEditingLine(null)}
        />
      )}

      {scanFor && editable && (
        <ScanSheet
          target={{
            kind: 'trade',
            label: scanFor === 'give' ? 'Trade: you give' : 'Trade: you get',
            // Scoped to this trade and this column, so an interrupted scan comes
            // back to the offer it was meant for and nowhere else.
            tradeKey: `${snap.sessionId}:${scanFor}`,
            // One commit for the whole scan, with each card's scanned count.
            onAdd: (cards) =>
              addMany(
                scanFor,
                cards.map((c) => ({
                  line: { oracleId: c.oracleId, scryfallId: c.scryfallId, name: c.name, quantity: c.quantity, condition: c.condition, finish: c.finish, lang: c.lang },
                  count: c.quantity,
                  max: 999,
                })),
              ),
          }}
          onClose={() => setScanFor(null)}
        />
      )}
    </Page>
  );
}

/**
 * Full-screen picker for adding cards to an offer. Unlike the bottom sheet, it
 * gives the reused card-search view (filters, list/grid toggle, paging) the
 * whole screen: searching for cards in a trade looks exactly like searching
 * anywhere else in the app, instead of a cramped little list.
 *
 * Deliberately not a Sheet: it fills the viewport with its own scroll region
 * (.picker-overlay, the CardZoom shape), has no backdrop to click away, and
 * opens from a button in the trade column rather than under a finger on a
 * card, so the sheet's 400ms tap guard would only make the search box feel
 * dead. Escape/back still close it through useDismiss.
 */
function TradePickerOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useDismiss(onClose);
  return createPortal(
    <div className="picker-overlay" role="dialog" aria-label={title}>
      <header className="picker-overlay-head">
        <strong>{title}</strong>
        <button className="header-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="picker-overlay-scroll">
        <div className="search-overlay-inner">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
