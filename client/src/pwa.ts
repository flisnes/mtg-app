import { registerSW } from 'virtual:pwa-register';

// Service-worker registration with the `prompt` flow (beta plan §3.1). The SW
// updater and the server version beacon cooperate: the beacon tells users an
// update exists (iOS checks for new SWs lazily); this drives the actual
// skipWaiting + reload once the new SW is downloaded.

export type UpdateHandlers = {
  onNeedRefresh: (reload: () => void) => void;
  onOfflineReady: () => void;
};

export function initPwa({ onNeedRefresh, onOfflineReady }: UpdateHandlers): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      onNeedRefresh(() => void updateSW(true));
    },
    onOfflineReady() {
      onOfflineReady();
    },
  });
}

// Waits for a new SW to reach the `waiting` (installed) state, whether it is
// already installing or the update hasn't even been discovered yet. Resolves
// null if nothing arrives in time or the install fails.
function waitForWaiting(reg: ServiceWorkerRegistration, timeoutMs = 8000): Promise<ServiceWorker | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(reg.waiting), timeoutMs);
    const settle = (sw: ServiceWorker | null) => {
      clearTimeout(timer);
      resolve(sw);
    };
    const track = (sw: ServiceWorker | null): boolean => {
      if (!sw) return false;
      if (sw.state === 'installed') {
        settle(sw);
      } else {
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed') settle(sw);
          else if (sw.state === 'redundant') settle(null);
        });
      }
      return true;
    };
    if (reg.waiting) {
      settle(reg.waiting);
      return;
    }
    if (!track(reg.installing)) {
      reg.addEventListener('updatefound', () => track(reg.installing), { once: true });
    }
  });
}

// Applies an update the beacon knows about before the SW does: a plain reload
// can't activate a `prompt`-mode SW (it stays waiting until told to skip), so
// fetch the new SW, wait for it to install, send SKIP_WAITING, and reload once
// it takes control.
export async function forceUpdate(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) {
    window.location.reload();
    return;
  }
  await reg.update().catch(() => {});
  const waiting = reg.waiting ?? (await waitForWaiting(reg));
  if (waiting) {
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    // Safety net in case controllerchange never fires (e.g. another tab holds
    // the old SW active).
    setTimeout(() => window.location.reload(), 4000);
  } else {
    // Nothing new reachable yet (e.g. the Pages CDN is still serving the old
    // sw.js) — reload is the best we can do.
    window.location.reload();
  }
}
