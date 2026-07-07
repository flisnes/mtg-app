import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { initPwa } from './pwa.js';
import { isUpdateAvailable } from './appUpdate.js';
import { getSetting, setSetting } from './db/settings.js';
import { Onboarding } from './components/Onboarding.js';
import { ToastProvider } from './components/Toast.js';
import { Search } from './routes/Search.js';
import { Collection } from './routes/Collection.js';
import { Wishlist } from './routes/Wishlist.js';
import { Tradelist } from './routes/Tradelist.js';
import { Decks } from './routes/Decks.js';
import { DeckDetail } from './routes/DeckDetail.js';
import { Trade } from './routes/Trade.js';
import { History } from './routes/History.js';
import { About } from './routes/About.js';
import { More } from './routes/More.js';
import { Import } from './routes/Import.js';
import { Export } from './routes/Export.js';
import { Prices } from './routes/Prices.js';
import { recordPriceSnapshots } from './price/tracking.js';

const PRIMARY_NAV = [
  { to: '/', label: 'Search', icon: '🔍', end: true },
  { to: '/collection', label: 'Collection', icon: '🗃️' },
  { to: '/decks', label: 'Decks', icon: '🃏' },
  { to: '/trade', label: 'Trade', icon: '🤝' },
  { to: '/more', label: 'More', icon: '⋯' },
];

export function App() {
  const [updateReload, setUpdateReload] = useState<(() => void) | null>(null);
  const [beaconUpdate, setBeaconUpdate] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    initPwa({
      onNeedRefresh: (reload) => setUpdateReload(() => reload),
      onOfflineReady: () => setOfflineReady(true),
    });
    void getSetting<boolean>('onboardingComplete').then((v) => setOnboarded(!!v));
    // Record today's price for every watched card (deduped per day).
    void recordPriceSnapshots();
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

  const showUpdate = !!updateReload || beaconUpdate;
  const applyUpdate = () => (updateReload ? updateReload() : window.location.reload());

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

  return (
    <ToastProvider>
    <div className="app-shell">
      {showUpdate && (
        <div className="banner banner-update" role="status">
          <span>A new version is available.</span>
          <button onClick={applyUpdate}>Update now</button>
        </div>
      )}
      {offlineReady && !showUpdate && (
        <div className="banner banner-offline" role="status" onAnimationEnd={() => setOfflineReady(false)}>
          Ready to work offline.
        </div>
      )}

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Search />} />
          <Route path="/collection" element={<Collection />} />
          <Route path="/wishlist" element={<Wishlist />} />
          <Route path="/tradelist" element={<Tradelist />} />
          <Route path="/import" element={<Import />} />
          <Route path="/export" element={<Export />} />
          <Route path="/decks" element={<Decks />} />
          <Route path="/decks/:id" element={<DeckDetail />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/history" element={<History />} />
          <Route path="/prices" element={<Prices />} />
          <Route path="/about" element={<About />} />
          <Route path="/more" element={<More />} />
          <Route path="*" element={<Search />} />
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
              {item.icon}
            </span>
            <span className="tab-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
    </ToastProvider>
  );
}
