import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
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
import { canBeCommander } from '../deck/legality.js';
import { db } from '../db/schema.js';
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

// Bottom-sheet for a card's details, in six modes:
//  - add (default): add the card somewhere new — where depends on addTarget
//    (collection with edition/condition/qty/…, wishlist, tradelist, or a deck)
//  - edit (entry): edit an existing collection entry — covers the tradelist
//    via the "for trade" quantity (beta plan §4/§6)
//  - wish (wishEntry): edit a wishlist line — edition (incl. "any printing")
//    and quantity
//  - deck (deckCard): edit a deck slot's quantity
//  - session (sessionCard): edit a scan-session line in memory — Apply reports
//    the values through onApply instead of writing to Dexie
//  - info (readOnly): app-wide card info — image, printings, price + history

/** Where add mode sends the card (mirrors the context-sensitive search).
 *  'default' is search from a context-free page: the collection form, with
 *  wishlist/tradelist offered as alternative buttons. */
export type AddTarget =
  | { kind: 'collection' }
  | { kind: 'wishlist' }
  | { kind: 'tradelist' }
  | { kind: 'deck'; deckId: string; format?: DeckFormat }
  | { kind: 'default' };

const ADD_LABEL: Record<AddTarget['kind'], string> = {
  collection: 'Add to collection',
  wishlist: 'Add to wishlist',
  tradelist: 'Add to tradelist',
  deck: 'Add to mainboard',
  default: 'Add to collection',
};

/**
 * A scan-session line as the sheet edits it. Fields the scan target doesn't
 * track (e.g. condition for a deck) are left undefined and stay hidden;
 * quantity 0 means "remove the line".
 */
