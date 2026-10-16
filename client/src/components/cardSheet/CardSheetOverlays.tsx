import type { CollectionEntry, ContainerKind, Finish, OracleCard, Priced, PriceHistory, Printing, UserEvent } from '@mtg/shared';
import type { FilingCopy } from '../../deck/filing.js';
import { SealedWithCardSheet } from '../../sealed/SealedWithCardSheet.js';
import { CardHistorySheet, PriceChartSheet } from '../ChartSheetsLazy.js';
import { CardLegalitySheet } from '../CardLegalitySheet.js';
import type { pickPrice } from '../CardSorting.js';
import { CardSheet } from '../CardSheet.js';
import { ContainerPickerSheet } from '../ContainerPickerSheet.js';
import { CopyPicker } from '../CopyPicker.js';
import { EventSheet } from '../EventSheet.js';
import { FileCopiesSheet } from '../FileCopiesSheet.js';
import { EditionGrid } from './EditionGrid.js';
import type { CardForm } from './useCardForm.js';
import type { CopyTraits, Overlay } from './types.js';

/** Whatever sits over the card sheet: one at a time, picked by `overlay`
 *  (zoom is drawn by CardArt, which owns the flip it shares). */
export function CardSheetOverlays({
  overlay,
  setOverlay,
  oracleCard,
  printing,
  printings,
  shownId,
  priceHistory,
  shownFinish,
  nowQuote,
  editions,
  form,
  onPickEdition,
  setCopy,
  ownedCopies,
  ownedQty,
  entry,
  fileHere,
  fileCopies,
}: {
  overlay: Overlay | null;
  setOverlay: (overlay: Overlay | null) => void;
  oracleCard: Priced<OracleCard>;
  printing: Printing | undefined;
  printings: Priced<Printing>[];
  /** The printing whose price and history show. */
  shownId: string;
  priceHistory: PriceHistory | null;
  shownFinish: Finish;
  nowQuote: ReturnType<typeof pickPrice>;
  editions: {
    printings: Priced<Printing>[];
    anyOption: boolean;
    notes?: Map<string, string>;
    ownedIds: Set<string>;
    ownedForTradeIds: Set<string>;
  };
  form: CardForm;
  onPickEdition: (scryfallId: string) => void;
  setCopy: (copy: CopyTraits) => void;
  ownedCopies: CollectionEntry[];
  ownedQty: number;
  entry?: CollectionEntry;
  fileHere: (containerId: string, kind: ContainerKind) => Promise<void>;
  fileCopies: (containerId: string, kind: ContainerKind, copies: FilingCopy[]) => Promise<void>;
}) {
  const close = () => setOverlay(null);
  const openEvent = (e: UserEvent, overHistory: boolean) =>
    setOverlay({ kind: 'event', entry: { kind: 'single', id: e.id, ts: e.ts, event: e }, overHistory });
  // The history is the one layer the others stack on: an event opened from it,
  // and a card opened from that event, keep it mounted underneath.
  const historyUnder =
    overlay?.kind === 'history' || ((overlay?.kind === 'event' || overlay?.kind === 'nested') && overlay.overHistory);
  const back = historyUnder ? () => setOverlay({ kind: 'history' }) : close;

  return (
    <>
      {overlay?.kind === 'chart' && priceHistory && (
        <PriceChartSheet
          name={oracleCard.name}
          subtitle={printing ? `${printing.setName} · #${printing.collectorNumber}` : undefined}
          oracleId={oracleCard.oracleId}
          scryfallId={shownId}
          history={priceHistory}
          finish={shownFinish}
          now={nowQuote}
          onEventClick={(e) => openEvent(e, false)}
          onClose={close}
        />
      )}
      {overlay?.kind === 'legality' && <CardLegalitySheet oracleCard={oracleCard} onClose={close} />}
      {overlay?.kind === 'sealed' && <SealedWithCardSheet cardName={oracleCard.name} printings={printings} onClose={close} />}
      {overlay?.kind === 'editions' && (
        <EditionGrid
          printings={editions.printings}
          selected={form.scryfallId}
          anyOption={editions.anyOption}
          notes={editions.notes}
          ownedIds={editions.ownedIds}
          ownedForTradeIds={editions.ownedForTradeIds}
          onSelect={(id) => {
            onPickEdition(id);
            close();
          }}
          onClose={close}
        />
      )}
      {overlay?.kind === 'pickCopy' && (
        <CopyPicker
          copies={ownedCopies}
          printings={printings}
          selected={form}
          onSelect={(copy) => {
            setCopy(copy);
            close();
          }}
          onAddCopy={() => setOverlay({ kind: 'addCopy' })}
          onClose={close}
        />
      )}
      {/* Add the missing copy without losing the slot behind it: the nested
          sheet writes the collection entry, hands it back, and this form ends up
          exactly where picking an existing copy would have left it. It's the
          card on screen, so it takes what this sheet already read. */}
      {overlay?.kind === 'addCopy' && (
        <CardSheet
          mode="add"
          oracleCard={oracleCard}
          initialScryfallId={form.scryfallId || oracleCard.defaultScryfallId}
          addTarget={{ kind: 'collection' }}
          loaded={{ printings, priceHistory: { scryfallId: shownId, history: priceHistory } }}
          onAdded={setCopy}
          onClose={close}
        />
      )}
      {overlay?.kind === 'pickContainer' && (
        <ContainerPickerSheet
          title={ownedQty > 1 ? 'File your copies' : 'File this copy'}
          label={`Where does your ${oracleCard.name} live?`}
          onPick={(id, kind) => void fileHere(id, kind)}
          onClose={close}
        />
      )}
      {overlay?.kind === 'fileCopies' && (
        <FileCopiesSheet
          oracleId={oracleCard.oracleId}
          cardName={oracleCard.name}
          containerId={overlay.id}
          containerName={overlay.name}
          kind={overlay.containerKind}
          copies={ownedCopies}
          printings={printings}
          startWith={entry?.id}
          onCancel={close}
          onFile={(copies) => void fileCopies(overlay.id, overlay.containerKind, copies)}
        />
      )}
      {historyUnder && (
        <CardHistorySheet
          oracleCard={oracleCard}
          scryfallId={shownId}
          printings={printings}
          priceHistory={priceHistory}
          onEventClick={(e: UserEvent) => openEvent(e, true)}
          onClose={close}
        />
      )}
      {overlay?.kind === 'event' && (
        <EventSheet
          entry={overlay.entry}
          onOpenCard={(oracle, scryfallId) => {
            // Same card: show its history (already open if that's where this
            // event came from, but the price chart reaches here too). Different
            // card (a batch line): a nested sheet on that card's history.
            if (oracle.oracleId === oracleCard.oracleId) setOverlay({ kind: 'history' });
            else setOverlay({ kind: 'nested', oracle, scryfallId, overHistory: overlay.overHistory });
          }}
          onClose={back}
        />
      )}
      {overlay?.kind === 'nested' && (
        <CardSheet
          mode="info"
          oracleCard={overlay.oracle}
          initialScryfallId={overlay.scryfallId}
          openHistory
          onClose={back}
        />
      )}
    </>
  );
}
