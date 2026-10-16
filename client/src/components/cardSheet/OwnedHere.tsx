import { Icon } from '../icons.js';

/**
 * The "In your collection (×N)" badge under the card name. When `onOpen` is
 * given it's a button that jumps to that copy's sheet on the Collection screen
 * (chevron included, so it reads as a way out of here) — handy when the deck slot
 * you're looking at says the wrong thing and the fix belongs on the entry.
 */
export function OwnedHere({
  qty,
  forTrade,
  ownsExact,
  onOpen,
}: {
  qty: number;
  forTrade: number;
  ownsExact: boolean;
  onOpen?: () => void;
}) {
  const cls = `badge sheet-owned ${forTrade > 0 ? 'own-trade' : 'own-yes'}`;
  const detail = ownsExact ? ' · including this exact printing' : ' · other printing(s)';
  const owned = forTrade > 0 ? `You own ${qty} (${forTrade} for trade)` : `You own ${qty}`;
  const body = (
    <>
      <Icon name={forTrade > 0 ? 'tradelist' : ownsExact ? 'checkDouble' : 'check'} size={13} />
      In your collection (×{qty}
      {forTrade > 0 ? `, ${forTrade} for trade` : ''})
      {onOpen && <Icon name="chevronRight" size={13} />}
    </>
  );
  if (!onOpen) return <div className={cls} title={owned + detail}>{body}</div>;
  return (
    <button type="button" className={`${cls} sheet-owned-link`} title={`${owned}${detail} · open it in your collection`} onClick={onOpen}>
      {body}
    </button>
  );
}