export interface SessionCardValues {
  scryfallId: string;
  quantity: number;
  lang?: string;
  finish?: Finish;
  condition?: Condition;
}

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
  sessionCard,
  onApply,
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
  /** Edit this scan-session line in memory; Apply reports through onApply. */
  sessionCard?: SessionCardValues;
  /** Session mode: called with the edited values instead of writing to Dexie. */
  onApply?: (values: SessionCardValues) => void;
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
  const mode = wishEntry ? 'wish' : deckCard ? 'deck' : entry ? 'edit' : sessionCard ? 'session' : readOnly ? 'info' : 'add';
  const editing = mode === 'edit';
  // An owned collection entry opens read-only with an Edit toggle; add/wish/
  // deck/session are always a form; info is never editable.
  const [editMode, setEditMode] = useState(false);
  const canToggleEdit = mode === 'edit';
  const formEditable = mode === 'add' || mode === 'wish' || mode === 'deck' || mode === 'session' || (mode === 'edit' && editMode);
  const addTo: AddTarget = (mode === 'add' && addTarget) || { kind: 'collection' };
  // Wishlist adds default to "any printing"; deck slots don't store an edition
  // at all, so those variants drop the collection-specific fields below.
  const wishAdd = mode === 'add' && addTo.kind === 'wishlist';
  const deckAdd = mode === 'add' && addTo.kind === 'deck';
  const collectionFields =
    mode === 'edit' ||
    (mode === 'add' && (addTo.kind === 'collection' || addTo.kind === 'tradelist' || addTo.kind === 'default'));
  // Session lines only edit the fields their scan target tracks.
  const showCondition = mode === 'session' ? sessionCard!.condition !== undefined : collectionFields;
  const showFinish = mode === 'session' ? sessionCard!.finish !== undefined : collectionFields;
  const showLang = mode === 'session' ? sessionCard!.lang !== undefined : collectionFields;
  const [printings, setPrintings] = useState<Priced<Printing>[]>([]);
  // In wish mode the empty string means "any printing" (no specific edition).
  const [scryfallId, setScryfallId] = useState(
    wishEntry !== undefined || wishAdd
      ? wishEntry?.scryfallId ?? ANY_PRINTING
      : entry?.scryfallId ?? deckCard?.scryfallId ?? sessionCard?.scryfallId ?? initialScryfallId ?? oracleCard.defaultScryfallId,
  );
  const [condition, setCondition] = useState<Condition>(entry?.condition ?? sessionCard?.condition ?? 'NM');
  const [finish, setFinish] = useState<Finish>(entry?.finish ?? sessionCard?.finish ?? 'nonfoil');
  const [lang, setLang] = useState(entry?.lang ?? sessionCard?.lang ?? 'en');
  const [quantity, setQuantity] = useState(entry?.quantity ?? wishEntry?.quantity ?? deckCard?.quantity ?? sessionCard?.quantity ?? 1);
  const [forTrade, setForTrade] = useState(entry?.quantityForTrade ?? (addTo.kind === 'tradelist' ? 1 : 0));
  const [busy, setBusy] = useState(false);
  const [trend, setTrend] = useState<HistoryChange | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceHistory | null>(null);
  const [tab, setTab] = useState<'details' | 'history'>(initialTab ?? 'details');
  // Visual "view all editions" grid, layered over the sheet.
  const [allEditions, setAllEditions] = useState(false);
  // Filter the (often very long) Edition dropdown by set name or set code.
  const [editionQuery, setEditionQuery] = useState('');
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
  // "Do I own this card (any printing)?" — live so it reflects edits made from
  // this very sheet. Shown everywhere except plain edit mode, where the entry
  // being edited already proves ownership.
  const ownedEntries = useLiveQuery(
    () => db.collection.where('oracleId').equals(oracleCard.oracleId).toArray(),
    [oracleCard.oracleId],
  );
  const ownedQty = ownedEntries?.reduce((s, e) => s + e.quantity, 0) ?? 0;
  const ownedForTrade = ownedEntries?.reduce((s, e) => s + e.quantityForTrade, 0) ?? 0;
  // Do we own the exact printing currently shown? (Not just some other edition.)
  const ownsExact = !!scryfallId && (ownedEntries?.some((e) => e.scryfallId === scryfallId) ?? false);
  // Editions the caller flagged (owned / on a tradelist) group first in the dropdown.
  const highlighted = highlightPrintings ? printings.filter((p) => highlightPrintings.notes.has(p.scryfallId)) : [];
  const otherPrintings = highlighted.length > 0 ? printings.filter((p) => !highlightPrintings!.notes.has(p.scryfallId)) : printings;
  // Dropdown filter: match set name or set code. Always keep the current
  // selection visible so the native <select> displays the right value.
  const editionQ = editionQuery.trim().toLowerCase();
  const matchesQuery = (p: Priced<Printing>) =>
    p.scryfallId === scryfallId ||
    !editionQ ||
    p.setName.toLowerCase().includes(editionQ) ||
    p.set.toLowerCase().includes(editionQ);
  const visibleHighlighted = highlighted.filter(matchesQuery);
  const visibleOther = otherPrintings.filter(matchesQuery);
  const showEditionSearch = (formEditable || !!onEditionChange) && printings.length > 6;
  const availableFinishes = printing?.finishes ?? (['nonfoil'] as Finish[]);

  // Full-size image + price for the currently-selected printing (falls back to the oracle default).
  const cardImage = printing?.imageNormal ?? oracleCard.imageNormal ?? printing?.imageSmall ?? oracleCard.imageSmall ?? null;
  const cardPrice = formatPrice(printing, oracleCard) ?? '—';

  // Keep finish valid for the chosen printing.
  useEffect(() => {
    if (printing && !printing.finishes.includes(finish)) setFinish(printing.finishes[0] ?? 'nonfoil');
  }, [printing, finish]);

  const clampedForTrade = Math.min(forTrade, quantity);

  /** Session mode: the edited line as reported back, mirroring the hidden fields. */
  function sessionValues(qty: number): SessionCardValues {
    return {
      scryfallId,
      quantity: qty,
      lang: sessionCard?.lang !== undefined ? lang : undefined,
      finish: sessionCard?.finish !== undefined ? finish : undefined,
      condition: sessionCard?.condition !== undefined ? condition : undefined,
    };
  }

  /** `dest` picks where a context-free ('default') add goes; other targets ignore it. */
  async function save(board: DeckBoard = 'main', dest: 'collection' | 'wishlist' | 'tradelist' = 'collection') {
    setBusy(true);
    if (sessionCard) {
      onApply?.(sessionValues(quantity));
    } else if (wishEntry) {
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
    } else if (addTo.kind === 'wishlist' || dest === 'wishlist') {
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
        quantityForTrade: dest === 'tradelist' ? clampedForTrade || 1 : clampedForTrade,
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
    // A session line isn't stored anywhere yet — quantity 0 tells the scan
    // list to drop it.
    if (sessionCard) onApply?.(sessionValues(0));
    else if (wishEntry) await removeFromWishlist(wishEntry.id);
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
            {mode !== 'edit' && ownedQty > 0 && (
              <div
                className={`badge sheet-owned ${ownedForTrade > 0 ? 'own-trade' : 'own-yes'}`}
                title={
                  (ownedForTrade > 0
                    ? `You own ${ownedQty} (${ownedForTrade} for trade)`
                    : `You own ${ownedQty}`) +
                  (ownsExact ? ' · including this exact printing' : ' · other printing(s)')
                }
              >
                <Icon name={ownedForTrade > 0 ? 'tradelist' : ownsExact ? 'checkDouble' : 'check'} size={13} />
                In your collection (×{ownedQty}
                {ownedForTrade > 0 ? `, ${ownedForTrade} for trade` : ''})
              </div>
            )}
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
          {showEditionSearch && (
            <input
              type="text"
              className="edition-search"
              value={editionQuery}
              onChange={(e) => setEditionQuery(e.target.value)}
              placeholder="Filter by set name or code (e.g. MH2)"
              aria-label="Filter editions by set name or code"
            />
          )}
          <div className="edition-row">
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
                    {visibleHighlighted.length > 0 && (
                      <optgroup label={highlightPrintings!.label}>
                        {visibleHighlighted.map((p) => printingOption(p, highlightPrintings!.notes.get(p.scryfallId)))}
                      </optgroup>
                    )}
                    {visibleOther.length > 0 && (
                      <optgroup label="Other printings">{visibleOther.map((p) => printingOption(p))}</optgroup>
                    )}
                  </>
                ) : (
                  printings.filter(matchesQuery).map((p) => printingOption(p))
                )}
              </select>
            </div>
            {(formEditable || !!onEditionChange) && printings.length > 0 && (
              <button
                type="button"
                className="edition-grid-btn"
                onClick={() => setAllEditions(true)}
                aria-label="View all editions"
                title="View all editions"
              >
                <Icon name="grid" size={18} />
              </button>
            )}
          </div>
        </label>

        {(showCondition || showFinish || showLang) && (
        <div className="field-grid">
          {showCondition && (
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
          )}
          {showFinish && (
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
          )}
          {showLang && (
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
          )}
        </div>
        )}

        {mode !== 'info' && (
        <div className="field-grid">
          <label className="field">
            <span>Quantity</span>
            <QtyStepper value={quantity} min={1} disabled={!formEditable} onChange={setQuantity} onEnter={saveOnEnter} />
          </label>
          {collectionFields && (
            <label className="field">
              <span>For trade</span>
              <QtyStepper value={clampedForTrade} min={0} max={quantity} disabled={!formEditable} onChange={setForTrade} onEnter={saveOnEnter} />
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
            {deckAdd && addTo.kind === 'deck' && addTo.format === 'commander' && canBeCommander(oracleCard) && (
              <button onClick={() => save('commander')} disabled={busy}>
                Add as commander
              </button>
            )}
            {deckAdd && (
              <button onClick={() => save('side')} disabled={busy}>
                Add to sideboard
              </button>
            )}
            {mode === 'add' && addTo.kind === 'default' && (
              <>
                <button onClick={() => save('main', 'wishlist')} disabled={busy}>
                  Add to wishlist
                </button>
                <button onClick={() => save('main', 'tradelist')} disabled={busy}>
                  Add to tradelist
                </button>
              </>
            )}
            <button className="primary" onClick={() => save()} disabled={busy}>
              {mode === 'add' ? ADD_LABEL[addTo.kind] : mode === 'session' ? 'Apply' : 'Save'}
            </button>
          </div>
        )}
        </>
        )}
      </div>

      {allEditions && (
        <EditionPicker
          printings={highlighted.length > 0 ? [...highlighted, ...otherPrintings] : printings}
          selected={scryfallId}
          anyOption={mode === 'wish' || wishAdd}
          notes={highlightPrintings?.notes}
          onSelect={(id) => {
            setScryfallId(id);
            onEditionChange?.(id);
            setAllEditions(false);
          }}
          onClose={() => setAllEditions(false)}
        />
      )}
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

