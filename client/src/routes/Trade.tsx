import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useSearchParams } from 'react-router-dom';
import { CODE_LENGTH, type CollectionEntry, type OracleCard, type Priced, type Printing, type Seat, type TradeLine } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { collectionKey } from '../db/dataAccess.js';
import { getOracleCardsByIds, getPrintingsByIds, joinCollectionEntries } from '../db/queries.js';
import { useCardMaps } from '../db/useCardMaps.js';
import type { SearchFilters } from '../cardDb/search.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardSearchView } from '../components/CardSearchView.js';
import { formatPrice } from '../components/CardSorting.js';
import { CardItems, CardList, type CardItem } from '../components/CardViews.js';
import { CodeJoinForm } from '../components/CodeJoinForm.js';
import { Icon } from '../components/icons.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { TradeQr } from '../components/TradeQr.js';
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
  /** The best entry for add defaults (prefers for-trade copies, then the printing with most copies). */
  entry: CollectionEntry;
  /** Every entry for this oracle — the edition dropdown highlights these printings. */
  entries: CollectionEntry[];
}

/** Add-default preference: for-trade copies beat idle ones, then more copies win. */
function betterAddDefault(a: CollectionEntry, b: CollectionEntry): boolean {
  const at = a.quantityForTrade > 0 ? 1 : 0;
  const bt = b.quantityForTrade > 0 ? 1 : 0;
  return at !== bt ? at > bt : a.quantity > b.quantity;
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
        cur.entries.push(e);
        if (betterAddDefault(e, cur.entry)) cur.entry = e;
      } else {
        map.set(e.oracleId, { qty: e.quantity, forTrade: e.quantityForTrade, entry: e, entries: [e] });
      }
    }
    return map;
  }, []);
}

/** Their highest-quantity tradelist line for an oracle — the best printing guess for "you get". */
function bestPeerLine(lines: TradeLine[] | null, oracleId: string): TradeLine | undefined {
  let best: TradeLine | undefined;
  for (const l of lines ?? []) {
    if (l.oracleId === oracleId && (!best || l.quantity > best.quantity)) best = l;
  }
  return best;
}

/** ⇄ in tradelist / ✓ owned / ❓ not in collection. */
function ownIndicator(own: Owned | undefined): { icon: string; label: string; cls: string } {
  if (!own) return { icon: '❓', label: 'Not in your collection', cls: 'own-unknown' };
  if (own.forTrade > 0) return { icon: '⇄', label: `In your tradelist (${own.forTrade} for trade)`, cls: 'own-trade' };
  return { icon: '✓', label: `In your collection (×${own.qty}), but not marked for trade`, cls: 'own-yes' };
}

/**
 * What the card-info sheet should show when a card is tapped. `side` says whose
 * printings to highlight in the edition dropdown ('give' = my collection,
 * 'get' = their tradelist); `line` is set when tapping an editable offer line,
 * which makes the edition dropdown re-print that line in place.
 */
type InfoCtx = { side: Side; line?: TradeLine };
type InfoTarget = { oracle: Priced<OracleCard>; scryfallId?: string; ctx?: InfoCtx };
type OpenInfo = (oracle: Priced<OracleCard>, scryfallId?: string, ctx?: InfoCtx) => void;
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
  // Creator chose "Start ahead": show the board while the seat is still open.
  const [startedAhead, setStartedAhead] = useState(false);

  useEffect(() => {
    if (trade.status === 'idle') void getPersistedTrade().then((t) => setResumable(t ?? null));
    if (trade.status !== 'active') setStartedAhead(false);
  }, [trade.status]);

  // Deep link from a scanned invite QR (#/trade?join=CODE): join right away —
  // scanning *is* the join gesture, no extra tap. The param is consumed once
  // and stripped so a reload doesn't re-join a dead session.
  const [searchParams, setSearchParams] = useSearchParams();
  const joinParam = searchParams.get('join');
  const { status, join } = trade;
  useEffect(() => {
    if (!TRADE_ENABLED || !joinParam) return;
    // The status gate is also the re-entry guard: once join() flips us to
    // 'connecting' this can't fire again. No ref — StrictMode's double-invoke
    // must re-join, because the hook's unmount cleanup closed the first socket.
    if (status !== 'idle' && status !== 'error') return;
    setSearchParams({}, { replace: true });
    const code = joinParam.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
    if (code.length === CODE_LENGTH) join(code);
  }, [joinParam, status, join, setSearchParams]);

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

  // Freshly created, partner seat still empty: show the invite full-screen.
  // Pairing flips state to 'paired', which lands on the board automatically.
  if (trade.snapshot.state === 'open' && !startedAhead) {
    return (
      <Page title="Trade" subtitle="Have your trade partner scan the QR code, or type in the code.">
        <TradeQr code={trade.snapshot.code} />
        <div className="trade-actions">
          <button className="primary" onClick={() => setStartedAhead(true)}>
            Start ahead
          </button>
          <button onClick={trade.cancel}>Cancel</button>
        </div>
        <p className="fine-print">
          Start ahead to add cards while you wait — they can join whenever they’re ready.
        </p>
      </Page>
    );
  }

  return <TradeBoard trade={trade} seat={trade.seat} />;
}

