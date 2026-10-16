import { Icon } from '../icons.js';

/**
 * One of the three per-card details, as a button that cycles rather than a
 * dropdown: scanning is a one-handed job and a native select costs a tap, an
 * overlay and a second tap. Tap steps forward, shift/alt-click steps back (a
 * long language list shouldn't need eleven taps to get home).
 */
export function CyclePick<T extends string>({
  label,
  value,
  options,
  onPick,
  render,
  locked,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onPick: (v: T) => void;
  render?: (v: T) => string;
  locked?: boolean;
}) {
  const step = (back: boolean) => {
    if (options.length < 2) return;
    const at = options.indexOf(value);
    // An unknown current value starts the walk at the front of the list.
    const next = options[at < 0 ? 0 : (at + (back ? -1 : 1) + options.length) % options.length];
    if (next !== undefined) onPick(next);
  };
  const shown = render ? render(value) : value;
  return (
    <button
      type="button"
      className={locked ? 'scan-pick scan-pick-locked' : 'scan-pick'}
      aria-label={`${label}: ${shown}. Tap to change`}
      onClick={(e) => step(e.shiftKey || e.altKey)}
    >
      <span className="scan-pick-label">
        {locked ? <Icon name="lock" size={10} /> : null} {label}
      </span>
      <span className="scan-pick-value">{shown}</span>
    </button>
  );
}
