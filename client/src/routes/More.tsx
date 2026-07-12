import { Link } from 'react-router-dom';
import { Page } from './Page.js';
import { Icon, type IconName } from '../components/icons.js';

const LINKS: { to: string; label: string; icon: IconName }[] = [
  { to: '/wishlist', label: 'Wishlist', icon: 'wishlist' },
  { to: '/tradelist', label: 'Tradelist', icon: 'tradelist' },
  { to: '/movers', label: 'Price movers', icon: 'prices' },
  { to: '/history', label: 'Trade history', icon: 'history' },
  { to: '/about', label: 'About & settings', icon: 'about' },
];

export function More() {
  return (
    <Page title="More">
      <ul className="menu-list">
        {LINKS.map((l) => (
          <li key={l.to}>
            <Link className="menu-item" to={l.to}>
              <span className="menu-icon" aria-hidden>
                <Icon name={l.icon} />
              </span>
              <span>{l.label}</span>
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
