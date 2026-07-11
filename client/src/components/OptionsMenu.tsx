import { useEffect, useRef, useState } from 'react';

// The per-page "⋯" options menu: rarely-used actions (import/export/delete)
// live here so toolbars stay clear for the primary flow (search → add).

export interface MenuAction {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}

export function OptionsMenu({ actions, label = 'Options' }: { actions: MenuAction[]; label?: string }) {
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
        <div className="options-pop" role="menu" aria-label={label}>
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
                  {a.icon}
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
