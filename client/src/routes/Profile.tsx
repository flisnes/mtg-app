import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MAX_FAVORITES,
  sanitizeProfile,
  type DeckFormat,
  type FavoriteCard,
  type FavoriteDeck,
  type OracleCard,
  type Priced,
  type Printing,
  type ProfileAvatar,
  type UserProfile,
} from '@mtg/shared';
import { apiErrorText, getUserProfile, putProfile } from '../account/api.js';
import { rememberOwnProfile } from '../account/ownProfile.js';
import { useApiQuery } from '../account/useApiQuery.js';
import { RequireAccount } from '../components/RequireAccount.js';
import { getPrintingsForOracle } from '../db/queries.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { formatLabel } from '../deck/legality.js';
import { containerKind } from '../deck/containers.js';
import { useDeckSummaries } from '../deck/deckSummary.js';
import { useContainersByRecent } from '../db/collectionSnapshot.js';
import { Avatar } from '../components/Avatar.js';
import { AvatarEditorSheet, CardSearch } from '../components/AvatarEditorSheet.js';
import { CardSheet } from '../components/CardSheet.js';
import { EditionGrid } from '../components/cardSheet/EditionGrid.js';
import { Icon } from '../components/icons.js';
import { ManaCost } from '../components/ManaCost.js';
import { useCardArtist } from '../components/useCardArtist.js';
import { ListPickerSheet } from '../components/ListPicker.js';
import { Sheet } from '../components/Sheet.js';
import { useToast } from '../components/Toast.js';
import { EmptyState, Page } from './Page.js';
import { Loading } from '../components/Loading.js';
import { MenuRow } from '../components/MenuRow.js';
import { plural } from '../util/format.js';

// Public profile page (/profile/:username): profile picture plus up to three
// favorite cards and decks. Your own profile is edited right here; everyone
// else's is read-only. Reached from the Community list (tap an avatar) and
// from Account & sync.


export function Profile() {
  const { username = '' } = useParams<{ username: string }>();
  return (
    <RequireAccount title="Profile" signedOutText="Sign in to view profiles.">
      {(session) => (
        <ProfileView
          token={session.token}
          username={username}
          isMe={session.username.toLowerCase() === username.toLowerCase()}
        />
      )}
    </RequireAccount>
  );
}