/** Which column an add/scan/balance action targets: 'give' = my offer, 'get' = theirs. */
type Side = 'give' | 'get';
type SheetKind = Side | 'balance';

function TradeBoard({ trade, seat }: { trade: ReturnType<typeof useTradeSession>; seat: Seat }) {
  const snap = trade.snapshot!;
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
  const ownership = useOwnership();

  const seatOf = (side: Side): Seat => (side === 'give' ? seat : peer);
  const myOffer = offers[seat];
  const theirOffer = offers[peer];
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
  const { printMap, oracleMap } = useCardMaps([...myOffer, ...theirOffer]);
  const totalOf = (lines: TradeLine[]) =>
    lines.reduce((sum, l) => sum + (printMap?.get(l.scryfallId)?.priceEur ?? 0) * l.quantity, 0);
  const openInfo: OpenInfo = (oracle, scryfallId, ctx) => setInfo({ oracle, scryfallId, ctx });

  // Editions "the relevant person" has, for the info sheet's edition dropdown:
  // my collection when looking at a "you give" card, their tradelist for "you get".
  function infoHighlights(target: InfoTarget): { label: string; notes: Map<string, string> } | undefined {
    if (!target.ctx) return undefined;
    if (target.ctx.side === 'give') {
      const entries = ownership?.get(target.oracle.oracleId)?.entries ?? [];
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

  // Re-print an offer line as a different edition. The line key includes the
  // scryfallId, so this rebuilds the line; if the target edition is already in
  // the offer the two lines merge. Returns the resulting line so the info sheet
  // can keep editing the same (now re-keyed) card.
  function changeEdition(side: Side, line: TradeLine, newScryfallId: string): TradeLine {
    const updated: TradeLine = { ...line, scryfallId: newScryfallId };
    const oldKey = lineKey(line);
    const newKey = lineKey(updated);
    if (oldKey === newKey) return line;
    const cur = offers[seatOf(side)];
    const existing = cur.find((l) => lineKey(l) === newKey);
    if (existing) {
      const merged = { ...existing, quantity: existing.quantity + line.quantity };
      commit(side, cur.filter((l) => lineKey(l) !== oldKey).map((l) => (lineKey(l) === newKey ? merged : l)));
      return merged;
    }
    commit(side, cur.map((l) => (lineKey(l) === oldKey ? updated : l)));
    return updated;
  }

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
        ? 'Waiting for their confirmation…'
        : peerConfirmed
          ? 'They confirmed — inspect the cards, then confirm.'
          : 'Deal! Swap the cards, then both confirm.'
      : iAccepted
        ? 'Accepted — waiting for them. Any edit resets acceptance.'
        : peerAccepted
          ? 'They accepted. Review the deal and accept.'
          : trade.peerPresent
            ? 'Either of you can add cards to both sides.'
            : 'Waiting for the other user to connect…';

  return (
    <Page
      title="Trade"
      menu={
        <OptionsMenu
          label="Trade options"
          actions={[
            ...(editable ? [{ label: 'Balance the trade', icon: 'balance' as const, onClick: () => setSheet('balance') }] : []),
            { label: 'Refresh partner lists', icon: 'refresh', onClick: () => { requestWishlist(); requestTradelist(); } },
            { label: 'Cancel trade', icon: 'close', danger: true, onClick: trade.cancel },
          ]}
        />
      }
    >
      <div className="trade-status">
        <div className="trade-status-code">
          Code <strong className="trade-code">{snap.code}</strong>
          {snap.state === 'open' && (
            <button className="qr-btn" onClick={() => setShowQr(true)} aria-label="Show invite QR code" title="Show invite QR code">
              <Icon name="qr" size={18} />
            </button>
          )}
        </div>
        <div className={trade.peerPresent ? 'presence-on' : 'presence-off'}>
          {snap.present[peer] ? 'Other User connected' : 'Waiting for other user…'}
        </div>
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
          badge={(l) => (ownership ? ownIndicator(ownership.get(l.oracleId)) : null)}
          printings={printMap}
          oracles={oracleMap}
          onInfo={openInfo}
        />
        <OfferPanel
          side="get"
          title="You get"
          total={theirTotal}
          lines={theirOffer}
          empty="No cards yet. Pick from their tradelist or scan their binder."
          editable={editable}
          onQty={setQty}
          onAdd={() => setSheet('get')}
          onScan={() => setScanFor('get')}
          badge={(l) => {
            const w = myWanted(l.oracleId, l.scryfallId);
            return w > 0 ? { icon: '⭐', label: `On your wishlist (×${w})`, cls: 'badge-wish' } : null;
          }}
          printings={printMap}
          oracles={oracleMap}
          onInfo={openInfo}
        />
      </div>

      <div className="trade-dock">
        <div className="trade-bar">
          <button
            className={`trade-diff ${Math.abs(diff) < BALANCE_EPSILON ? 'diff-even' : 'diff-off'}`}
            title="Balance the trade"
            aria-label="Value difference — tap to balance the trade"
            onClick={() => setSheet('balance')}
            disabled={!editable}
          >
            <strong>€{Math.abs(diff).toFixed(2)}</strong>
            <span>{Math.abs(diff) < BALANCE_EPSILON ? 'balanced' : diff > 0 ? 'you give more' : 'you get more'}</span>
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
          <AddCardsPanel
            ownership={ownership}
            theirWanted={theirWanted}
            onAdd={(line, max) => addLine('give', line, max)}
            onInfo={(oracle, scryfallId) =>
              openInfo(oracle, scryfallId ?? ownership?.get(oracle.oracleId)?.entry.scryfallId, { side: 'give' })
            }
          />
        </TradePickerOverlay>
      )}
      {sheet === 'get' && editable && (
        <TradePickerOverlay title="Add cards you get" onClose={() => setSheet(null)}>
          <AddTheirCardsPanel
            lines={trade.peerTradelist}
            loading={trade.peerTradelistLoading}
            myWanted={myWanted}
            onAdd={(line, max) => addLine('get', line, max)}
            onInfo={(oracle, scryfallId) =>
              openInfo(oracle, scryfallId ?? bestPeerLine(trade.peerTradelist, oracle.oracleId)?.scryfallId, { side: 'get' })
            }
            onRefresh={requestTradelist}
          />
        </TradePickerOverlay>
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
            onAddMany={(side, adds) => {
              addMany(side, adds);
              setSheet(null);
            }}
            onInfo={openInfo}
          />
        </TradeSheet>
      )}

      {showQr && (
        <TradeSheet title="Invite your trade partner" onClose={() => setShowQr(false)}>
          <TradeQr code={snap.code} />
        </TradeSheet>
      )}

      {info && (
        <CardSheet
          oracleCard={info.oracle}
          initialScryfallId={info.scryfallId}
          readOnly
          highlightPrintings={infoHighlights(info)}
          onEditionChange={
            info.ctx?.line
              ? (id) => {
                  const line = changeEdition(info.ctx!.side, info.ctx!.line!, id);
                  setInfo((cur) => (cur && cur.ctx?.line ? { ...cur, scryfallId: id, ctx: { ...cur.ctx, line } } : cur));
                }
              : undefined
          }
          onClose={() => setInfo(null)}
        />
      )}

      {scanFor && editable && (
        <ScanSheet
          target={{
            kind: 'trade',
            label: scanFor === 'give' ? 'Trade — you give' : 'Trade — you get',
            onAdd: (c) =>
              addLine(
                scanFor,
                { oracleId: c.oracleId, scryfallId: c.scryfallId, name: c.name, quantity: 1, condition: 'NM', finish: c.finish, lang: c.lang },
                999,
              ),
          }}
          onClose={() => setScanFor(null)}
        />
      )}
    </Page>
  );
}

