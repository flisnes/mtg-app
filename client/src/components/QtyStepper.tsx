import type { KeyboardEvent } from 'react';
import { Icon } from './icons.js';

/**
 * The one − n + control. The full variant has a typeable number (the card
 * sheet's quantity and for-trade fields); `compact` shows the number as text
 * for rows that only ever step by one (scan list, stacks, sealed copies).
 * `label` names what is being counted, for the buttons' aria-labels.
 */
export function QtyStepper({
  value,
  min,
  max,
  disabled,
  onChange,
  onEnter,
  compact,
  label,
}: {
  value: number;
  min: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onEnter?: (e: KeyboardEvent<HTMLInputElement>) => void;
  compact?: boolean;
  label?: string;
}) {
  const clamp = (v: number) => Math.max(min, max !== undefined ? Math.min(max, v) : v);
  const of = label ? ` ${label}` : '';
  return (
    <div className={compact ? 'qty-stepper qty-stepper-compact' : 'qty-stepper'}>
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label={`One less${of}`}>
        <Icon name="minus" size={16} />
      </button>
      {compact ? (
        <span className="qty-stepper-n">{value}</span>
      ) : (
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
      )}
      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        disabled={disabled || (max !== undefined && value >= max)}
        aria-label={`One more${of}`}
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
