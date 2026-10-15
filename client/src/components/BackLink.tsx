import { Link } from 'react-router-dom';
import { Icon } from './icons.js';

/** "‹ Decks", "‹ More": the one way back up from a sub-page. A link when the
 *  parent is just a route, a button when leaving has to do something first
 *  (the deck page offers to wishlist what's missing). */
export function BackLink({ label, to, onClick }: { label: string; to?: string; onClick?: () => void }) {
  const text = (
    <>
      <Icon name="chevronLeft" size={16} className="chev" />
      {label}
    </>
  );
  if (to) {
    return (
      <Link className="linklike back-link" to={to}>
        {text}
      </Link>
    );
  }
  return (
    <button className="linklike back-link" onClick={onClick}>
      {text}
    </button>
  );
}
