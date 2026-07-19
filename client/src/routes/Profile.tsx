import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  MAX_FAVORITES,
  sanitizeProfile,
  type Color,
  type DeckFormat,
  type FavoriteCard,
  type FavoriteDeck,
  type OracleCard,
  type Priced,
  type ProfileAvatar,
  type UserProfile,
} from '@mtg/shared';
import { ApiError, getUserProfile, putProfile } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { searchCards } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { formatLabel } from '../deck/legality.js';
import { Avatar, artCropUrl } from '../components/Avatar.js';
import { AvatarEditorSheet } from '../components/AvatarEditorSheet.js';
import { CardSheet } from '../components/CardSheet.js';
import { Icon } from '../components/icons.js';
import { ManaCost } from '../components/ManaCost.js';
import { useToast } from '../components/Toast.js';
import { useEscapeToClose } from '../components/useEscapeToClose.js';
import { EmptyState, Page } from './Page.js';

// Public profile page (/profile/:username): profile picture plus up to three
// favorite cards and decks. Your own profile is edited right here; everyone
// else's is read-only. Reached from the Community list (tap an avatar) and
// from Account & sync.

const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

export function Profile() {
  const { username = '' } = useParams<{ username: string }>();
  const account = useAccount();

  if (!account.enabled || account.session === null) {
    return (
      <Page title="Profile">
        <EmptyState hint={<Link to="/account">Go to Account &amp; sync</Link>}>
          {account.enabled ? 'Sign in to view profiles.' : 'Accounts aren’t configured for this build yet.'}
        </EmptyState>
      </Page>
    );
  }
  if (account.session === undefined) return <Page title="Profile">{null}</Page>;

  return (
    <ProfileView
      token={account.session.token}
      username={username}
      isMe={account.session.username.toLowerCase() === username.toLowerCase()}
    />
  );
}

