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
