import { useMemo } from 'react';
import { renderSVG } from 'uqr';

/**
 * The QR code encodes a plain https link into this very app (hash route with
 * the code as a query param), not the bare code. Any camera app — iOS, Android,
 * installed PWA or plain browser tab — turns it into "open the app and join",
 * and it keeps working under any origin the app is ever served from (dev,
 * Pages, a store-wrapped WebView/TWA), because it's derived at runtime.
 */
export function tradeJoinUrl(code: string): string {
  const base = window.location.href.split('#')[0];
  return `${base}#/trade?join=${code}`;
}

/** Session invite: scannable QR + the code spelled out for manual entry. */
export function TradeQr({ code }: { code: string }) {
  // Fixed black-on-white (not theme colors): dark-theme QR codes scan poorly.
  const svg = useMemo(
    () => renderSVG(tradeJoinUrl(code), { ecc: 'M', border: 1, blackColor: '#000', whiteColor: '#fff' }),
    [code],
  );
  return (
    <div className="trade-invite">
      <div className="qr-card" aria-label={`QR code to join trade ${code}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="trade-invite-code">
        Code <strong className="trade-code">{code}</strong>
      </div>
      <p className="fine-print">Have your partner scan this with their camera, or enter the code on their Trade page.</p>
    </div>
  );
}