/**
 * One side of the board: title + running total, the card tiles, and the
 * add/scan actions. Both sides are editable — you usually hold each other's
 * binders, so adding to "You get" is as normal as adding to "You give".
 */
function OfferPanel({
  side,
  title,
  total,
  lines,
  empty,
  editable,
  onQty,
  onAdd,
  onScan,
  badge,
  printings,
  oracles,
  onInfo,
}: {
  side: Side;
  title: string;
  total: number;
  lines: TradeLine[];
  empty: string;
  editable: boolean;
  onQty: (side: Side, key: string, qty: number) => void;
  onAdd: () => void;
  onScan: () => void;
  /** Per-line indicator: ownership for "You give", wishlist match for "You get". */
  badge: (l: TradeLine) => { icon: string; label: string; cls: string } | null;
  printings: Map<string, Priced<Printing>> | undefined;
  oracles: Map<string, Priced<OracleCard>> | undefined;
  onInfo: OpenInfo;
}) {
  return (
    <section className="trade-col" aria-label={`Cards ${title.toLowerCase()}`}>
      <header className="trade-col-head">
        <h3>{title}</h3>
        <span className="trade-col-total" aria-label={`Total ${title.toLowerCase()}`}>
          €{total.toFixed(2)}
        </span>
      </header>
      {lines.length === 0 ? (
        <p className="trade-empty">{empty}</p>
      ) : (
        <CardItems
          view="grid"
          items={lines.map((l): CardItem => {
            const ind = badge(l);
            const printing = printings?.get(l.scryfallId);
            const oracle = oracles?.get(l.oracleId);
            return {
              key: lineKey(l),
              name: l.name,
              image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
              foil: l.finish !== 'nonfoil',
              count: l.quantity,
              badge: ind?.icon,
              badgeClass: ind?.cls,
              badgeTitle: ind?.label,
              onClick: oracle ? () => onInfo(oracle, l.scryfallId, { side, line: editable ? l : undefined }) : undefined,
              actions: (
                <>
                  {editable && (
                    <button onClick={() => onQty(side, lineKey(l), l.quantity - 1)} aria-label="One fewer">
                      −
                    </button>
                  )}
                  <span className="tile-price">{formatPrice(printing) ?? '—'}</span>
                  {editable && (
                    <button onClick={() => onQty(side, lineKey(l), l.quantity + 1)} aria-label="One more">
                      ＋
                    </button>
                  )}
                </>
              ),
            };
          })}
        />
      )}
      {editable && (
        <div className="trade-col-actions">
          <button className="trade-add" onClick={onAdd}>
            <Icon name="plus" size={15} /> Add
          </button>
          <button className="trade-add" onClick={onScan}>
            <Icon name="camera" size={15} /> Scan
          </button>
        </div>
      )}
    </section>
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

/**
 * Full-screen picker for adding cards to an offer. Unlike the bottom sheet, it
 * gives the reused card-search view (filters, list/grid toggle, paging) the
 * whole screen — searching for cards in a trade looks exactly like searching
 * anywhere else in the app, instead of a cramped little list.
 */
function TradePickerOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEscapeToClose(onClose);
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
 * The scales tool: suggests cards from the lighter side's tradelist to even
 * out the value. Suggestions can be added straight to that side's column —
 * either participant may edit either side.
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
  onAdd: (side: Side, line: TradeLine, max: number) => void;
  onAddMany: (side: Side, adds: Array<{ line: TradeLine; count: number; max: number }>) => void;
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
    return <p className="fine-print">You’re giving more, but their tradelist hasn’t arrived yet. Try again in a moment.</p>;
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
  const lightSide: Side = iGiveMore ? 'get' : 'give';

  return (
    <>
      <p className="fine-print">
        {iGiveMore ? (
          <>
            You’re giving <strong>€{gap.toFixed(2)}</strong> more. From <strong>their</strong> tradelist, you could add
            to what you get:
          </>
        ) : (
          <>
            You’re getting <strong>€{gap.toFixed(2)}</strong> more. From <strong>your</strong> tradelist, you could add
            to what you give:
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
            foil: c.line.finish !== 'nonfoil',
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
            onClick: oracle ? () => onInfo(oracle, c.line.scryfallId, { side: lightSide }) : undefined,
            actions: (
              <button
                title={iGiveMore ? 'Add to what you get' : 'Add to what you give'}
                onClick={() => onAdd(lightSide, c.line, c.max)}
              >
                ＋
              </button>
            ),
          };
        })}
      />
      <p className="fine-print">
        Adds €{pickedTotal.toFixed(2)}, bringing the difference from €{gap.toFixed(2)} down to €{after.toFixed(2)}.
        Prices are EUR estimates; unpriced cards are skipped.
      </p>
      <button
        className="primary"
        onClick={() => onAddMany(lightSide, suggestions.map((c) => ({ line: c.line, count: picks.get(c.key)!, max: c.max })))}
      >
        Add all ({pickCount} {pickCount === 1 ? 'card' : 'cards'})
      </button>
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
  const [filters, setFilters] = useState<SearchFilters>({});

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

  // With no query, quick-picks from your own tradelist (partner-wishlist
  // matches starred and sorted first).
  const emptyState = !tradelist ? (
    <p className="fine-print">Loading tradelist…</p>
  ) : tradelist.length === 0 ? (
    <p className="fine-print">Your tradelist is empty. Search above to add any card.</p>
  ) : (
    <>
      <p className="fine-print">From your tradelist (or search above for any card):</p>
      <CardList
        items={sortedTradelist.map(({ entry: e, oracle, printing, wanted }): CardItem => {
          const name = oracle?.name ?? '(unknown card)';
          return {
            key: e.id,
            name,
            image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
            foil: e.finish !== 'nonfoil',
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
  );

  return (
    <CardSearchView
      query={q}
      onQueryChange={setQ}
      inputPlaceholder="Search any card to add…"
      filters={filters}
      setFilters={setFilters}
      emptyState={emptyState}
      badgeFor={(card) => {
        const ind = ownIndicator(ownership?.get(card.oracleId));
        return { icon: ind.icon, cls: ind.cls, title: ind.label };
      }}
      actionsFor={(card) => (
        <button title="Add to offer" onClick={() => addFromSearch(card)}>
          ＋
        </button>
      )}
      onCardClick={(card) => onInfo(card)}
    />
  );
}

/**
 * Add cards to what you get: with no query, quick-picks from the partner's
 * tradelist (your wishlist matches starred and sorted first); typing searches
 * the whole card database, for cards they hand you that aren't on their list.
 */
function AddTheirCardsPanel({
  lines,
  loading,
  myWanted,
  onAdd,
  onInfo,
  onRefresh,
}: {
  lines: TradeLine[] | null;
  loading: boolean;
  myWanted: WantFn;
  onAdd: (line: TradeLine, max: number) => void;
  onInfo: OpenInfo;
  onRefresh: () => void;
}) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  // Their lines reference cards by id; the local card DB has the display data.
  const { printMap, oracleMap } = useCardMaps(lines ?? []);

  // Their tradelist knows the exact printing they registered — prefer it over
  // the card-DB default (the newest edition, usually the wrong guess).
  const addFromSearch = (card: OracleCard) => {
    const listed = bestPeerLine(lines, card.oracleId);
    if (listed) onAdd({ ...listed, quantity: 1 }, listed.quantity);
    else
      onAdd(
        { oracleId: card.oracleId, scryfallId: card.defaultScryfallId, name: card.name, quantity: 1, condition: 'NM', finish: 'nonfoil', lang: 'en' },
        999,
      );
  };

  const sorted = [...(lines ?? [])]
    .map((l) => ({ l, wanted: myWanted(l.oracleId, l.scryfallId) }))
    .sort((a, b) => b.wanted - a.wanted);

  // With no query, quick-picks from their tradelist (your wishlist matches
  // starred and sorted first).
  const emptyState = !lines ? (
    <p className="fine-print">{loading ? 'Waiting for their tradelist…' : 'No tradelist received yet.'}</p>
  ) : lines.length === 0 ? (
    <p className="fine-print">Their tradelist is empty. Search above to add any card they hand you.</p>
  ) : (
    <>
      <div className="meta-row">
        <span className="fine-print">From their tradelist (or search above for any card):</span>
        <button className="chip" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>
      <CardList
        items={sorted.map(({ l, wanted }): CardItem => {
          const printing = printMap?.get(l.scryfallId);
          const oracle = oracleMap?.get(l.oracleId);
          return {
            key: lineKey(l),
            name: l.name,
            image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
            foil: l.finish !== 'nonfoil',
            badge: wanted > 0 ? '⭐' : undefined,
            badgeClass: 'badge-wish',
            badgeTitle: wanted > 0 ? `On your wishlist (×${wanted})` : undefined,
            sub: (
              <>
                {l.condition} · {l.finish}
                {l.lang !== 'en' ? ` · ${l.lang}` : ''} · {l.quantity} for trade
                {wanted > 0 ? ` · you want ×${wanted}` : ''}
              </>
            ),
            price: formatPrice(printing),
            onClick: oracle ? () => onInfo(oracle, l.scryfallId) : undefined,
            actions: (
              <button title="Add to what you get" onClick={() => onAdd({ ...l, quantity: 1 }, l.quantity)}>
                ＋
              </button>
            ),
          };
        })}
      />
    </>
  );

  return (
    <CardSearchView
      query={q}
      onQueryChange={setQ}
      inputPlaceholder="Search any card they hand you…"
      filters={filters}
      setFilters={setFilters}
      emptyState={emptyState}
      actionsFor={(card) => (
        <button title="Add to what you get" onClick={() => addFromSearch(card)}>
          ＋
        </button>
      )}
      onCardClick={(card) => onInfo(card)}
    />
  );
}
