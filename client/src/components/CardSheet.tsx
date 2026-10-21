import { useEffect, useMemo, useRef, useState } from 'react';
import type { CopyPrefs, Finish, PriceHistory } from '@mtg/shared';
import { FINISHES } from '@mtg/shared';
import { sortOwnedCopies, usePrintingsForOracle } from '../db/usePrintings.js';
import { BOARD_LABEL } from '../deck/boards.js';
import { useFiling } from '../deck/useFiling.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { useCommandZone } from '../db/useCommandZone.js';
import { PlacementPills } from './PlacementBadge.js';
import { getPriceHistory } from '../price/tracking.js';
import { getMergedPriceHistory } from '../price/serverHistory.js';
import { acquisitionGain, useCostBasis } from '../price/costBasis.js';
import { historyChange, readingsFor } from '../price/history.js';
import { preferredScryfallId } from '../cardDb/preferredPrinting.js';
import { cycleSlugsOf } from '../cardDb/oracleTags.js';
import { useOracleTags } from '../cardDb/useOracleTags.js';
import { useOpenCollectionSearch, useOpenDbSearch } from '../search/searchContext.js';
import { Icon, type IconName } from './icons.js';
import { OptionsMenu } from './OptionsMenu.js';
import { OracleSearchChip, useOracleSelection } from './OracleSearchChip.js';
import { PriceTrend } from './PriceTrend.js';
import { useToast } from './Toast.js';
import { useUndoToast } from './useUndoToast.js';
import { formatPrice, pickPrice, pricedForFinish } from './CardSorting.js';
import { ManaCost, SymbolText } from './ManaCost.js';
import { SetSymbol } from './SetSymbol.js';
import { Sheet } from './Sheet.js';
import { TagField } from './TagField.js';
import { sumQty } from '../util/groupBy.js';
import { QtyStepper } from './QtyStepper.js';
import { CardArt } from './cardSheet/CardArt.js';
import { CardSheetActions } from './cardSheet/CardSheetActions.js';
import { CardSheetOverlays } from './cardSheet/CardSheetOverlays.js';
import { CopyStrip } from './cardSheet/CopyStrip.js';
import { orderByOwned } from './cardSheet/EditionGrid.js';
import { commandZoneDeckId, modeFlags, type ModeInput } from './cardSheet/modeFlags.js';
import { OwnedHere } from './cardSheet/OwnedHere.js';
import { cardSheetActions } from './cardSheet/save.js';
import { TraitsRow } from './cardSheet/TraitsRow.js';
import { clampFinish, formFrom, initialForm, useCardForm } from './cardSheet/useCardForm.js';
import { ANY_PRINTING, LIST_META, type CardSheetProps, type ListKind, type Overlay } from './cardSheet/types.js';

export type { AddTarget, SessionCardValues } from './cardSheet/types.js';

// Bottom-sheet for a card's details, in six modes the caller names outright
// (see CardSheetProps, which carries what each one needs and nothing else):
//  - add: add the card somewhere new — where depends on addTarget (collection
//    with edition/condition/qty/…, wishlist, tradelist, or a deck)
//  - edit: edit an existing collection entry — covers the tradelist via the
//    "for trade" quantity (beta plan §4/§6)
//  - wish: edit a wishlist line — edition (incl. "any printing") and quantity
//  - deck: edit a deck slot's quantity
//  - session: edit a scan-session line in memory — Apply reports the values
//    through onApply instead of writing to Dexie
//  - info: app-wide card info — image, printings, price + history
//
// Any mode can step sideways into add mode ("Add to your collection" from a card
// you're only viewing, "Got it" on a wish): `addFlow` names the list and the
// sheet turns into the real add form for it, so nothing about the copy is
// guessed on the user's behalf. Cancel steps back to where they were.
//
// The parts live in cardSheet/: which switches each mode flips (modeFlags), the
// form and how it's filled (useCardForm), the writes (save), and the pieces of
// the sheet itself.