/** Quantity field as a −/+ stepper: taps cover the common case, so the soft
 *  keyboard (which covers most of the sheet on phones) only appears when the
 *  user really wants to type — and then it's the numeric one. */
function QtyStepper({
  value,
  min,
  max,
  disabled,
  onChange,
  onEnter,
}: {
  value: number;
  min: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const clamp = (v: number) => Math.max(min, max !== undefined ? Math.min(max, v) : v);
  return (
    <div className="qty-stepper">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label="One less">
        <Icon name="minus" size={16} />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={onEnter}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        disabled={disabled || (max !== undefined && value >= max)}
        aria-label="One more"
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

/** Every printing as an image tile — pick an edition by looking at it. */
export function EditionPicker({
  printings,
  selected,
  anyOption,
  notes,
  onSelect,
  onClose,
}: {
  printings: Priced<Printing>[];
  selected: string;
  /** Lead with the wishlist's "any printing" tile. */
  anyOption?: boolean;
  /** Short annotations per printing (e.g. the trade board's "×2, 1 for trade"). */
  notes?: Map<string, string>;
  onSelect: (scryfallId: string) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  // stopPropagation on the backdrop: this overlay nests inside the card
  // sheet's backdrop, whose click handler would otherwise also close the sheet.
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="sheet edition-picker-sheet" role="dialog" aria-label="All editions" onClick={(e) => e.stopPropagation()}>
        <div className="edition-picker-head">
          <h2>All editions</h2>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="edition-grid">
          {anyOption && (
            <button className={selected === ANY_PRINTING ? 'edition-tile edition-tile-selected' : 'edition-tile'} onClick={() => onSelect(ANY_PRINTING)}>
              <span className="edition-tile-ph">Any printing</span>
              <span className="edition-tile-caption">No specific edition</span>
            </button>
          )}
          {printings.map((p) => {
            const img = p.imageSmall ?? p.imageNormal;
            return (
              <button
                key={p.scryfallId}
                className={p.scryfallId === selected ? 'edition-tile edition-tile-selected' : 'edition-tile'}
                onClick={() => onSelect(p.scryfallId)}
              >
                {img ? <img src={img} alt={p.setName} loading="lazy" /> : <span className="edition-tile-ph">{p.setName}</span>}
                <span className="edition-tile-caption">
                  <SetSymbol set={p.set} title={p.setName} /> {p.set.toUpperCase()} #{p.collectorNumber} · {p.releasedAt.slice(0, 4)}
                </span>
                <span className="edition-tile-sub">{notes?.get(p.scryfallId) ?? formatPrice(p) ?? ''}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
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
