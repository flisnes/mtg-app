import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CollectionEntry, Condition, DeckBoard, DeckFormat, Finish, OracleCard, Priced, PriceHistory, Printing, UserEvent, WishlistEntry } from '@mtg/shared';
import { CONDITIONS } from '@mtg/shared';
import {
  addDeckCard,
  addToCollection,
  addToWishlist,
  removeDeckCard,
  removeFromCollection,
  removeFromWishlist,
  updateCollectionEntry,
  updateDeckCard,
  updateWishlistEntry,
} from '../db/dataAccess.js';
import { getPrintingsForOracle } from '../db/queries.js';
import { getPriceHistory } from '../price/tracking.js';
import { getMergedPriceHistory } from '../price/serverHistory.js';
import { historyChange, type HistoryChange } from '../price/history.js';
import { CardHistory } from './CardHistory.js';
import { EventSheet } from './EventSheet.js';
import { Icon } from './icons.js';
import type { HistoryEntry } from '../history/useHistoryEntries.js';
import { formatPrice } from './CardSorting.js';
import { ManaCost, SymbolText } from './ManaCost.js';
import { SetSymbol } from './SetSymbol.js';
import { Sparkline } from './Sparkline.js';
import { useEscapeToClose } from './useEscapeToClose.js';

// Bottom-sheet for a card's details, in five modes:
//  - add (default): add the card somewhere new — where depends on addTarget
//    (collection with edition/condition/qty/…, wishlist, tradelist, or a deck)
//  - edit (entry): edit an existing collection entry — covers the tradelist
//    via the "for trade" quantity (beta plan §4/§6)
//  - wish (wishEntry): edit a wishlist line — edition (incl. "any printing")
//    and quantity
//  - deck (deckCard): edit a deck slot's quantity
//  - info (readOnly): app-wide card info — image, printings, price + history

/** Where add mode sends the card (mirrors the context-sensitive search). */
export type AddTarget =
  | { kind: 'collection' }
  | { kind: 'wishlist' }
  | { kind: 'tradelist' }
  | { kind: 'deck'; deckId: string; format?: DeckFormat };

const ADD_LABEL: Record<AddTarget['kind'], string> = {
  collection: 'Add to collection',
  wishlist: 'Add to wishlist',
  tradelist: 'Add to tradelist',
  deck: 'Add to mainboard',
};

/** Sentinel for the "any printing" edition option in wish mode. */
const ANY_PRINTING = '';

const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'];

/** One Edition dropdown entry, optionally annotated (e.g. "×2, 1 for trade"). */
function printingOption(p: Priced<Printing>, note?: string) {
  return (
    <option key={p.scryfallId} value={p.scryfallId}>
      {p.setName} · #{p.collectorNumber} · {p.releasedAt.slice(0, 4)}
      {note ? ` · ${note}` : ''}
    </option>
  );
}

