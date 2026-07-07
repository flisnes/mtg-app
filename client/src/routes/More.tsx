import { Link } from 'react-router-dom';
import { Page } from './Page.js';

const LINKS = [
  { to: '/wishlist', label: 'Wishlist', icon: '⭐' },
  { to: '/tradelist', label: 'Tradelist', icon: '🔁' },
  { to: '/prices', label: 'Price tracker', icon: '📈' },
  { to: '/history', label: 'Trade history', icon: '📜' },
  { to: '/about', label: 'About & settings', icon: 'ℹ️' },
];

export function More() {
  return (
    <Page title="More">
      <ul className="menu-list">
        {LINKS.map((l) => (
          <li key={l.to}>
            <Link className="menu-item" to={l.to}>
              <span className="menu-icon" aria-hidden>
                {l.icon}
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
