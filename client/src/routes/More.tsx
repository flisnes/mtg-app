import { useState } from 'react';
import { Page } from './Page.js';
import { useFilingConflictCount } from '../db/usePlacements.js';
import type { IconName } from '../components/icons.js';
import { ShortcutsSheet } from '../components/ShortcutsSheet.js';
import { plural } from '../util/format.js';
import { MenuRow } from '../components/MenuRow.js';

const LINKS: { to: string; label: string; icon: IconName }[] = [
  { to: '/wishlist', label: 'Wishlist', icon: 'wishlist' },
  { to: '/tradelist', label: 'Tradelist', icon: 'tradelist' },
  { to: '/sealed', label: 'Sealed products', icon: 'sealed' },
  { to: '/movers', label: 'Price movers', icon: 'prices' },
  { to: '/spoilers', label: 'Spoilers & reprints', icon: 'spoilers' },
  { to: '/community', label: 'Community', icon: 'community' },
  { to: '/edit-history', label: 'Collection history', icon: 'history' },
  { to: '/history', label: 'Trade history', icon: 'receipt' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/about', label: 'About', icon: 'about' },
];

export function More() {
  // The keys are otherwise invisible: `?` opens this too, but only if you
  // already knew to press it.
  const [shortcuts, setShortcuts] = useState(false);
  // Filing conflicts only earn a row when there are some — an always-present
  // "0 conflicts" link is a chore that never goes away.
  const conflicts = useFilingConflictCount();
  const links: { to: string; label: string; icon: IconName; note?: string }[] = conflicts
    ? [
        {
          to: '/conflicts',
          label: 'Filing conflicts',
          icon: 'balance',
          note: `${conflicts} ${plural(conflicts, 'card')} filed in more places than you own`,
        },
        ...LINKS,
      ]
    : LINKS;

  return (
    <Page title="More">
      <ul className="menu-list">
        {links.map((l) => (
          <li key={l.to}>
            <MenuRow to={l.to} icon={l.icon} label={l.label} note={l.note} plain />
          </li>
        ))}
        {/* Only where there's a keyboard to press them on. */}
        <li className="menu-shortcuts">
          <MenuRow className="menu-item" onClick={() => setShortcuts(true)} icon="keyboard" label="Keyboard shortcuts" plain />
        </li>
      </ul>
      {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
    </Page>
  );
}
