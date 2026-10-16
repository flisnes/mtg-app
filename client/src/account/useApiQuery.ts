import { useEffect, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react';
import { ApiError } from './api.js';

/**
 * One server read tied to a component: refetches when `deps` change, drops
 * answers that arrive after an unmount or a newer request, and turns failures
 * into a sentence. `notFound` replaces the message for a 404. `setData` is for
 * optimistic edits on top of what was loaded.
 */
export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  messages: { fallback: string; notFound?: string },
): { data: T | null; error: string | null; setData: Dispatch<SetStateAction<T | null>> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetcher()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          messages.notFound && err instanceof ApiError && err.status === 404
            ? messages.notFound
            : err instanceof ApiError
              ? err.friendlyMessage
              : messages.fallback,
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps are the contract
  }, deps);

  return { data, error, setData };
}