export function CardSheet(props: CardSheetProps) {
  const { oracleCard, initialScryfallId, highlightPrintings, loaded, onClose } = props;
  // The current mode's own props, unpacked once. Everything below reads these
  // rather than narrowing `props` at each of the sites that ask.
  // Stacked printings: the tile the sheet opened from stood for several copies
  // (or slots), and the strip under the price steps between them. Which one is
  // up is the sheet's own business; the caller only hands the list over.
  const copies = props.mode === 'edit' ? props.copies : props.mode === 'deck' ? props.slots : undefined;
  const [pickedCopyId, setPickedCopyId] = useState<string | null>(null);
  const entry =
    props.mode === 'edit' ? props.copies?.find((c) => c.id === pickedCopyId) ?? props.entry : undefined;
  const wishEntry = props.mode === 'wish' ? props.wishEntry : undefined;
  const wishView = props.mode === 'info' ? props.wishView : undefined;
  const deckCard =
    props.mode === 'deck' ? props.slots?.find((s) => s.id === pickedCopyId) ?? props.deckCard : undefined;
  const sessionCard = props.mode === 'session' ? props.sessionCard : undefined;

  // Stepping sideways into an add form from another mode (see the note above):
  // the list being added to, or null for "the sheet as its caller opened it".
  const [addFlow, setAddFlow] = useState<ListKind | null>(null);
  // An owned collection entry opens read-only with an Edit toggle.
  const [editMode, setEditMode] = useState(false);
  const modeInput: ModeInput = {
    propsMode: props.mode,
    addFlow,
    addTarget: props.mode === 'add' ? props.addTarget : undefined,
    editMode,
    deckCard,
    sessionCard,
    hasWishView: !!wishView,
  };
  // Who's in the command zone right now. The command-zone buttons need the
  // actual cards, not just a count: a Background or a Partner is only offered
  // when it pairs with whoever is already there (see canJoinCommandZone).
  const commandZoneCards = useCommandZone(commandZoneDeckId(modeInput));
  const commandZone = useMemo(() => (commandZoneCards ?? []).map((z) => z.card), [commandZoneCards]);
  const flags = modeFlags(modeInput, oracleCard, commandZone);
  const { mode, formEditable, wishMode, deckPrefs, anyPrefs, basicAny, zones } = flags;

  const openCollectionSearch = useOpenCollectionSearch();
  const openDbSearch = useOpenDbSearch();
  // Highlighting a phrase in the rules text offers to search the database for it.
  const oracleSelection = useOracleSelection(oracleCard.oracleText, oracleCard.name);
  // The cycles this card is part of (Tagger's `cycle` subtree), for the "see
  // the other cards" link. The vocabulary loads lazily; the counter ticks once
  // it's there and the link appears.
  const otagsReady = useOracleTags();
  const cycleSlugs = useMemo(
    () => cycleSlugsOf(oracleCard.tags),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [oracleCard.tags, otagsReady],
  );
  const toast = useToast();
  const undoToast = useUndoToast();
  const { printings, loaded: printingsLoaded } = usePrintingsForOracle(oracleCard.oracleId, loaded?.printings);
  // A printing this card is already tied to: the copy in the collection, the
  // deck's recorded edition, a scanned card, or the one the caller was showing.
  const recordedId = entry?.scryfallId ?? deckCard?.scryfallId ?? sessionCard?.scryfallId ?? initialScryfallId;
  const { form: rawForm, setForm, patch, setCopy } = useCardForm(() =>
    initialForm(flags, {
      entry,
      deckCard,
      sessionCard,
      wishEntry,
      wishView,
      recordedId,
      defaultScryfallId: oracleCard.defaultScryfallId,
    }),
  );
  const { scryfallId, quantity } = rawForm;
  // Which edition the art should show isn't known at first paint: the printings
  // are a Dexie read away, and with nothing recorded the preferred-printing
  // lookup may still move us off the card DB's default. Painting before both
  // settle flashes the wrong edition for a frame, so the frame stays empty
  // until they do. "Any printing" waits on the preferred printing too, so the
  // art doesn't flash the card DB's default first.
  const [preferredSettled, setPreferredSettled] = useState(
    () => scryfallId !== ANY_PRINTING && (!!recordedId || wishMode || mode === 'deck'),
  );
  const editionResolved = printingsLoaded && preferredSettled;
  // The printing an "any printing" wish or slot shows: the printing
  // preference's pick, the same edition a search result for it wears.
  const [anyFaceId, setAnyFaceId] = useState<string | null>(null);
  /** The edition picker is sitting on "any printing" — a basic from the lands box. */
  const anyBasicPicked = basicAny && scryfallId === ANY_PRINTING;

  // Stepping to another copy on the strip: the form is that copy's now. Any
  // half-made change to the previous copy is dropped, same as Cancel.
  function switchCopy(id: string) {
    if (id === (entry?.id ?? deckCard?.id)) return;
    const source =
      props.mode === 'edit'
        ? props.copies?.find((x) => x.id === id)
        : props.mode === 'deck'
          ? props.slots?.find((x) => x.id === id)
          : undefined;
    if (!source) return;
    setPickedCopyId(id);
    setEditMode(false);
    setForm(formFrom(source));
  }

  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(props.openHistory ? { kind: 'history' } : null);
  // The card landed on one of your lists: the sheet says so where the button
  // was, then shows itself out. A toast would fire off-screen behind the sheet,
  // and the answer belongs on the thing you just pressed.
  // Once it's gone, the Undo toast takes over: the add's event id rides along
  // so Undo reverses exactly this add.
  const [added, setAdded] = useState<{ list: ListKind; eventId: string } | null>(null);

  // onClose is usually a fresh arrow from the caller, so hold it in a ref: the
  // goodbye timer must not restart every time the parent re-renders.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => {
      closeRef.current();
      undoToast(`${oracleCard.name} added to ${LIST_META[added.list].label.toLowerCase()}`, added.eventId);
    }, 800);
    return () => window.clearTimeout(t);
  }, [added]);

  // The preferred printing, looked up once per card and used for two things:
  //  - the face an "any printing" wish or slot wears. Looked up for any wish or
  //    slot, not only one that starts on "any": picking "Any printing" in the
  //    edition picker should land on the same face;
  //  - the form's edition when nothing tied this sheet to one (adding a card the
  //    caller didn't resolve a printing for), so the printing preference wins
  //    over the card DB's representative one. Skipped in wish mode, where "any
  //    printing" is the point.
  // One lookup, not one per use: an add into a deck wants both.
  useEffect(() => {
    const wantFace = anyPrefs;
    const wantForm = !recordedId && !wishMode && mode !== 'deck';
    if (!wantFace && !wantForm) return;
    let live = true;
    void preferredScryfallId(oracleCard)
      .then((id) => {
        if (!live) return;
        if (wantFace) setAnyFaceId(id);
        // Don't stomp a choice the user made in the edition picker meanwhile.
        if (wantForm && id !== oracleCard.defaultScryfallId) {
          setForm((f) => (f.scryfallId === oracleCard.defaultScryfallId ? { ...f, scryfallId: id } : f));
        }
      })
      .finally(() => {
        if (live) setPreferredSettled(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleCard.oracleId]);

  // Recorded price history for the shown printing (collection cards are
  // tracked automatically); "any printing" falls back to the default one.
  // The local row paints immediately; signed-in users then get the server
  // archive merged in (a longer window than any single device recorded).
  // A sheet stacked on one for the same printing starts from what it read.
  const shownId = scryfallId || anyFaceId || oracleCard.defaultScryfallId;
  const preloadedHistory = loaded?.priceHistory?.scryfallId === shownId ? loaded.priceHistory : undefined;
  const [priceHistory, setPriceHistory] = useState<PriceHistory | null>(preloadedHistory?.history ?? null);
  useEffect(() => {
    if (preloadedHistory) {
      setPriceHistory(preloadedHistory.history);
      return;
    }
    let live = true;
    let merged = false;
    const local = getPriceHistory(shownId);
    void local.then((h) => {
      if (!live || merged) return;
      setPriceHistory(h ?? null);
    });
    void getMergedPriceHistory(shownId, local).then((h) => {
      if (!live) return;
      merged = true;
      setPriceHistory(h ?? null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId]);

  const printing = useMemo(() => printings.find((p) => p.scryfallId === scryfallId), [printings, scryfallId]);
  // What the art and price read: the chosen edition, or for "any printing" the
  // preferred one. Everything that says *which* edition keeps reading `printing`.
  const facePrinting = useMemo(
    () => printing ?? (scryfallId === ANY_PRINTING ? printings.find((p) => p.scryfallId === anyFaceId) : undefined),
    [printing, printings, scryfallId, anyFaceId],
  );
  // The form as it reads: a concrete finish kept valid for the chosen printing,
  // and no more for trade than there are copies.
  const finish = clampFinish(rawForm.finish, printing, wishMode);
  const form = { ...rawForm, finish, forTrade: Math.min(rawForm.forTrade, quantity) };
  const { condition, lang, tags, zone } = form;

  // What the copies cost, so the trend can say how the card has done for *you*
  // rather than how our archive has done. The history goes in because a copy
  // with no recorded price is valued from the reading nearest the day it went
  // in (see costBasis.ts), and the merged row is the one with the server's
  // longer window in it.
  //
  // The finish goes in twice over, and both matter for a foil. It picks which
  // acquisitions count, and it picks the price the gain is measured *to* — the
  // same quote the header prints, not the tracked line's last reading, which is
  // the nonfoil price and would show a loss on every foil you own.
  const shownFinish: Finish = finish || 'nonfoil';
  // A foil copy reads the foil line once one is on record (v0.198.0); until
  // then it falls back to the nonfoil line and the trend says so.
  const lane = useMemo(() => (priceHistory ? readingsFor(priceHistory, shownFinish) : null), [priceHistory, shownFinish]);
  const trend = useMemo(() => (lane ? historyChange(lane.readings) : null), [lane]);
  const basis = useCostBasis(oracleCard.oracleId, shownId, priceHistory, shownFinish);
  const nowQuote = useMemo(
    () => pickPrice([pricedForFinish(facePrinting, shownFinish), oracleCard]),
    [facePrinting, shownFinish, oracleCard],
  );
  const gain = trend ? acquisitionGain(trend, basis, nowQuote) : null;
  // "Do I own this card (any printing)?" — read off the shared ownership index,
  // which rebuilds on every collection write, so edits made from this very sheet
  // show up. Shown everywhere except plain edit mode, where the entry being
  // edited already proves ownership.
  const ownership = useOwnershipIndex();
  const ownedEntries = ownership?.ownedCopies(oracleCard.oracleId);
  // Where this printing is filed (deck / binder / box) — the pills under the
  // name. Follows the edition picker: switch editions and the pills follow. When
  // the sheet is about one concrete copy (a collection entry) or one slot, its
  // finish/condition/language narrow the pills further, so two copies of a card
  // that differ only in language each point at their own deck. A search hit or a
  // fresh add knows no copy, so it stays per printing.
  const placements = usePlacementIndex();
  const { file, sheet: filingSheet } = useFiling();
  const copyPrefs: CopyPrefs | undefined =
    mode === 'edit' || mode === 'deck'
      ? { condition: condition || undefined, finish: finish || undefined, lang: lang || undefined }
      : undefined;
  const placement = placements?.lookup(oracleCard.oracleId, shownId, copyPrefs);
  const ownedQty = sumQty(ownedEntries ?? []);
  const ownedForTrade = ownedEntries?.reduce((s, e) => s + e.quantityForTrade, 0) ?? 0;
  // Do we own the exact printing currently shown? (Not just some other edition.)
  const ownsExact = !!scryfallId && (ownedEntries?.some((e) => e.scryfallId === scryfallId) ?? false);
  // The exact printings we own — the "view all editions" grid double-checks these.
  const ownedIds = useMemo(() => new Set((ownedEntries ?? []).map((e) => e.scryfallId)), [ownedEntries]);
  // The copies themselves, newest edition first, for "pick one from my collection".
  const ownedCopies = useMemo(() => sortOwnedCopies(ownedEntries ?? [], printings), [ownedEntries, printings]);
  // Printings with copies marked for trade — their edition tile gets the purple tag.
  const ownedForTradeIds = useMemo(
    () => new Set((ownedEntries ?? []).filter((e) => e.quantityForTrade > 0).map((e) => e.scryfallId)),
    [ownedEntries],
  );
  // Editions the caller flagged (owned / on a tradelist) group first in the
  // grid; within the rest, editions the user owns lead so their printing is
  // the easy pick (and its double-check badge is the first thing they see).
  const { highlighted, otherPrintings } = useMemo(() => {
    const notes = highlightPrintings?.notes;
    const highlighted = notes ? printings.filter((p) => notes.has(p.scryfallId)) : [];
    const rest = highlighted.length > 0 ? printings.filter((p) => !notes!.has(p.scryfallId)) : printings;
    return { highlighted, otherPrintings: orderByOwned(rest, ownedIds) };
  }, [printings, highlightPrintings, ownedIds]);
  // A wish can want any finish (esp. an "any printing" wish, where no single
  // printing constrains the choice); a collection entry is limited to what the
  // selected printing actually comes in. A slot follows its edition where it pins
  // one — asking for a foil that was never printed would never match a copy.
  const availableFinishes = wishMode
    ? FINISHES
    : printing?.finishes ?? (deckPrefs ? FINISHES : (['nonfoil'] as Finish[]));

  // Which printing this is, said where the art is: the edition belongs with the
  // card it changes, not as the first field of a form. The set *code*, not its
  // name — beside the art there's about 20 characters to play with, and
  // "Commander Legends: Battle for Baldur's Gate" spent all of them pushing the
  // collector number off the edge. The symbol and its tooltip still name the set.
  const editionLabel = printing
    ? `${printing.set.toUpperCase()} · #${printing.collectorNumber}`
    : anyBasicPicked
      ? 'Any printing, from your lands box'
      : anyPrefs && scryfallId === ANY_PRINTING
        ? 'Any printing'
        : '';
  const cardPrice = formatPrice(pricedForFinish(facePrinting, shownFinish), oracleCard) ?? '—';

  const actions = cardSheetActions({
    oracleCard,
    flags,
    form,
    printing,
    anyBasicPicked,
    entry,
    wishEntry,
    deckCard,
    sessionCard,
    onApply: props.mode === 'session' ? props.onApply : undefined,
    onAdded: props.mode === 'add' ? props.onAdded : undefined,
    ownedQty,
    file,
    toast,
    setBusy,
    setAdded,
    setOverlay,
    patch,
    setAddFlow,
    onClose,
  });

  /** Enter in a quantity field commits the sheet, like a form submit. */
  function saveOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !busy) void actions.save();
  }

  return (
    // Its own backdrop class: at 900px and up this one centers the sheet
    // instead of sitting it on the bottom edge (see styles.css).
    <Sheet
      onClose={onClose}
      dismiss={busy ? null : onClose}
      className="card-sheet"
      backdropClassName="card-sheet-backdrop"
      label={mode === 'info' ? oracleCard.name : `${mode === 'add' ? 'Add' : 'Edit'} ${oracleCard.name}`}
    >
        {/* Name and the two controls span the sheet, above the art. Beside the
            art they were sharing a 168px column with a ⋯ and an ✕, which a card
            called "_____ _____ Rocketship" wins by pushing them off the edge. */}
        <div className="sheet-name-row">
          {/* Stepped into the add form from another mode: back out to the sheet
              they were reading, not out of the card entirely. */}
          {addFlow && (
            <button type="button" className="sheet-close" onClick={() => setAddFlow(null)} disabled={busy} aria-label="Back" title="Back">
              <Icon name="chevronLeft" size={18} />
            </button>
          )}
          <div className="sheet-name">{oracleCard.name}</div>
          <OptionsMenu
            label="Card options"
            actions={[
              { label: 'Collection history', icon: 'history', onClick: () => setOverlay({ kind: 'history' }) },
              // Only reachable by tapping the sparkline until now, which made
              // it invisible on a card whose trend we can't draw yet.
              ...(priceHistory
                ? [{ label: 'Price history', icon: 'prices' as IconName, onClick: () => setOverlay({ kind: 'chart' }) }]
                : []),
              ...(flags.editionPickable && printings.length > 0
                ? [{ label: 'All printings', icon: 'grid' as IconName, onClick: () => setOverlay({ kind: 'editions' }) }]
                : []),
              { label: 'Find sealed products with this card', icon: 'sealed', onClick: () => setOverlay({ kind: 'sealed' }) },
              { label: 'Format legality', icon: 'balance', onClick: () => setOverlay({ kind: 'legality' }) },
            ]}
          />
          {/* The way out, in the same place on every mode. The action row used
              to spend 54px on a Close button doing what the backdrop and
              Escape already do. */}
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* Head and form scroll as one. The rules text lives beside the art now,
            and text has no upper bound, so a head pinned at its natural height
            would squeeze the form to nothing on a card with five abilities.
            (At 900px and up this element is display:contents and the two go
            back to being their own columns — see styles.css.) */}
        <div className="sheet-scroll">
        <div className="sheet-head">
          <CardArt
            oracleCard={oracleCard}
            facePrinting={facePrinting}
            scryfallId={scryfallId}
            editionResolved={editionResolved}
            foil={!!finish && finish !== 'nonfoil'}
            zoomed={overlay?.kind === 'zoom'}
            onZoom={() => setOverlay({ kind: 'zoom' })}
            onUnzoom={() => setOverlay(null)}
          />
          {/* What the card *is* rides in the column beside the art: cost, type,
              which printing this is, and the rules text. What your copy is
              worth and where it's filed are answers about your collection, so
              they lead the form below instead. */}
          <div className="sheet-info">
            <div className="result-sub sheet-typeline">
              {oracleCard.manaCost && <ManaCost cost={oracleCard.manaCost} />}
              <span>{oracleCard.typeLine}</span>
            </div>
            {editionResolved && editionLabel !== '' && (
              flags.editionPickable ? (
                <button
                  type="button"
                  className="sheet-edition"
                  onClick={() => setOverlay({ kind: 'editions' })}
                  aria-label={`Printing: ${editionLabel}. Choose another`}
                  title="Choose a printing"
                >
                  {printing ? (
                    <SetSymbol set={printing.set} className="sheet-edition-symbol" title={printing.setName} />
                  ) : (
                    <span className="sheet-edition-symbol" aria-hidden />
                  )}
                  <span className="sheet-edition-name">{editionLabel}</span>
                  <Icon name="chevronDown" size={14} />
                </button>
              ) : (
                // Not yours to flip (a copy you're only looking at, someone
                // else's wish): the answer as text, never as a dead dropdown.
                <div className="sheet-edition sheet-edition-static">
                  {printing && <SetSymbol set={printing.set} className="sheet-edition-symbol" title={printing.setName} />}
                  <span className="sheet-edition-name">{editionLabel}</span>
                </div>
              )
            )}
            {/* The rules text, never clipped and never behind a link: selecting
                a phrase here searches the database for it (OracleSearchChip),
                which is most of why the text is on this sheet at all. */}
            {oracleCard.oracleText && (
              <SymbolText className="oracle-text sheet-oracle" text={oracleCard.oracleText} />
            )}
            {oracleSelection && (
              <OracleSearchChip
                selection={oracleSelection}
                onSearch={(query) => {
                  onClose();
                  openDbSearch(query);
                }}
              />
            )}
            {/* The card's cycle-mates (bondlands, shocklands, …), one search
                away. Only when Tagger filed the card in a cycle; a card in
                several searches them all at once. */}
            {cycleSlugs.length > 0 && (
              <button
                type="button"
                className="linklike sheet-cycle-link"
                onClick={() => {
                  onClose();
                  openDbSearch(cycleSlugs.map((s) => `otag:${s}`).join(' or '));
                }}
              >
                <Icon name="refresh" size={14} />
                {cycleSlugs.length > 1 ? 'See the other cards in these cycles' : 'See the other cards in this cycle'}
              </button>
            )}
          </div>
        </div>

        <div className="sheet-body">
        {/* What it's worth, what you already have of it and where those copies
            are filed — the answers-about-your-copies half of the sheet, so they
            lead the form rather than crowding the column beside the art. */}
        <div className="sheet-worth">
          <div className="result-price">{cardPrice}</div>
          {trend && trend.points > 1 && (
            <PriceTrend
              trend={trend}
              gain={gain}
              nonfoilLine={shownFinish !== 'nonfoil' && !lane?.foil}
              onOpen={() => setOverlay({ kind: 'chart' })}
            />
          )}
          {mode !== 'edit' && ownedQty > 0 && (
            <OwnedHere
              qty={ownedQty}
              forTrade={ownedForTrade}
              ownsExact={ownsExact}
              onOpen={
                flags.canOpenInCollection
                  ? () => {
                      onClose();
                      openCollectionSearch(oracleCard.name);
                    }
                  : undefined
              }
            />
          )}
        </div>
        {/* Stack printings: the tile stood for several copies, so here they
            are, one chip each, the one on the form lit. Tapping another swaps
            the whole form over to it. */}
        {copies && copies.length > 1 && (
          <CopyStrip
            copies={copies}
            printings={printings}
            currentId={entry?.id ?? deckCard?.id ?? ''}
            onPick={switchCopy}
          />
        )}
        {/* Where the copies live. A binder name can be long, so the pills wrap
            rather than pushing the form down. */}
        {placement && placement.places.length > 0 && (
          <div className="sheet-places">
            <span className="sheet-places-label">Filed in</span>
            <PlacementPills info={placement} onNavigate={onClose} />
          </div>
        )}

        {/* The shortcut that makes a slot concrete: point it at a copy you
            actually have and the edition, finish, condition and language all come
            along, so the double check means "this very card". */}
        {deckPrefs && formEditable && ownedCopies.length > 0 && (
          <button type="button" className="linklike pick-copy-btn" onClick={() => setOverlay({ kind: 'pickCopy' })}>
            <Icon name="collection" size={14} /> Pick one from my collection
          </button>
        )}

        {/* Keyed on the copy, so stepping to another one folds it back up. */}
        <TraitsRow
          key={`${entry?.id ?? deckCard?.id ?? ''}:${formEditable}`}
          flags={flags}
          form={form}
          forTrade={form.forTrade}
          availableFinishes={availableFinishes}
          hidden={anyBasicPicked}
          onChange={patch}
        />

        {/* Quantity and the slice of it you'd part with, side by side. "For
            trade" is 0 on most copies, but it's a stepper sitting in room the
            quantity row already had, so nothing is gained by hiding it. */}
        {formEditable && (
        <div className="field-grid">
          <label className="field">
            <span>Quantity</span>
            <QtyStepper value={quantity} min={1} onChange={(v) => patch({ quantity: v })} onEnter={saveOnEnter} />
          </label>
          {flags.collectionFields && (
            <label className="field">
              <span>For trade</span>
              <QtyStepper value={form.forTrade} min={0} max={quantity} onChange={(v) => patch({ forTrade: v })} onEnter={saveOnEnter} />
            </label>
          )}
        </div>
        )}

        {/* Which zone the card sits in. A deck's zones are the one thing about a
            slot that used to need a remove and a re-add; now it's a field like
            any other, applied when the sheet is saved. */}
        {formEditable && zones.some((z) => !z.refusal && z.board !== zone) && (
          <div className="field">
            <span>Zone</span>
            <div className="seg-row zone-row" role="radiogroup" aria-label="Zone">
              {zones.map((z) => (
                <button
                  key={z.board}
                  type="button"
                  role="radio"
                  aria-checked={zone === z.board}
                  className={zone === z.board ? 'seg seg-active' : 'seg'}
                  disabled={!!z.refusal && zone !== z.board}
                  title={z.refusal}
                  onClick={() => patch({ zone: z.board })}
                >
                  {z.label}
                </button>
              ))}
            </div>
            {zone !== (deckCard?.board ?? 'main') && (
              <p className="fine-print zone-note">
                Moves out of the {BOARD_LABEL[deckCard?.board ?? 'main'].toLowerCase()} when you save.
              </p>
            )}
          </div>
        )}

        {/* Slot tags: your own labels on this card in this list ("Ramp",
            "Turn-3 play"), which the group-by-tag view reads. */}
        {mode === 'deck' && deckCard?.deckId && (
          <TagField deckId={deckCard.deckId} tags={tags} onChange={(t) => patch({ tags: t })} />
        )}

        {/* The slot was emptied out on purpose, and saving names the copy it
            holds — so say so before it quietly goes back on the shelf. */}
        {mode === 'deck' && deckCard?.unfiled && (
          <p className="fine-print">
            This copy is out of the list right now. Saving files it back in.
          </p>
        )}

        </div>
        </div>

        <CardSheetActions
          flags={flags}
          oracleCard={oracleCard}
          commandZone={commandZone}
          busy={busy}
          added={added}
          editMode={editMode}
          onEdit={() => setEditMode(true)}
          onFileAway={() => setOverlay({ kind: 'pickContainer' })}
          hideRemove={props.mode === 'session' && props.hideRemove === true}
          applyLabel={props.mode === 'session' ? props.applyLabel : undefined}
          actions={actions}
          onClose={onClose}
        />

      <CardSheetOverlays
        overlay={overlay}
        setOverlay={setOverlay}
        oracleCard={oracleCard}
        printing={printing}
        printings={printings}
        shownId={shownId}
        priceHistory={priceHistory}
        shownFinish={shownFinish}
        nowQuote={nowQuote}
        editions={{
          printings: highlighted.length > 0 ? [...highlighted, ...otherPrintings] : otherPrintings,
          anyOption: anyPrefs || basicAny,
          notes: highlightPrintings?.notes,
          ownedIds,
          ownedForTradeIds,
        }}
        form={form}
        onPickEdition={(id) => patch({ scryfallId: id })}
        setCopy={setCopy}
        ownedCopies={ownedCopies}
        ownedQty={ownedQty}
        entry={entry}
        fileHere={actions.fileHere}
        fileCopies={actions.fileCopies}
      />
      {filingSheet}
    </Sheet>
  );
}
