import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MatchCard } from '@mtg/shared';
import { useNotifications } from '../account/useNotifications.js';
import { dismissMatch, fetchMatchesNow, markAllSeen } from '../account/notifications.js';
import { useFilingConflictCount } from '../db/usePlacements.js';
import { Icon } from './icons.js';

// Bell in the header, next to the account icon. A red dot appears when there's
// something waiting. Two kinds of thing land here:
//
//   Filing conflicts — local, and the reason the bell shows up even when you're
//     signed out: a copy of yours is filed in more places than you own, which
//     nothing else on screen is going to nag you about. Taps through to the
//     walkthrough at /conflicts.
//   Trade matches — from the server, when signed in. Opening the dropdown lists
//     every undismissed match (new ones highlighted), refreshes, and marks them
//     seen so the dot clears. Tapping one opens that user's Community page with
//     the matched cards highlighted.

function names(cards: MatchCard[], max = 3): string {
  const shown = cards.slice(0, max).map((c) => c.name);
  const extra = cards.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra} more` : '');
}

export function NotificationBell({ signedIn }: { signedIn: boolean }) {
  const { items, hasNew: newMatches } = useNotifications();
  const conflicts = useFilingConflictCount();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Which users were new at the moment the dropdown opened — kept so their
  // rows stay highlighted for this viewing even after we mark them seen.
  const [highlightUsers, setHighlightUsers] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Opening: freeze the "new" set for highlighting, clear the match dot, refresh.
  // Conflicts are not "seen away" — they stay until the cards are actually sorted.
  useEffect(() => {
    if (!open) {
      setHighlightUsers(new Set());
      return;
    }
    setHighlightUsers(new Set(itemsRef.current.filter((i) => i.isNew).map((i) => i.username)));
    void markAllSeen();
    void fetchMatchesNow();
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Each direction highlights its own list: cards they have that I want belong
  // in their "Has for trade", cards I have that they want belong in their
  // "Wants". One merged set would light up both, which is how a card you were
  // only ever offered ended up looking like a card you'd asked for.
  function openMatch(username: string, theyWant: MatchCard[], iWant: MatchCard[]) {
    setOpen(false);
    const params = new URLSearchParams();
    if (iWant.length) params.set('hiTrade', iWant.map((c) => c.oracleId).join(','));
    if (theyWant.length) params.set('hiWish', theyWant.map((c) => c.oracleId).join(','));
    const query = params.toString();
    navigate(`/community/${encodeURIComponent(username)}${query ? `?${query}` : ''}`);
  }

  // Nothing to say and nowhere to say it from: signed out with a tidy collection
  // means the bell would only ever open on an empty panel.
  if (!signedIn && conflicts === 0) return null;

  const hasNew = newMatches || conflicts > 0;

  return (
    <div className="header-bell-wrap" ref={wrapRef}>
      <button
        className="header-account header-bell"
        onClick={() => setOpen((v) => !v)}
        aria-label={hasNew ? 'Notifications: something needs your attention' : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
      >
        <Icon name="bell" size={22} />
        {hasNew && <span className="header-bell-dot" aria-hidden />}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          {conflicts > 0 && (
            <>
              <div className="notif-head">Needs sorting out</div>
              <ul className="notif-list">
                <li className="notif-item notif-item-new">
                  <button
                    className="notif-open"
                    onClick={() => {
                      setOpen(false);
                      navigate('/conflicts');
                    }}
                  >
                    <span className="notif-user">
                      <span className="notif-new-dot" aria-hidden />
                      {conflicts} filing conflict{conflicts === 1 ? '' : 's'}
                    </span>
                    <span className="notif-line">
                      <span className="notif-tag notif-tag-have">Where is it?</span>
                      {conflicts === 1 ? 'A card is' : 'Cards are'} filed in more places than you own copies —
                      sort {conflicts === 1 ? 'it' : 'them'} out
                    </span>
                  </button>
                </li>
              </ul>
            </>
          )}

          {signedIn && <div className="notif-head">Trade matches</div>}
          {!signedIn ? null : items.length === 0 ? (
            <p className="notif-empty">
              No matches yet. When another user wants a card you have, or has one you want, it shows up here.
            </p>
          ) : (
            <ul className="notif-list">
              {items.map((it) => {
                const isNew = highlightUsers.has(it.username);
                return (
                  <li key={it.username} className={`notif-item${isNew ? ' notif-item-new' : ''}`}>
                    <button
                      className="notif-open"
                      onClick={() => openMatch(it.username, it.theyWant, it.iWant)}
                    >
                      <span className="notif-user">
                        {isNew && <span className="notif-new-dot" aria-hidden />}
                        {it.username}
                      </span>
                      {it.theyWant.length > 0 && (
                        <span className="notif-line">
                          <span className="notif-tag notif-tag-have">Wants your</span> {names(it.theyWant)}
                        </span>
                      )}
                      {it.iWant.length > 0 && (
                        <span className="notif-line">
                          <span className="notif-tag notif-tag-want">Has for you</span> {names(it.iWant)}
                        </span>
                      )}
                    </button>
                    <button
                      className="notif-dismiss"
                      aria-label={`Dismiss match with ${it.username}`}
                      title="Dismiss"
                      onClick={() => void dismissMatch(it.username)}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
