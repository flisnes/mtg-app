import type { ReactElement, SVGProps } from 'react';

// Single source of truth for the app's section symbols. Every tab, menu row,
// quick-add button, and empty state pulls its glyph from here — swap a path
// below and it changes everywhere. Icons are stroke-based line art that inherit
// `currentColor`, so they follow the active/dim/theme colors automatically
// (unlike the fixed-hue emoji they replaced).

export type IconName =
  | 'collection'
  | 'decks'
  | 'trade'
  | 'tradelist'
  | 'wishlist'
  | 'prices'
  | 'pricesDown'
  | 'history'
  | 'about'
  | 'more'
  | 'balance'
  | 'plus'
  | 'account'
  | 'community'
  | 'bell';

// 24×24 viewBox, drawn to Feather's conventions (2px stroke, round joins).
const PATHS: Record<IconName, ReactElement> = {
  // Archive box — the collection.
  collection: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  // Two stacked cards — the decks.
  decks: (
    <>
      <rect x="3" y="6" width="13" height="15" rx="2" />
      <path d="M7 6V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-2" />
    </>
  ),
  // Bidirectional swap — the act of trading.
  trade: (
    <>
      <path d="M16 3l4 4-4 4" />
      <path d="M20 7H4" />
      <path d="M8 21l-4-4 4-4" />
      <path d="M4 17h16" />
    </>
  ),
  // Tag — cards marked (tagged) for trade.
  tradelist: (
    <>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <circle cx="7" cy="7" r="1.2" />
    </>
  ),
  // Star — the wishlist.
  wishlist: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
  // Rising line — price tracker.
  prices: (
    <>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </>
  ),
  // Falling line — the 'prices' glyph mirrored, for falling movers.
  pricesDown: (
    <>
      <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
      <polyline points="17 18 23 18 23 12" />
    </>
  ),
  // Clock — trade history.
  history: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
  // Info — about & settings.
  about: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  // Balance scale — evening out a trade's value.
  balance: (
    <>
      <path d="M12 3v18" />
      <path d="M7 21h10" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
      <path d="M2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z" />
      <path d="M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z" />
    </>
  ),
  // Plus — add cards.
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  // Horizontal ellipsis — the "More" overflow.
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </>
  ),
  // Single person — account & sync.
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </>
  ),
  // Two people — the community.
  community: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20v-.8A5.5 5.5 0 0 1 8 13.7h2a5.5 5.5 0 0 1 5.5 5.5v.8" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M18.2 13.9a5.5 5.5 0 0 1 3.3 5v.8" />
    </>
  ),
  // Bell — match notifications.
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>
  ),
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Edge length in px. Defaults to 22. */
  size?: number;
}

export function Icon({ name, size = 22, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
