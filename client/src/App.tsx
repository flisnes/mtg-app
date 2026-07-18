import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { initPwa } from './pwa.js';
import { isUpdateAvailable } from './appUpdate.js';
import { useCardDbUpdate } from './cardDb/useCardDbUpdate.js';
import { getSetting, setSetting } from './db/settings.js';
import { Onboarding } from './components/Onboarding.js';
import { ToastProvider, useToast } from './components/Toast.js';
import { GlobalSearchBar, GlobalSearchProvider } from './components/GlobalSearch.js';
import { Collection } from './routes/Collection.js';
import { Wishlist } from './routes/Wishlist.js';
import { Tradelist } from './routes/Tradelist.js';
import { Decks } from './routes/Decks.js';
import { DeckDetail } from './routes/DeckDetail.js';
import { Trade } from './routes/Trade.js';
import { History } from './routes/History.js';
import { PriceMovers } from './routes/PriceMovers.js';
import { About } from './routes/About.js';
import { Account } from './routes/Account.js';
import { Community } from './routes/Community.js';
import { More } from './routes/More.js';
import { EditHistory } from './routes/EditHistory.js';
import { Import } from './routes/Import.js';
import { Export } from './routes/Export.js';
import { ScanTest } from './routes/ScanTest.js';
import { maybeFetchMatches } from './account/notifications.js';
import { initSyncEngine } from './sync/engine.js';
import { recordCollectionPrices } from './price/tracking.js';
import { Icon, type IconName } from './components/icons.js';

const PRIMARY_NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Collection', icon: 'collection', end: true },
  { to: '/decks', label: 'Decks', icon: 'decks' },
  { to: '/trade', label: 'Trade', icon: 'trade' },
  { to: '/more', label: 'More', icon: 'more' },
];

export function App() {
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    void getSetting<boolean>('onboardingComplete').then((v) => setOnboarded(!!v));
    // Record today's price for every card in the collection (deduped per day).
    void recordCollectionPrices();
    // Signed-in: start the sync engine (live push + outbox drain), then
    // refresh trade-match notifications (throttled).
    initSyncEngine();
    void maybeFetchMatches();
  }, []);

  if (onboarded === null) return null; // brief: waiting on the onboarding flag
  if (!onboarded) {
    return (
      <Onboarding
        onDone={() => {
          void setSetting('onboardingComplete', true);
          setOnboarded(true);
        }}
      />
    );
  }

  // AppShell lives inside the providers so it can use toasts for the card-data
  // update feedback (ToastProvider must be an ancestor of useToast).
  return (
    <ToastProvider>
      <GlobalSearchProvider>
        <AppShell />
      </GlobalSearchProvider>
    </ToastProvider>
  );
}

function AppShell() {
  const [updateReload, setUpdateReload] = useState<(() => void) | null>(null);
  const [beaconUpdate, setBeaconUpdate] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const toast = useToast();
  const {
    prompt: cardDataPrompt,
    downloading: updatingCardData,
    progress: cardDataProgress,
    epoch,
    applyUpdate: applyCardData,
    dismiss: dismissCardData,
  } = useCardDbUpdate();

  useEffect(() => {
    initPwa({
      onNeedRefresh: (reload) => setUpdateReload(() => reload),
      onOfflineReady: () => setOfflineReady(true),
    });
  }, []);

  // Version beacon: check on launch and whenever the app returns to the
  // foreground (PWAs resume from background for days). Nudge the SW too.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void isUpdateAvailable().then((available) => {
        if (available) {
          setBeaconUpdate(true);
          void navigator.serviceWorker?.getRegistration().then((r) => r?.update());
        }
      });
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  // A completed background card-data update bumps epoch — toast + re-query.
  useEffect(() => {
    if (epoch > 0) toast('Card data updated');
  }, [epoch, toast]);

  const showUpdate = !!updateReload || beaconUpdate;
  const applyUpdate = () => (updateReload ? updateReload() : window.location.reload());
  const mb = (n: number) => Math.max(1, Math.round(n / 1e6));

  return (
    <div className="app-shell">
      <GlobalSearchBar />
      {showUpdate && (
        <div className="banner banner-update" role="status">
          <span>A new version is available.</span>
          <button onClick={applyUpdate}>Update now</button>
        </div>
      )}
      {cardDataPrompt && !showUpdate && (
        <div className="banner banner-update" role="status">
          {updatingCardData ? (
            <div className="banner-progress">
              <span>{cardDataProgress?.label ?? 'Updating card data…'}</span>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${Math.round((cardDataProgress?.fraction ?? 0) * 100)}%` }} />
              </div>
            </div>
          ) : (
            <>
              <span>Card data update available (~{mb(cardDataPrompt.sizeBytes)} MB).</span>
              <span className="banner-actions">
                <button onClick={applyCardData}>Update</button>
                <button onClick={dismissCardData}>Not now</button>
              </span>
            </>
          )}
        </div>
      )}
      {offlineReady && !showUpdate && !cardDataPrompt && (
        <div className="banner banner-offline" role="status" onAnimationEnd={() => setOfflineReady(false)}>
          Ready to work offline.
        </div>
      )}

      <main className="app-main" key={epoch}>
        <Routes>
          <Route path="/" element={<Collection />} />
          <Route path="/collection" element={<Collection />} />
          <Route path="/wishlist" element={<Wishlist />} />
          <Route path="/tradelist" element={<Tradelist />} />
          <Route path="/import" element={<Import />} />
          <Route path="/export" element={<Export />} />
          <Route path="/decks" element={<Decks />} />
          <Route path="/decks/:id" element={<DeckDetail />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/history" element={<History />} />
          <Route path="/movers" element={<PriceMovers />} />
          <Route path="/about" element={<About />} />
          <Route path="/account" element={<Account />} />
          <Route path="/community" element={<Community />} />
          <Route path="/community/:username" element={<Community />} />
          <Route path="/more" element={<More />} />
          <Route path="/edit-history" element={<EditHistory />} />
          {/* Dev harness for card scanning (S2) — deliberately not in the nav. */}
          <Route path="/scan-test" element={<ScanTest />} />
          <Route path="*" element={<Collection />} />
        </Routes>
      </main>

      <nav className="tab-bar" aria-label="Primary">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}
          >
            <span className="tab-icon" aria-hidden>
              <Icon name={item.icon} size={22} />
            </span>
            <span className="tab-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
