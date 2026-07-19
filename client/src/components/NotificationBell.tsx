import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MatchCard } from '@mtg/shared';
import { useNotifications } from '../account/useNotifications.js';
import { dismissMatch, fetchMatchesNow, markAllSeen } from '../account/notifications.js';
import { Icon } from './icons.js';

// Bell in the header, next to the account icon. A red dot appears when there's
// a new match. Opening the dropdown lists every undismissed match (new ones
// highlighted), refreshes from the server, and marks them seen so the dot
// clears. Tapping a match opens that user's Community page with the matched
// cards highlighted.

function names(cards: MatchCard[], max = 3): string {
  const shown = cards.slice(0, max).map((c) => c.name);
  const extra = cards.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra} more` : '');
}

export function NotificationBell() {
  const { items, hasNew } = useNotifications();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Which users were new at the moment the dropdown opened — kept so their
  // rows stay highlighted for this viewing even after we mark them seen.
  const [highlightUsers, setHighlightUsers] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Opening: freeze the "new" set for highlighting, clear the dot, refresh.
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

  function openMatch(username: string, theyWant: MatchCard[], iWant: MatchCard[]) {
    const oracleIds = [...theyWant, ...iWant].map((c) => c.oracleId);
    setOpen(false);
    const query = oracleIds.length ? `?highlight=${encodeURIComponent(oracleIds.join(','))}` : '';
    navigate(`/community/${encodeURIComponent(username)}${query}`);
  }

  return (
    <div className="header-bell-wrap" ref={wrapRef}>
      <button
        className="header-account header-bell"
        onClick={() => setOpen((v) => !v)}
        aria-label={hasNew ? 'Notifications: new matches' : 'Notifications'}
        aria-expanded={open}
        title="Trade matches"
      >
        <Icon name="bell" size={22} />
        {hasNew && <span className="header-bell-dot" aria-hidden />}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Trade matches">
          <div className="notif-head">Trade matches</div>
          {items.length === 0 ? (
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
