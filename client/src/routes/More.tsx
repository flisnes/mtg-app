import { Link } from 'react-router-dom';
import { Page } from './Page.js';
import { useFilingConflictCount } from '../db/usePlacements.js';
import { Icon, type IconName } from '../components/icons.js';

const LINKS: { to: string; label: string; icon: IconName }[] = [
  { to: '/wishlist', label: 'Wishlist', icon: 'wishlist' },
  { to: '/tradelist', label: 'Tradelist', icon: 'tradelist' },
  { to: '/movers', label: 'Price movers', icon: 'prices' },
  { to: '/spoilers', label: 'Spoilers & reprints', icon: 'spoilers' },
  { to: '/community', label: 'Community', icon: 'community' },
  { to: '/edit-history', label: 'Edit history', icon: 'edit' },
  { to: '/history', label: 'Trade history', icon: 'history' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/about', label: 'About', icon: 'about' },
];

export function More() {
  // Filing conflicts only earn a row when there are some — an always-present
  // "0 conflicts" link is a chore that never goes away.
  const conflicts = useFilingConflictCount();
  const links: { to: string; label: string; icon: IconName; note?: string }[] = conflicts
    ? [
        {
          to: '/conflicts',
          label: 'Filing conflicts',
          icon: 'balance',
          note: `${conflicts} card${conflicts === 1 ? '' : 's'} filed in more places than you own`,
        },
        ...LINKS,
      ]
    : LINKS;

  return (
    <Page title="More">
      <ul className="menu-list">
        {links.map((l) => (
          <li key={l.to}>
            <Link className="menu-item" to={l.to}>
              <span className="menu-icon" aria-hidden>
                <Icon name={l.icon} />
              </span>
              <span className="deck-line">
                <span>{l.label}</span>
                {l.note && (
                  <span className="deck-meta">
                    <span className="search-meta">{l.note}</span>
                  </span>
                )}
              </span>
              <span className="menu-chevron" aria-hidden>
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
