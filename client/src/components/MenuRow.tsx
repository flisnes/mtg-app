import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from './icons.js';

/**
 * One row of a `.menu-list`: icon, label with an optional line under it, and a
 * chevron. A link with `to`, a button with `onClick`, a plain row with neither.
 */
export interface MenuRowProps {
  /** An icon name, or any node (an emblem). */
  icon?: IconName | ReactNode;
  label: ReactNode;
  /** One line of small print under the label. */
  note?: ReactNode;
  /** Anything richer under the label (format, colors, badges). Wins over `note`. */
  meta?: ReactNode;
  /** Pinned to the right edge, before the chevron. */
  end?: ReactNode;
  /** Regular-weight label, as on the More page. */
  plain?: boolean;
  chevron?: boolean;
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Replaces the default `menu-item` (+ `menu-item-btn` on a button). */
  className?: string;
}

export function MenuRow({
  icon,
  label,
  note,
  meta,
  end,
  plain,
  chevron = true,
  to,
  onClick,
  disabled,
  className,
}: MenuRowProps) {
  const under = meta ?? (note != null && note !== '' ? <span className="search-meta">{note}</span> : null);
  const body = (
    <>
      {icon != null && (
        <span className="menu-icon" aria-hidden>
          {typeof icon === 'string' ? <Icon name={icon as IconName} /> : icon}
        </span>
      )}
      <span className="deck-line">
        <span className={plain ? undefined : 'deck-name'}>{label}</span>
        {under && <span className="deck-meta">{under}</span>}
      </span>
      {end}
      {chevron && (
        <span className="menu-chevron" aria-hidden>
          <Icon name="chevronRight" size={18} />
        </span>
      )}
    </>
  );
  if (to) {
    return (
      <Link className={className ?? 'menu-item'} to={to}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button className={className ?? 'menu-item menu-item-btn'} disabled={disabled} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <span className={className ?? 'menu-item'}>{body}</span>;
}
