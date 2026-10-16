import type { ReactNode } from 'react';

/**
 * One row of a `.scan-list`: thumbnail, name, a line of small print, then
 * whatever trails it (a stepper, a change tag). The main part is a button with
 * `onClick`, a label with `check` (a checkbox in front), or static.
 */
export function ScanListRow({
  image,
  name,
  sub,
  price,
  check,
  onClick,
  ariaLabel,
  children,
}: {
  /** Small image URL; a blank card shape without one. */
  image?: string | null;
  name: ReactNode;
  sub?: ReactNode;
  price?: ReactNode;
  check?: { checked: boolean; onChange: (checked: boolean) => void };
  onClick?: () => void;
  ariaLabel?: string;
  /** After the main part, at the right edge. */
  children?: ReactNode;
}) {
  const body = (
    <>
      {check && <input type="checkbox" checked={check.checked} onChange={(e) => check.onChange(e.target.checked)} />}
      {image ? (
        <img className="scan-list-thumb" src={image} alt="" loading="lazy" />
      ) : (
        <span className="scan-list-thumb" />
      )}
      <span className="scan-list-info">
        <strong>{name}</strong>
        {sub != null && sub !== false && sub !== '' && <span className="scan-printing">{sub}</span>}
        {price && <span className="scan-list-price">{price}</span>}
      </span>
    </>
  );
  return (
    <li className="scan-list-row">
      {onClick ? (
        <button className="scan-list-main" onClick={onClick} aria-label={ariaLabel}>
          {body}
        </button>
      ) : check ? (
        <label className="scan-list-main" style={{ cursor: 'pointer' }}>
          {body}
        </label>
      ) : (
        <span className="scan-list-main scan-list-static">{body}</span>
      )}
      {children}
    </li>
  );
}
