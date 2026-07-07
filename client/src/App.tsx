import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { initPwa } from './pwa.js';
import { Search } from './routes/Search.js';
import { Collection } from './routes/Collection.js';
import { Wishlist } from './routes/Wishlist.js';
import { Tradelist } from './routes/Tradelist.js';
import { Decks } from './routes/Decks.js';
import { Trade } from './routes/Trade.js';
import { History } from './routes/History.js';
import { About } from './routes/About.js';
import { More } from './routes/More.js';

const PRIMARY_NAV = [
  { to: '/', label: 'Search', icon: '🔍', end: true },
  { to: '/collection', label: 'Collection', icon: '🗃️' },
  { to: '/decks', label: 'Decks', icon: '🃏' },
  { to: '/trade', label: 'Trade', icon: '🤝' },
  { to: '/more', label: 'More', icon: '⋯' },
];

export function App() {
  const [updateReload, setUpdateReload] = useState<(() => void) | null>(null);
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    initPwa({
      onNeedRefresh: (reload) => setUpdateReload(() => reload),
      onOfflineReady: () => setOfflineReady(true),
    });
  }, []);

  return (
    <div className="app-shell">
      {updateReload && (
        <div className="banner banner-update" role="status">
          <span>A new version is available.</span>
          <button onClick={() => updateReload()}>Update now</button>
        </div>
      )}
      {offlineReady && !updateReload && (
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
          <Route path="/decks" element={<Decks />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/history" element={<History />} />
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
  );
}
