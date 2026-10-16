/**
 * A dropdown that narrows a list. It lights up (`filter-on`) whenever it is off
 * its `neutral` value, so a short list never looks like missing cards. Leave
 * `neutral` out for a select that picks rather than hides (a time window).
 */
export function FilterSelect<V extends string>({
  value,
  onChange,
  options,
  neutral,
  label,
  title,
}: {
  value: V;
  onChange: (v: V) => void;
  options: readonly (readonly [V, string])[];
  neutral?: V;
  /** The aria-label: what the select filters by. */
  label: string;
  title?: string;
}) {
  return (
    <select
      className={neutral === undefined || value === neutral ? '' : 'filter-on'}
      value={value}
      onChange={(e) => onChange(e.target.value as V)}
      aria-label={label}
      title={title}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}
