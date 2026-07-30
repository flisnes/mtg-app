import { useState } from 'react';

// The "an update is waiting, may we?" ribbon, shared by the data feeds that can
// spend the user's bandwidth (see cardDb/useCardDbUpdate.ts and the scan-data
// path in ScanSheet.tsx). Nothing downloads on its own until someone says so
// here — and "don't ask again" turns that answer into the standing policy, so
// the ribbon isn't a daily toll.

export interface UpdatePromptCopy {
  /** What's on offer, e.g. "Card data update available (~9 MB)." */
  message: string;
  /** Accept-button label; defaults to "Update". */
  accept?: string;
}

export function UpdatePrompt({
  message,
  accept = 'Update',
  busy = false,
  progress,
  onAccept,
  onDecline,
}: UpdatePromptCopy & {
  /** Downloading right now: show progress instead of the buttons. */
  busy?: boolean;
  progress?: { fraction: number; label: string } | null;
  /** `remember` is the state of the don't-ask-again box when the button was hit. */
  onAccept: (remember: boolean) => void;
  onDecline: (remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);

  if (busy) {
    return (
      <div className="banner banner-update" role="status">
        <div className="banner-progress">
          <span>{progress?.label ?? 'Updating…'}</span>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="banner banner-update banner-stack" role="status">
      <div className="banner-row">
        <span>{message}</span>
        <span className="banner-actions">
          <button onClick={() => onAccept(remember)}>{accept}</button>
          <button onClick={() => onDecline(remember)}>Not now</button>
        </span>
      </div>
      <label className="banner-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          Don’t ask again — remember whichever button I pick. You can change this any time in Settings under
          “Automatic downloads”.
        </span>
      </label>
    </div>
  );
}
