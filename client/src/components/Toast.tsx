import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// Minimal transient toast for add/import feedback. One with an action (Undo)
// stays up longer, long enough to read the name and reach the button.

interface ToastAction {
  label: string;
  run: () => void;
}
type ToastFn = (message: string, action?: ToastAction) => void;
const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setItems((cur) => cur.filter((t) => t.id !== id)), []);
  const toast = useCallback<ToastFn>(
    (message, action) => {
      const id = nextId.current++;
      setItems((cur) => [...cur, { id, message, action }]);
      setTimeout(() => dismiss(id), action ? 4000 : 2200);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={t.action ? 'toast toast-with-action' : 'toast'}>
            {t.message}
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
