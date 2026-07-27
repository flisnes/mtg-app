import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.js';

// The per-page "⋯" options menu: rarely-used actions (import/export/delete)
// live here so toolbars stay clear for the primary flow (search → add).

export interface MenuAction {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onClick: () => void;
}

export function OptionsMenu({
  actions,
  label = 'Options',
  openUp = false,
}: {
  actions: MenuAction[];
  label?: string;
  /** Open the popup above the trigger — for triggers near the bottom of a
   *  scrolling container (e.g. the card sheet), where a downward popup clips. */
  openUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="options-menu" ref={ref}>
      <button
        className="options-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className={openUp ? 'options-pop options-pop-up' : 'options-pop'} role="menu" aria-label={label}>
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className={a.danger ? 'options-item options-item-danger' : 'options-item'}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
            >
              {a.icon && (
                <span className="options-icon" aria-hidden>
                  <Icon name={a.icon} size={18} />
                </span>
              )}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
