import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProfileAvatar } from '@mtg/shared';
import { Avatar } from './Avatar.js';
import { Icon, type IconName } from './icons.js';

// The header avatar is the front door to everything "about you": your public
// Profile, your Settings (account, sync, data, preferences), and the About
// page. Clicking it opens this little menu instead of jumping straight to one
// page — Profile used to be buried two taps deep in Community.

interface Props {
  signedIn: boolean;
  username: string | undefined;
  ownAvatar: ProfileAvatar | null;
  syncTone: 'ok' | 'busy' | 'err';
  syncLabel: string;
}

export function AccountMenu({ signedIn, username, ownAvatar, syncTone, syncLabel }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  const items: { label: string; icon: IconName; to: string }[] = [
    ...(signedIn && username
      ? [{ label: 'Profile', icon: 'account' as IconName, to: `/profile/${encodeURIComponent(username)}` }]
      : []),
    { label: 'Settings', icon: 'settings', to: '/settings' },
    { label: 'About', icon: 'about', to: '/about' },
  ];

  return (
    <div className="account-menu" ref={ref}>
      <button
        className={signedIn && ownAvatar ? 'header-account header-account-avatar' : 'header-account'}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={signedIn ? `Account menu: signed in as ${username} (${syncLabel})` : 'Account menu'}
        title={signedIn ? `Signed in as ${username} (${syncLabel})` : 'Account'}
      >
        {signedIn && ownAvatar ? (
          <Avatar avatar={ownAvatar} username={username ?? ''} size={28} />
        ) : (
          <Icon name="account" size={22} />
        )}
        {signedIn && <span className={`header-account-dot header-account-dot-${syncTone}`} aria-hidden />}
      </button>
      {open && (
        <div className="options-pop account-menu-pop" role="menu" aria-label="Account menu">
          {signedIn && (
            <div className="account-menu-head">
              <span className="account-menu-name">{username}</span>
              <span className={`account-menu-sync account-menu-sync-${syncTone}`}>{syncLabel}</span>
            </div>
          )}
          {items.map((it) => (
            <button key={it.to} role="menuitem" className="options-item" onClick={() => go(it.to)}>
              <span className="options-icon" aria-hidden>
                <Icon name={it.icon} size={18} />
              </span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
