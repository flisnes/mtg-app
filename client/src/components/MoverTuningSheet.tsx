import { Sheet } from './Sheet.js';
import {
  TUNING_GROUPS,
  isTuned,
  resetMoverTuning,
  setMoverTuning,
  useMoverTuning,
  type TuningField,
} from '../price/moverTuning.js';
import { currencySymbol } from '../price/rates.js';
import { getPrefs } from '../prefs.js';
import type { MoverTuning } from '../price/movers.js';

// The dials behind the Price movers page. Everything applies live: the page
// re-runs its query on every change, so a slider drag shows its own effect.

export function MoverTuningSheet({ onClose }: { onClose: () => void }) {
  const tuning = useMoverTuning();
  const symbol = currencySymbol(getPrefs().baseCurrency);

  return (
    <Sheet onClose={onClose} title="Tune the formula" className="tuning-sheet">
      <p className="fine-print">
        What counts as news, in your terms. Cash thresholds are read in the currency the card&rsquo;s price was
        recorded in ({symbol} for most). Kept on this device.
      </p>

      {TUNING_GROUPS.map((g) => (
        <section key={g.title} className="tuning-group">
          <h4>{g.title}</h4>
          <p className="fine-print">{g.blurb}</p>
          {g.fields.map((f) => (
            <Dial key={f.key} field={f} value={tuning[f.key]} symbol={symbol} />
          ))}
        </section>
      ))}

      <div className="sheet-actions">
        <button onClick={resetMoverTuning} disabled={!isTuned(tuning)}>
          Reset to defaults
        </button>
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

function Dial({ field, value, symbol }: { field: TuningField; value: number; symbol: string }) {
  const id = `tune-${field.key}`;
  return (
    <div className="tuning-dial">
      <label className="tuning-head" htmlFor={id}>
        <span>{field.label}</span>
        <span className="tuning-value">{formatValue(field, value, symbol)}</span>
      </label>
      <input
        id={id}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={(e) => setMoverTuning({ [field.key]: Number(e.target.value) } as Partial<MoverTuning>)}
      />
      <p className="fine-print">{field.hint}</p>
    </div>
  );
}

function formatValue(field: TuningField, v: number, symbol: string): string {
  switch (field.unit) {
    case 'money':
      return `${symbol}${v.toFixed(2)}`;
    case 'percent':
      return `${v}%`;
    case 'fraction':
      return `${Math.round(v * 100)}%`;
    case 'days':
      return `${v} day${v === 1 ? '' : 's'}`;
    case 'readings':
      return `${v} reading${v === 1 ? '' : 's'}`;
    case 'r':
      return v.toFixed(2);
  }
}