function ProfileView({ token, username, isMe }: { token: string; username: string; isMe: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: profile, error, setData: setProfile } = useApiQuery(
    () =>
      getUserProfile(token, username).then((res) => {
        // Another user's profile is untrusted input, same as trade shares.
        const clean = sanitizeProfile(res.profile);
        if (isMe) void rememberOwnProfile(username, clean);
        return clean;
      }),
    [token, username],
    { fallback: 'Could not load the profile.', notFound: 'No such user.' },
  );
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [cardSlot, setCardSlot] = useState<number | null>(null);
  const [deckSlot, setDeckSlot] = useState<number | null>(null);
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  /** Apply an edit locally and push the whole profile to the server. */
  function save(update: (p: UserProfile) => UserProfile) {
    if (!profile) return;
    const prev = profile;
    const next = update(profile);
    setProfile(next);
    void rememberOwnProfile(username, next); // keep the header's and Share's cached copy current
    putProfile(token, next)
      .then(() => toast('Profile saved'))
      .catch((err) => {
        // Roll back the optimistic change (and the header cache) so the UI
        // doesn't keep showing an edit the server rejected.
        setProfile(prev);
        void rememberOwnProfile(username, prev);
        toast(apiErrorText(err, 'Could not save your profile.'));
      });
  }

  // Resolve favorite-card art from the viewer's own card DB (ids travel, pixels don't).
  const favCards = profile?.favoriteCards ?? [];
  const cards = useCardMaps(favCards);
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
        <Loading fine />
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
                  const oracle = cards.oracleMap?.get(fav.oracleId);
                  const printing = cards.printMap?.get(fav.scryfallId);
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
                  const row = {
                    icon: fav ? ('decks' as const) : ('plus' as const),
                    label: fav ? fav.name : <span className="fine-print">Add a favorite deck</span>,
                    meta: fav && (
                      <>
                        <span className="deck-format">{formatLabel(fav.format as DeckFormat)}</span>
                        <ManaCost
                          cost={fav.colors.length > 0 ? fav.colors.map((c) => `{${c}}`).join('') : '{C}'}
                          className="deck-colors"
                        />
                        <span className="badge">
                          {fav.cards} {plural(fav.cards, 'card')}
                        </span>
                      </>
                    ),
                  };
                  return (
                    <li key={i}>
                      {isMe ? (
                        <MenuRow {...row} chevron={false} onClick={() => setDeckSlot(i)} />
                      ) : fav?.deckId ? (
                        <MenuRow
                          {...row}
                          onClick={() =>
                            navigate(`/profile/${encodeURIComponent(username)}/deck/${encodeURIComponent(fav.deckId!)}`)
                          }
                        />
                      ) : (
                        <MenuRow {...row} chevron={false} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {isMe && (
              <p className="fine-print">
                Favoriting a deck shares its decklist: anyone signed in can browse it here. Your other decks stay
                private.
              </p>
            )}
          </section>

          {profile.avatar && <ArtCredit scryfallId={profile.avatar.scryfallId} />}
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
        <CardSheet mode="info" oracleCard={info.oracle} initialScryfallId={info.scryfallId} onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}

/** Credits the artist whose card art the profile picture is cropped from. */
function ArtCredit({ scryfallId }: { scryfallId: string }) {
  const artist = useCardArtist(scryfallId);
  if (!artist) return null;
  return <p className="profile-art-credit">Profile picture art by {artist}.</p>;
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
  // Two steps, like the profile-picture editor: search a card, then pick the
  // printing from the same edition grid the card sheet uses.
  const [pending, setPending] = useState<{ card: Priced<OracleCard>; printings: Priced<Printing>[] } | null>(null);

  async function choose(card: Priced<OracleCard>) {
    const printings = await getPrintingsForOracle(card.oracleId);
    if (printings.length <= 1) {
      onPick({ oracleId: card.oracleId, scryfallId: printings[0]?.scryfallId ?? card.defaultScryfallId, name: card.name });
      return;
    }
    setPending({ card, printings });
  }

  return (
    <Sheet onClose={onClose} title="Pick a favorite card">
      <CardSearch
        onPick={(c) => void choose(c)}
        onCancel={onClose}
        actions={
          hasCurrent && (
            <button className="danger-outline" onClick={onClear}>
              Clear slot
            </button>
          )
        }
      />
      {pending && (
        <EditionGrid
          printings={pending.printings}
          selected={pending.card.defaultScryfallId}
          onSelect={(scryfallId) =>
            onPick({ oracleId: pending.card.oracleId, scryfallId, name: pending.card.name })
          }
          onClose={() => setPending(null)}
        />
      )}
    </Sheet>
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
  // Same summary the Decks page computes: mainboard count + color identity.
  // Only actual decks — a profile shows off brews, not where you keep your bulk.
  const recent = useContainersByRecent();
  const list = useMemo(() => recent?.filter((d) => containerKind(d) === 'deck'), [recent]);
  const decks = useDeckSummaries(list);

  return (
    <ListPickerSheet
      title="Pick a favorite deck"
      onClose={onClose}
      items={decks}
      itemKey={({ deck }) => deck.id}
      render={({ deck, main, colors }) => ({
        icon: 'decks',
        label: deck.name,
        meta: (
          <>
            <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>
            <ManaCost cost={colors.length > 0 ? colors.map((c) => `{${c}}`).join('') : '{C}'} className="deck-colors" />
            <span className="badge">{main} cards</span>
          </>
        ),
      })}
      onPick={({ deck, main, colors }) =>
        onPick({ deckId: deck.id, name: deck.name, format: deck.format ?? 'casual', colors, cards: main })
      }
      empty={
        <div className="empty-state">
          <p>No decks yet.</p>
          <p className="empty-phase">Brew one on the Decks tab first.</p>
        </div>
      }
      foot={<p className="fine-print">Favoriting a deck lets other signed-in users browse its decklist.</p>}
      actions={
        hasCurrent && (
          <button className="danger-outline" onClick={onClear}>
            Clear slot
          </button>
        )
      }
    />
  );
}
