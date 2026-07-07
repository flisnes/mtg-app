import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// Minimal transient toast for add/import feedback.

type ToastFn = (message: string) => void;
const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

interface ToastItem {
  id: number;
  message: string;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback<ToastFn>((message) => {
    const id = nextId.current++;
    setItems((cur) => [...cur, { id, message }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 2200);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
