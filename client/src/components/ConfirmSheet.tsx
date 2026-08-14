import { useCallback, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet.js';

// One confirmation for the whole app. `window.confirm` was doing this job in a
// dozen places: it can't be styled, it can't be tap-guarded, and on a phone it
// reads as the browser interrupting rather than the app asking. Every bulk
// action that can't be undone with one tap now comes through here instead, so
// "are you sure" always looks and behaves the same.
//
// Reversible actions (marking for trade, filing, un-filing) deliberately don't
// use it — they say what happened in a toast and the opposite verb is right
// there in the same bar.

export interface ConfirmRequest {
  title: string;
  /** The consequence, in a sentence. */
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Paint the confirm button as destructive. */
  danger?: boolean;
}

export function useConfirm(): { confirm: (req: ConfirmRequest) => Promise<boolean>; sheet: ReactNode } {
  const [pending, setPending] = useState<{ req: ConfirmRequest; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (req: ConfirmRequest) => new Promise<boolean>((resolve) => setPending({ req, resolve })),
    [],
  );

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const sheet = pending ? (
    <Sheet onClose={() => settle(false)} title={pending.req.title} label={pending.req.title}>
      {pending.req.body && <p className="search-meta">{pending.req.body}</p>}
      <div className="sheet-actions">
        <button onClick={() => settle(false)}>{pending.req.cancelLabel ?? 'Cancel'}</button>
        <button className={pending.req.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
          {pending.req.confirmLabel}
        </button>
      </div>
    </Sheet>
  ) : null;

  return { confirm, sheet };
}