function ProfileView({ token, username, isMe }: { token: string; username: string; isMe: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [cardSlot, setCardSlot] = useState<number | null>(null);
  const [deckSlot, setDeckSlot] = useState<number | null>(null);
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUserProfile(token, username)
      .then((res) => {
        // Another user's profile is untrusted input, same as trade shares.
        if (!cancelled) setProfile(sanitizeProfile(res.profile));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'No such user.'
            : err instanceof ApiError
              ? err.friendlyMessage
              : 'Could not load the profile.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, username]);

  /** Apply an edit locally and push the whole profile to the server. */
  function save(update: (p: UserProfile) => UserProfile) {
    if (!profile) return;
    const next = update(profile);
    setProfile(next);
    putProfile(token, next)
      .then(() => toast('Profile saved'))
      .catch((err) => toast(err instanceof ApiError ? err.friendlyMessage : 'Could not save your profile.'));
  }

  // Resolve favorite-card art from the viewer's own card DB (ids travel, pixels don't).
  const cards = useLiveQuery(async () => {
    const favs = profile?.favoriteCards ?? [];
    const [oracles, printings] = await Promise.all([
      getOracleCardsByIds(favs.map((f) => f.oracleId)),
      getPrintingsByIds(favs.map((f) => f.scryfallId)),
    ]);
    return { oracles, printings };
  }, [profile]);

  const favCards = profile?.favoriteCards ?? [];
  const favDecks = profile?.favoriteDecks ?? [];
  // Own profile always shows all three slots (empty ones invite a pick).
  const cardSlots = isMe ? MAX_FAVORITES : favCards.length;
  const deckSlots = isMe ? MAX_FAVORITES : favDecks.length;

  return (
    <Page
      title={username}
      subtitle={isMe ? 'This is how other users see you.' : undefined}
      menu={
        <button className="ghost" onClick={() => navigate(`/community/${encodeURIComponent(username)}`)}>
          {isMe ? 'My shared lists' : 'Trade & wishlists'}
        </button>
      }
    >
      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : !profile ? (
        <p className="fine-print">Loading…</p>
      ) : (
        <>
          <div className="profile-head">
            <Avatar avatar={profile.avatar} username={username} size={96} />
            {isMe && (
              <div className="profile-head-actions">
                <button onClick={() => setEditingAvatar(true)}>
                  {profile.avatar ? 'Change picture…' : 'Pick a card art…'}
                </button>
                {profile.avatar && (
                  <button className="ghost" onClick={() => save((p) => ({ ...p, avatar: null }))}>
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>

          <section className="about-section">
            <h2>Favorite cards</h2>
            {cardSlots === 0 ? (
              <p className="fine-print">No favorite cards picked yet.</p>
            ) : (
              <div className="fav-card-grid">
                {Array.from({ length: cardSlots }, (_, i) => {
                  const fav = favCards[i];
                  if (!fav) {
                    return (
                      <button key={i} className="fav-card-empty" onClick={() => setCardSlot(i)}>
                        <Icon name="plus" />
                        <span>Add a favorite</span>
                      </button>
                    );
                  }
                  const oracle = cards?.oracles.get(fav.oracleId);
                  const printing = cards?.printings.get(fav.scryfallId);
                  const image = printing?.imageNormal ?? oracle?.imageNormal ?? null;
                  const open = isMe
                    ? () => setCardSlot(i)
                    : oracle
                      ? () => setInfo({ oracle, scryfallId: fav.scryfallId })
                      : undefined;
                  return (
                    <button key={fav.scryfallId + i} className="fav-card" onClick={open} disabled={!open}>
                      {image ? (
                        <img src={image} alt={fav.name} loading="lazy" />
                      ) : (
                        <span className="fav-card-ph">{oracle?.name ?? fav.name}</span>
                      )}
                      <span className="fav-card-name">{oracle?.name ?? fav.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="about-section">
            <h2>Favorite decks</h2>
            {deckSlots === 0 ? (
              <p className="fine-print">No favorite decks picked yet.</p>
            ) : (
              <ul className="menu-list">
                {Array.from({ length: deckSlots }, (_, i) => {
                  const fav = favDecks[i];
                  const inner = fav ? (
                    <>
                      <span className="menu-icon" aria-hidden>
                        <Icon name="decks" />
                      </span>
                      <span className="deck-line">
                        <span className="deck-name">{fav.name}</span>
                        <span className="deck-meta">
                          <span className="deck-format">{formatLabel(fav.format as DeckFormat)}</span>
                          <ManaCost
                            cost={fav.colors.length > 0 ? fav.colors.map((c) => `{${c}}`).join('') : '{C}'}
                            className="deck-colors"
                          />
                          <span className="badge">{fav.cards} cards</span>
                        </span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="menu-icon" aria-hidden>
                        <Icon name="plus" />
                      </span>
                      <span className="deck-line">
                        <span className="deck-name fine-print">Add a favorite deck</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={i}>
                      {isMe ? (
                        <button className="menu-item menu-item-btn" onClick={() => setDeckSlot(i)}>
                          {inner}
                        </button>
                      ) : (
                        <span className="menu-item">{inner}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {isMe && (
              <p className="fine-print">
                Favorites show a summary only — your decklists stay private.
              </p>
            )}
          </section>
        </>
      )}

      {editingAvatar && (
        <AvatarEditorSheet
          onSave={(avatar: ProfileAvatar) => {
            save((p) => ({ ...p, avatar }));
            setEditingAvatar(false);
          }}
          onClose={() => setEditingAvatar(false)}
        />
      )}
      {cardSlot !== null && profile && (
        <FavoriteCardPickerSheet
          hasCurrent={cardSlot < favCards.length}
          onPick={(fav) => {
            save((p) => ({ ...p, favoriteCards: setSlot(p.favoriteCards, cardSlot, fav) }));
            setCardSlot(null);
          }}
          onClear={() => {
            save((p) => ({ ...p, favoriteCards: p.favoriteCards.filter((_, i) => i !== cardSlot) }));
            setCardSlot(null);
          }}
          onClose={() => setCardSlot(null)}
        />
      )}
      {deckSlot !== null && profile && (
        <FavoriteDeckPickerSheet
          hasCurrent={deckSlot < favDecks.length}
          onPick={(fav) => {
            save((p) => ({ ...p, favoriteDecks: setSlot(p.favoriteDecks, deckSlot, fav) }));
            setDeckSlot(null);
          }}
          onClear={() => {
            save((p) => ({ ...p, favoriteDecks: p.favoriteDecks.filter((_, i) => i !== deckSlot) }));
            setDeckSlot(null);
          }}
          onClose={() => setDeckSlot(null)}
        />
      )}
      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}

/** Replace slot i (slots beyond the array's end append, keeping it dense). */
function setSlot<T>(list: T[], i: number, value: T): T[] {
  const next = list.slice(0, MAX_FAVORITES);
  next[Math.min(i, next.length)] = value;
  return next;
}

function FavoriteCardPickerSheet({
  hasCurrent,
  onPick,
  onClear,
  onClose,
}: {
  hasCurrent: boolean;
  onPick: (fav: FavoriteCard) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Priced<OracleCard>[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void searchCards(q, {}, 24).then((res) => {
      if (!cancelled) setResults(res.cards);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pick a favorite card">
        <div className="sheet-name">Pick a favorite card</div>
        <input
          className="search-input"
          placeholder="Search any card…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {results.length > 0 && (
          <ul className="menu-list avatar-results">
            {results.map((c) => (
              <li key={c.oracleId}>
                <button
                  className="menu-item menu-item-btn"
                  onClick={() => onPick({ oracleId: c.oracleId, scryfallId: c.defaultScryfallId, name: c.name })}
                >
                  {artCropUrl(c.imageNormal) ? (
                    <img className="avatar-result-thumb" src={artCropUrl(c.imageNormal)!} alt="" loading="lazy" />
                  ) : (
                    <span className="avatar-result-thumb" />
                  )}
                  <span className="deck-line">
                    <span className="deck-name">{c.name}</span>
                    <span className="deck-meta">{c.typeLine}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sheet-actions">
          {hasCurrent && (
            <button className="danger-outline" onClick={onClear}>
              Clear slot
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FavoriteDeckPickerSheet({
  hasCurrent,
  onPick,
  onClear,
  onClose,
}: {
  hasCurrent: boolean;
  onPick: (fav: FavoriteDeck) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  // Same summary the Decks page computes: mainboard count + color identity.
  const decks = useLiveQuery(async () => {
    const list = await db.decks.orderBy('updatedAt').reverse().toArray();
    return Promise.all(
      list.map(async (deck) => {
        const cards = await db.deckCards.where('deckId').equals(deck.id).toArray();
        const main = cards.filter((c) => c.board !== 'side').reduce((s, c) => s + c.quantity, 0);
        const oracles = await getOracleCardsByIds(cards.map((c) => c.oracleId));
        const present = new Set<Color>();
        for (const card of oracles.values()) for (const c of card.colorIdentity) present.add(c);
        return { deck, main, colors: COLOR_ORDER.filter((c) => present.has(c)) };
      }),
    );
  }, []);

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pick a favorite deck">
        <div className="sheet-name">Pick a favorite deck</div>
        {decks === undefined ? (
          <p className="search-meta">Loading…</p>
        ) : decks.length === 0 ? (
          <div className="empty-state">
            <p>No decks yet.</p>
            <p className="empty-phase">Brew one on the Decks tab first.</p>
          </div>
        ) : (
          <ul className="menu-list">
            {decks.map(({ deck, main, colors }) => (
              <li key={deck.id}>
                <button
                  className="menu-item menu-item-btn"
                  onClick={() =>
                    onPick({ name: deck.name, format: deck.format ?? 'casual', colors, cards: main })
                  }
                >
                  <span className="menu-icon" aria-hidden>
                    <Icon name="decks" />
                  </span>
                  <span className="deck-line">
                    <span className="deck-name">{deck.name}</span>
                    <span className="deck-meta">
                      <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>
                      <ManaCost
                        cost={colors.length > 0 ? colors.map((c) => `{${c}}`).join('') : '{C}'}
                        className="deck-colors"
                      />
                      <span className="badge">{main} cards</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sheet-actions">
          {hasCurrent && (
            <button className="danger-outline" onClick={onClear}>
              Clear slot
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
