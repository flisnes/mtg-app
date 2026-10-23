// Which tab a screen belongs to, and where its back link goes. The tab bar used
// to match by URL prefix alone, so every screen reached from More (and Binders,
// Boxes, Import...) lit up no tab at all.

export type Tab = '/' | '/decks' | '/trade' | '/more';

/** First matching prefix wins; anything unlisted renders Collection, so it
 *  belongs to Collection too. */
const TAB_PREFIXES: [string, Tab][] = [
  ['/decks', '/decks'],
  ['/binders', '/decks'],
  ['/boxes', '/decks'],
  ['/trade', '/trade'],
  ['/more', '/more'],
  ['/wishlist', '/more'],
  ['/tradelist', '/more'],
  ['/sealed', '/more'],
  ['/movers', '/more'],
  ['/spoilers', '/more'],
  ['/community', '/more'],
  ['/profile', '/more'],
  ['/edit-history', '/more'],
  ['/history', '/more'],
  ['/conflicts', '/more'],
  ['/settings', '/more'],
  ['/admin', '/more'],
  ['/about', '/more'],
  ['/licenses', '/more'],
];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

export function tabFor(pathname: string): Tab {
  for (const [prefix, tab] of TAB_PREFIXES) if (under(pathname, prefix)) return tab;
  return '/';
}

export interface BackTarget {
  to: string;
  label: string;
}

const MORE: BackTarget = { to: '/more', label: 'More' };
const COLLECTION: BackTarget = { to: '/', label: 'Collection' };

/** The parent of a top-level sub-page, for Page's default back link. Exact
 *  paths only: deeper screens (a community user, a profile) bring their own. */
const PARENTS: Record<string, BackTarget> = {
  '/wishlist': MORE,
  '/tradelist': MORE,
  '/sealed': MORE,
  '/movers': MORE,
  '/spoilers': MORE,
  '/community': MORE,
  '/edit-history': MORE,
  '/history': MORE,
  '/conflicts': MORE,
  '/settings': MORE,
  '/admin': { to: '/settings', label: 'Settings' },
  '/about': MORE,
  '/licenses': { to: '/about', label: 'About' },
  '/import': COLLECTION,
  '/export': COLLECTION,
};

export function backFor(pathname: string): BackTarget | undefined {
  return PARENTS[pathname];
}
