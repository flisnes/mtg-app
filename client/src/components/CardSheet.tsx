import { useEffect, useMemo, useState } from 'react';
import type { CollectionEntry, Condition, Finish, OracleCard, Printing } from '@mtg/shared';
import { CONDITIONS } from '@mtg/shared';
import { addToCollection, removeFromCollection, updateCollectionEntry } from '../db/dataAccess.js';
import { getPrintingsForOracle } from '../db/queries.js';

// Bottom-sheet for adding a card to the collection or editing an existing
// entry. Covers the tradelist via the "for trade" quantity (beta plan §4/§6).

const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'];

export function CardSheet({
  oracleCard,
  entry,
  onClose,
}: {
  oracleCard: OracleCard;
  entry?: CollectionEntry;
  onClose: () => void;
}) {
  const editing = !!entry;
  const [printings, setPrintings] = useState<Printing[]>([]);
  const [scryfallId, setScryfallId] = useState(entry?.scryfallId ?? oracleCard.defaultScryfallId);
  const [condition, setCondition] = useState<Condition>(entry?.condition ?? 'NM');
  const [finish, setFinish] = useState<Finish>(entry?.finish ?? 'nonfoil');
  const [lang, setLang] = useState(entry?.lang ?? 'en');
  const [quantity, setQuantity] = useState(entry?.quantity ?? 1);
  const [forTrade, setForTrade] = useState(entry?.quantityForTrade ?? 0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPrintingsForOracle(oracleCard.oracleId).then(setPrintings);
  }, [oracleCard.oracleId]);

  const printing = useMemo(
    () => printings.find((p) => p.scryfallId === scryfallId),
    [printings, scryfallId],
  );
  const availableFinishes = printing?.finishes ?? (['nonfoil'] as Finish[]);

  // Keep finish valid for the chosen printing.
  useEffect(() => {
    if (printing && !printing.finishes.includes(finish)) setFinish(printing.finishes[0] ?? 'nonfoil');
  }, [printing, finish]);

  const clampedForTrade = Math.min(forTrade, quantity);

  async function save() {
    setBusy(true);
    if (editing && entry) {
      await updateCollectionEntry(entry.id, {
        scryfallId,
        condition,
        finish,
        lang,
        quantity,
        quantityForTrade: clampedForTrade,
      });
    } else {
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

  async function del() {
    if (!entry) return;
    setBusy(true);
    await removeFromCollection(entry.id);
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${editing ? 'Edit' : 'Add'} ${oracleCard.name}`}>
        <div className="sheet-head">
          {oracleCard.imageSmall && <img className="sheet-thumb" src={oracleCard.imageSmall} alt="" width={46} height={64} />}
          <div>
            <div className="result-name">{oracleCard.name}</div>
            <div className="result-sub">{oracleCard.typeLine}</div>
          </div>
        </div>

        <label className="field">
          <span>Edition</span>
          <select value={scryfallId} onChange={(e) => setScryfallId(e.target.value)}>
            {printings.map((p) => (
              <option key={p.scryfallId} value={p.scryfallId}>
                {p.setName} · #{p.collectorNumber} · {p.releasedAt.slice(0, 4)}
              </option>
            ))}
          </select>
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Condition</span>
            <select value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Finish</span>
            <select value={finish} onChange={(e) => setFinish(e.target.value as Finish)}>
              {availableFinishes.map((f) => (
                <option key={f} value={f}>
                  {FINISH_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-grid">
          <label className="field">
            <span>Quantity</span>
            <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="field">
            <span>For trade</span>
            <input
              type="number"
              min={0}
              max={quantity}
              value={clampedForTrade}
              onChange={(e) => setForTrade(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
        </div>

        <div className="sheet-actions">
          {editing && (
            <button className="danger-outline" onClick={del} disabled={busy}>
              Remove
            </button>
          )}
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {editing ? 'Save' : 'Add to collection'}
          </button>
        </div>
      </div>
    </div>
  );
}