export function CardSheet({
  oracleCard,
  entry,
  wishEntry,
  deckCard,
  initialScryfallId,
  initialTab,
  addTarget,
  readOnly = false,
  onEditionChange,
  highlightPrintings,
  onClose,
}: {
  oracleCard: Priced<OracleCard>;
  entry?: CollectionEntry;
  /** Edit this wishlist line (edition + quantity) instead of the collection. */
  wishEntry?: WishlistEntry;
  /** Edit this deck slot's quantity + printing instead of the collection. */
  deckCard?: { id: string; quantity: number; scryfallId?: string };
  /** Preselect a specific printing (e.g. the one named in a trade line). */
  initialScryfallId?: string;
  /** Open on a specific tab (e.g. deep-link to History from the edit history). */
  initialTab?: 'details' | 'history';
  /** Add mode only: where the add goes (defaults to the collection). */
  addTarget?: AddTarget;
  /** Info-only: show the card and its printings, no collection editing. */
  readOnly?: boolean;
  /**
   * When set, the Edition dropdown stays editable even in info mode and every
   * change is reported here — the trade board uses this to re-print an offer
   * line in place without leaving the sheet.
   */
  onEditionChange?: (scryfallId: string) => void;
  /**
   * Printings to group first in the Edition dropdown, each with a short note
   * (e.g. "×2, 1 for trade") — the trade board uses this to surface the
   * editions the relevant person actually has.
   */
  highlightPrintings?: { label: string; notes: Map<string, string> };
  onClose: () => void;
}) {
  const mode = wishEntry ? 'wish' : deckCard ? 'deck' : entry ? 'edit' : readOnly ? 'info' : 'add';
  const editing = mode === 'edit';
  // An owned collection entry opens read-only with an Edit toggle; add/wish/deck
  // are always a form; info is never editable.
  const [editMode, setEditMode] = useState(false);
  const canToggleEdit = mode === 'edit';
  const formEditable = mode === 'add' || mode === 'wish' || mode === 'deck' || (mode === 'edit' && editMode);
  const addTo: AddTarget = (mode === 'add' && addTarget) || { kind: 'collection' };
  // Wishlist adds default to "any printing"; deck slots don't store an edition
  // at all, so those variants drop the collection-specific fields below.
  const wishAdd = mode === 'add' && addTo.kind === 'wishlist';
  const deckAdd = mode === 'add' && addTo.kind === 'deck';
  const collectionFields = mode === 'edit' || (mode === 'add' && (addTo.kind === 'collection' || addTo.kind === 'tradelist'));
  const [printings, setPrintings] = useState<Priced<Printing>[]>([]);
  // In wish mode the empty string means "any printing" (no specific edition).
  const [scryfallId, setScryfallId] = useState(
    wishEntry !== undefined || wishAdd
      ? wishEntry?.scryfallId ?? ANY_PRINTING
      : entry?.scryfallId ?? deckCard?.scryfallId ?? initialScryfallId ?? oracleCard.defaultScryfallId,
  );
  const [condition, setCondition] = useState<Condition>(entry?.condition ?? 'NM');
  const [finish, setFinish] = useState<Finish>(entry?.finish ?? 'nonfoil');
  const [lang, setLang] = useState(entry?.lang ?? 'en');
  const [quantity, setQuantity] = useState(entry?.quantity ?? wishEntry?.quantity ?? deckCard?.quantity ?? 1);
  const [forTrade, setForTrade] = useState(entry?.quantityForTrade ?? (addTo.kind === 'tradelist' ? 1 : 0));
  const [busy, setBusy] = useState(false);
  const [trend, setTrend] = useState<HistoryChange | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceHistory | null>(null);
  const [tab, setTab] = useState<'details' | 'history'>(initialTab ?? 'details');
  // Event info modal opened from the History tab (out of edit mode), plus a
  // nested card sheet when the user drills from that event into another card.
  const [eventEntry, setEventEntry] = useState<HistoryEntry | null>(null);
  const [nestedCard, setNestedCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);
  useEscapeToClose(busy ? null : onClose);

  useEffect(() => {
    void getPrintingsForOracle(oracleCard.oracleId).then(setPrintings);
  }, [oracleCard.oracleId]);

  // Recorded price history for the shown printing (collection cards are
  // tracked automatically); "any printing" falls back to the default one.
  // The local row paints immediately; signed-in users then get the server
  // archive merged in (a longer window than any single device recorded).
  const shownId = scryfallId || oracleCard.defaultScryfallId;
  useEffect(() => {
    let live = true;
    let merged = false;
    void getPriceHistory(shownId).then((h) => {
      if (!live || merged) return;
      setPriceHistory(h ?? null);
      setTrend(h ? historyChange(h) : null);
    });
    void getMergedPriceHistory(shownId).then((h) => {
      if (!live) return;
      merged = true;
      setPriceHistory(h ?? null);
      setTrend(h ? historyChange(h) : null);
    });
    return () => {
      live = false;
    };
  }, [shownId]);

  const printing = useMemo(
    () => printings.find((p) => p.scryfallId === scryfallId),
    [printings, scryfallId],
  );
  // Editions the caller flagged (owned / on a tradelist) group first in the dropdown.
  const highlighted = highlightPrintings ? printings.filter((p) => highlightPrintings.notes.has(p.scryfallId)) : [];
  const otherPrintings = highlighted.length > 0 ? printings.filter((p) => !highlightPrintings!.notes.has(p.scryfallId)) : printings;
  const availableFinishes = printing?.finishes ?? (['nonfoil'] as Finish[]);

  // Full-size image + price for the currently-selected printing (falls back to the oracle default).
  const cardImage = printing?.imageNormal ?? oracleCard.imageNormal ?? printing?.imageSmall ?? oracleCard.imageSmall ?? null;
  const cardPrice = formatPrice(printing, oracleCard) ?? '—';

  // Keep finish valid for the chosen printing.
  useEffect(() => {
    if (printing && !printing.finishes.includes(finish)) setFinish(printing.finishes[0] ?? 'nonfoil');
  }, [printing, finish]);

  const clampedForTrade = Math.min(forTrade, quantity);

  async function save(board: DeckBoard = 'main') {
    setBusy(true);
    if (wishEntry) {
      await updateWishlistEntry(wishEntry.id, { scryfallId: scryfallId || null, quantity });
    } else if (deckCard) {
      await updateDeckCard(deckCard.id, { quantity, scryfallId });
    } else if (editing && entry) {
      await updateCollectionEntry(entry.id, {
        scryfallId,
        condition,
        finish,
        lang,
        quantity,
        quantityForTrade: clampedForTrade,
      });
    } else if (addTo.kind === 'wishlist') {
      await addToWishlist({ oracleId: oracleCard.oracleId, scryfallId: scryfallId || null, quantity });
    } else if (addTo.kind === 'deck') {
      await addDeckCard({ deckId: addTo.deckId, oracleId: oracleCard.oracleId, scryfallId, board, quantity });
    } else {
      // 'collection' and 'tradelist' both add a collection entry; the latter
      // just starts with copies marked for trade.
      await addToCollection({
        oracleId: oracleCard.oracleId,
        scryfallId,
        condition,
        finish,
        lang,
        quantity,
        quantityForTrade: clampedForTrade,
      });
    }
    onClose();
  }

  /** Enter in a quantity field commits the sheet, like a form submit. */
  function saveOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !busy) void save();
  }

  async function del() {
    setBusy(true);
    if (wishEntry) await removeFromWishlist(wishEntry.id);
    else if (deckCard) await removeDeckCard(deckCard.id);
    else if (entry) await removeFromCollection(entry.id);
    onClose();
  }

  // Portal to <body>: the sheet must escape any stacking context its opener
  // lives in (e.g. the search overlay), or the tab bar can cover its buttons.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={mode === 'info' ? oracleCard.name : `${mode === 'add' ? 'Add' : 'Edit'} ${oracleCard.name}`}
      >
        <div className="sheet-head">
          {cardImage ? (
            <div className="sheet-card-wrap">
              <img className="sheet-card" src={cardImage} alt={oracleCard.name} />
              {finish !== 'nonfoil' && <span className="foil-sheen" aria-hidden />}
            </div>
          ) : (
            <div className="sheet-card sheet-card-ph">{oracleCard.name}</div>
          )}
          <div className="sheet-info">
            <div className="sheet-name">{oracleCard.name}</div>
            {oracleCard.manaCost && (
              <div className="result-sub">
                <ManaCost cost={oracleCard.manaCost} />
              </div>
            )}
            <div className="result-sub">{oracleCard.typeLine}</div>
            <div className="result-price">{cardPrice}</div>
            {trend && trend.points > 1 && <PriceTrend trend={trend} />}
          </div>
        </div>

        <div className="seg-row sheet-tabs" role="tablist" aria-label="Card view">
          <button
            role="tab"
            aria-selected={tab === 'details'}
            className={tab === 'details' ? 'seg seg-active' : 'seg'}
            onClick={() => setTab('details')}
          >
            Details
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'seg seg-active' : 'seg'}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>

        {tab === 'history' ? (
          <>
            <CardHistory
              oracleCard={oracleCard}
              printings={printings}
              priceHistory={priceHistory}
              editMode={editMode}
              onEventClick={(e: UserEvent) => setEventEntry({ kind: 'single', id: e.id, ts: e.ts, event: e })}
            />
            <div className="sheet-actions">
              {canToggleEdit && (
                <button onClick={() => setEditMode((v) => !v)}>{editMode ? 'Done' : 'Edit'}</button>
              )}
              <button className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
        <>
        {oracleCard.oracleText && (
          <SymbolText className="oracle-text" text={oracleCard.oracleText} />
        )}

        <label className="field">
          <span>Edition</span>
          <div className={`edition-select${printing ? ' with-symbol' : ''}`}>
            {printing && <SetSymbol set={printing.set} className="edition-symbol" title={printing.setName} />}
            <select
              value={scryfallId}
              onChange={(e) => {
                setScryfallId(e.target.value);
                onEditionChange?.(e.target.value);
              }}
              disabled={!formEditable && !onEditionChange}
            >
              {(mode === 'wish' || wishAdd) && <option value={ANY_PRINTING}>Any printing</option>}
              {highlighted.length > 0 ? (
                <>
                  <optgroup label={highlightPrintings!.label}>
                    {highlighted.map((p) => printingOption(p, highlightPrintings!.notes.get(p.scryfallId)))}
                  </optgroup>
                  <optgroup label="Other printings">{otherPrintings.map((p) => printingOption(p))}</optgroup>
                </>
              ) : (
                printings.map((p) => printingOption(p))
              )}
            </select>
          </div>
        </label>

        {collectionFields && (
        <div className="field-grid">
          <label className="field">
            <span>Condition</span>
            <select value={condition} onChange={(e) => setCondition(e.target.value as Condition)} disabled={!formEditable}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Finish</span>
            <select value={finish} onChange={(e) => setFinish(e.target.value as Finish)} disabled={!formEditable}>
              {availableFinishes.map((f) => (
                <option key={f} value={f}>
                  {FINISH_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={!formEditable}>
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        )}

        {mode !== 'info' && (
        <div className="field-grid">
          <label className="field">
            <span>Quantity</span>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              onKeyDown={saveOnEnter}
              disabled={!formEditable}
            />
          </label>
          {collectionFields && (
            <label className="field">
              <span>For trade</span>
              <input
                type="number"
                min={0}
                max={quantity}
                value={clampedForTrade}
                onChange={(e) => setForTrade(Math.max(0, Number(e.target.value) || 0))}
                onKeyDown={saveOnEnter}
                disabled={!formEditable}
              />
            </label>
          )}
        </div>
        )}

        {mode === 'info' ? (
          <div className="sheet-actions">
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : canToggleEdit && !editMode ? (
          <div className="sheet-actions">
            <button className="primary" onClick={() => setEditMode(true)}>
              <Icon name="edit" size={16} /> Edit
            </button>
            <button onClick={onClose}>Close</button>
          </div>
        ) : (
          <div className="sheet-actions">
            {mode !== 'add' && (
              <button className="danger-outline" onClick={del} disabled={busy}>
                Remove
              </button>
            )}
            <button onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {deckAdd && addTo.kind === 'deck' && addTo.format === 'commander' && (
              <button onClick={() => save('commander')} disabled={busy}>
                Add as commander
              </button>
            )}
            {deckAdd && (
              <button onClick={() => save('side')} disabled={busy}>
                Add to sideboard
              </button>
            )}
            <button className="primary" onClick={() => save()} disabled={busy}>
              {mode === 'add' ? ADD_LABEL[addTo.kind] : 'Save'}
            </button>
          </div>
        )}
        </>
        )}
      </div>

      {eventEntry && (
        <EventSheet
          entry={eventEntry}
          onOpenCard={(oracle, scryfallId) => {
            setEventEntry(null);
            // Same card: just switch this sheet to its history. Different card
            // (a batch line): open a nested sheet on its history tab.
            if (oracle.oracleId === oracleCard.oracleId) setTab('history');
            else setNestedCard({ oracle, scryfallId });
          }}
          onClose={() => setEventEntry(null)}
        />
      )}
      {nestedCard && (
        <CardSheet
          oracleCard={nestedCard.oracle}
          initialScryfallId={nestedCard.scryfallId}
          initialTab="history"
          readOnly
          onClose={() => setNestedCard(null)}
        />
      )}
    </div>,
    document.body,
  );
}

/** Recorded price movement of the shown printing: sparkline + change since tracking began. */
function PriceTrend({ trend }: { trend: HistoryChange }) {
  const dir = trend.delta > 0.001 ? 'up' : trend.delta < -0.001 ? 'down' : 'flat';
  const sym = trend.cur === 'eur' ? '€' : '$';
  return (
    <div className="sheet-price-trend">
      <Sparkline values={trend.series} />
      <div className={`price-change price-${dir}`}>
        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {sym}
        {Math.abs(trend.delta).toFixed(2)}
        {trend.pct != null && ` (${trend.pct >= 0 ? '+' : '−'}${Math.abs(trend.pct).toFixed(1)}%)`}
        <span className="fine-print"> · {trend.points} pts</span>
      </div>
    </div>
  );
}
