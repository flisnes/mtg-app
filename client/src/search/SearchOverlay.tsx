import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation } from 'react-router-dom';
import { isUncheckedFormat, type Color, type DeckFormat, type OracleCard, type Priced } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { db } from '../db/schema.js';
import { useCommandZone } from '../db/useCommandZone.js';
import { addToWishlistBulk } from '../db/dataAccess.js';
import { formatLabel, isBackground, isValidCommanderPair, needsColorChoice } from '../deck/legality.js';
import { containerMetaFor } from '../deck/containers.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardSearchView, splitResultKey } from '../components/CardSearchView.js';
import { SelectionBar } from '../components/BulkActionBar.js';
import { useMultiSelect } from '../components/useMultiSelect.js';
import { ScopedResults } from '../components/ScopedResults.js';
import { ProfileScopedResults } from '../components/ProfileScopedResults.js';
import { ContainerScopedResults } from '../components/ContainerScopedResults.js';
import { Icon, type IconName } from '../components/icons.js';
import { ownedBadge } from '../components/OwnedBadge.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { useToast } from '../components/Toast.js';
import { useAccount } from '../account/useAccount.js';
import { plural } from '../util/format.js';
import { useSearchCtx } from './searchContext.js';
import { listScopeFor, SCOPE_NOUN, SCOPES, useProfileScope, useSearchTarget, type PageScope } from './scope.js';
import { shownId, useQuickAdd } from './quickAdd.js';

interface DeckSearchContext {
  format: DeckFormat;
  /** The command zone's identity, or null outside Commander / with no commander yet. */
  identity: Color[] | null;
  commanders: OracleCard[];
}

/**
 * Searching from a deck filters to cards you could actually play there: legal
 * in the deck's format and, for Commander, within the commander's identity.
 * Pair mode ("Find a partner") swaps the identity filter for "can share the
 * command zone with this one". `deckCtx` is undefined while loading and null
 * off a deck; `pairDone` says the pair search has done its job.
 */
function useDeckSearchContext(
  deckId: string | undefined,
  pairWith: OracleCard | null,
  filters: SearchFilters,
  legalOnly: boolean,
): { deckCtx: DeckSearchContext | null | undefined; effectiveFilters: SearchFilters; pairDone: boolean } {
  const deck = useLiveQuery(async () => (deckId ? ((await db.decks.get(deckId)) ?? null) : null), [deckId]);
  // Keyed on the deck alone, not on its format: gated on a format that hadn't
  // loaded yet, the zone first answered "empty" for no deck, and useLiveQuery
  // kept that answer for a beat once the deck arrived. One commander-less
  // render was enough for pairDone to end "Find a partner" before it started.
  // Non-Commander decks have no commander slots, so the read is just empty.
  const zone = useCommandZone(deckId);
  const deckCtx = useMemo((): DeckSearchContext | null | undefined => {
    if (deck === undefined || zone === undefined) return undefined;
    if (!deck) return null;
    const format: DeckFormat = deck.format ?? 'casual';
    if (format !== 'commander' || !zone.length) return { format, identity: null, commanders: [] };
    // A choose-a-color commander's pick (Prismatic Piper & co) is part of the
    // identity, exactly as the legality checker counts it.
    const identity = [
      ...new Set(
        zone.flatMap(({ slot, card }) =>
          slot.chosenColor && needsColorChoice(card) ? [...card.colorIdentity, slot.chosenColor] : card.colorIdentity,
        ),
      ),
    ];
    return { format, identity, commanders: zone.map((z) => z.card) };
  }, [deck, zone]);
  const deckFilterActive = legalOnly && !!deckCtx && !isUncheckedFormat(deckCtx.format);

  // One commander in the zone shouldn't hide the partner or Background that
  // would join them: the second commander is exactly what widens the identity.
  // (Legendary-or-Background first, so the pairing regexes only run on the few.)
  const partnerExempt = useMemo(() => {
    const solo = deckCtx?.commanders.length === 1 ? deckCtx.commanders[0]! : null;
    if (!solo) return undefined;
    return (c: OracleCard) => (/\bLegendary\b/.test(c.typeLine) || isBackground(c)) && isValidCommanderPair(solo, c);
  }, [deckCtx]);

  // Pair mode ends itself once the zone stops holding exactly that one
  // commander: adding the partner is the point, and from there the ordinary
  // identity filter is the right one.
  const pairFilter = useMemo(() => {
    if (!pairWith) return undefined;
    return (c: OracleCard) =>
      c.oracleId !== pairWith.oracleId &&
      (/\bLegendary\b/.test(c.typeLine) || isBackground(c)) &&
      isValidCommanderPair(pairWith, c);
  }, [pairWith]);
  const pairDone =
    !!pairWith && !!deckCtx && !(deckCtx.commanders.length === 1 && deckCtx.commanders[0]!.oracleId === pairWith.oracleId);

  const effectiveFilters = useMemo<SearchFilters>(
    () =>
      pairFilter && deckCtx
        ? { ...filters, legalIn: deckCtx.format, pairOnly: pairFilter }
        : deckFilterActive
          ? {
              ...filters,
              legalIn: deckCtx!.format,
              identity: deckCtx!.identity ?? undefined,
              identityExempt: partnerExempt,
            }
          : filters,
    [filters, deckFilterActive, deckCtx, partnerExempt, pairFilter],
  );
  return { deckCtx, effectiveFilters, pairDone };
}

export function SearchOverlay({ history, recent }: { history: ReactNode; recent: ReactNode }) {
  const { query, filters, setFilters, scope, setScope, pairWith, setPairWith } = useSearchCtx();
  const { pathname } = useLocation();
  // The sheet opens on the printing the result was showing, so tapping a tile
  // doesn't silently swap to a different edition than the one you tapped.
  const [sheetCard, setSheetCard] = useState<{ card: Priced<OracleCard>; scryfallId?: string } | null>(null);
  const [deckLegalOnly, setDeckLegalOnly] = useState(true);
  const toast = useToast();
  const target = useSearchTarget();
  const { session } = useAccount();
  const profile = useProfileScope(session?.username);
  // The viewed user's two lists are what you're looking at on their page, so
  // both start on. They're independent of your own (single) scope.
  const [profileTradeOn, setProfileTradeOn] = useState(!!profile);
  const [profileWishOn, setProfileWishOn] = useState(!!profile);
  const ownership = useOwnershipIndex();

  // Unlike the three list pills, this one never starts on: standing on a deck
  // doesn't mean you want search narrowed to it, since half of what you're
  // there to do is find cards that *aren't* in it yet. So the pill offers the
  // scope; it never assumes it the way listScopeFor does for your own lists.
  const [containerOn, setContainerOn] = useState(false);

  // Multi-select over the results. A search result is a card, not a copy you
  // own, so the only thing a selection of them can honestly do is go on the
  // wishlist: adding to the collection needs an edition, a condition and a
  // language per card, which is exactly what the card sheet is for.
  const sel = useMultiSelect();
  const [resultKeys, setResultKeys] = useState<string[]>([]);

  async function bulkWish() {
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    // A row pinned to a printing by a `set:` term wishes for that printing; an
    // ordinary row still wishes for the card, any edition.
    const res = await addToWishlistBulk(
      ids.map((key) => ({ ...splitResultKey(key), quantity: 1 })),
      { source: 'manual', label: 'From search' },
    );
    toast(`Added ${res.cards} ${plural(res.cards, 'card')} to wishlist`);
    sel.exit();
  }

  // Wording for the container being searched from (a deck, binder or box).
  const containerMeta = containerMetaFor(target);

  const deckId = target.kind === 'deck' ? target.deckId : undefined;
  const { deckCtx, effectiveFilters, pairDone } = useDeckSearchContext(deckId, pairWith, filters, deckLegalOnly);
  useEffect(() => {
    if (pairDone) setPairWith(null);
  }, [pairDone, setPairWith]);

  // Owned cards win ties in best match: "bolt" with a Lightning Bolt in the
  // binder should find that one first. Ownership is read through a ref so the
  // filters keep their identity across collection writes: a quick-add from a
  // result row must not cancel and re-run the search under the user's finger
  // (the card just added would climb the list). The tiebreak catches up on the
  // next typed query.
  const ownershipRef = useRef(ownership);
  ownershipRef.current = ownership;
  const rankedFilters = useMemo<SearchFilters>(
    () => ({ ...effectiveFilters, preferOwned: (id: string) => (ownershipRef.current?.lookup(id).qty ?? 0) > 0 }),
    [effectiveFilters],
  );

  const { quickAdd, actionsFor, targetHint } = useQuickAdd(target, deckCtx?.format);

  // The full set of pills for this context: your own three everywhere, this
  // container's one wherever you're standing on a deck/binder/box, plus the
  // viewed user's two on their community page.
  // The movers pill only exists on the movers page: nothing off it can render
  // that list, so carrying the scope away would have nothing to show.
  const pageScopes: { key: PageScope; label: string; icon: IconName }[] =
    listScopeFor(pathname) === 'movers' ? [...SCOPES, { key: 'movers', label: 'Price movers', icon: 'prices' }] : SCOPES;

  const pills: { key: string; label: string; icon: IconName; title: string; on: boolean; toggle: () => void }[] = [
    ...pageScopes.map((s) => ({
      key: s.key,
      label: s.label,
      icon: s.icon,
      title: `Search your ${s.label.toLowerCase()}`,
      on: scope === s.key,
      toggle: () => {
        setScope(scope === s.key ? null : s.key);
        setContainerOn(false);
      },
    })),
    ...(target.kind === 'deck'
      ? [
          {
            key: 'container',
            label: `This ${containerMeta.noun}`,
            icon: containerMeta.icon,
            title: `Search this ${containerMeta.noun}`,
            on: containerOn,
            toggle: () => {
              setContainerOn((v) => !v);
              setScope(null);
            },
          },
        ]
      : []),
    ...(profile
      ? [
          {
            key: 'profileTrade',
            label: `${profile.username}’s tradelist`,
            icon: 'tradelist' as IconName,
            title: `Search ${profile.username}’s tradelist`,
            on: profileTradeOn,
            toggle: () => setProfileTradeOn((v) => !v),
          },
          {
            key: 'profileWish',
            label: `${profile.username}’s wishlist`,
            icon: 'wishlist' as IconName,
            title: `Search ${profile.username}’s wishlist`,
            on: profileWishOn,
            toggle: () => setProfileWishOn((v) => !v),
          },
        ]
      : []),
  ];

  const chips = (
    <div className="scope-chips" role="group" aria-label="Search within">
      {pills.map((s) => (
        <button key={s.key} className="chip" aria-pressed={s.on} onClick={s.toggle} title={s.title}>
          <Icon name={s.icon} size={14} /> {s.label}
        </button>
      ))}
    </div>
  );

  const profileActive = !!profile && !!session && (profileTradeOn || profileWishOn);
  const scoped = !!scope || profileActive || containerOn;

  // Scoped to the list this very page renders: it filters itself (keeping its
  // sort, multi-select and bulk actions), so all the overlay contributes is the
  // chip row. Everything else gets the full-screen results. Every hook above
  // has to stay above this return: toggling the chip flips the branch.
  if (scope && listScopeFor(pathname) === scope) {
    return (
      <div className="search-scopebar">
        <div className="search-overlay-inner">
          {chips}
          {history}
          {!query && !history && (
            <p className="search-meta">Filtering your {SCOPE_NOUN[scope]}. Turn the chip off to search every card instead.</p>
          )}
        </div>
      </div>
    );
  }

  const filterExtras = pairWith ? (
    // Pair mode replaces the identity toggle: unchecking it is the way back to
    // the ordinary deck-legal search.
    <label className="deck-filter-toggle" title={`Only cards that can share the command zone with ${pairWith.name}`}>
      <input type="checkbox" checked onChange={() => setPairWith(null)} />
      Can partner with {pairWith.name}
    </label>
  ) : (
    deckCtx &&
    !isUncheckedFormat(deckCtx.format) && (
      <label className="deck-filter-toggle" title="Hide cards this deck can't legally play">
        <input type="checkbox" checked={deckLegalOnly} onChange={(e) => setDeckLegalOnly(e.target.checked)} />
        {formatLabel(deckCtx.format)}-legal
        {deckCtx.identity && ` · ${deckCtx.identity.length ? deckCtx.identity.join('') : 'C'} identity`}
      </label>
    )
  );

  // Nothing typed yet: the hint, then the recent searches (the panel under the
  // chips only shows while the input has focus; this one is for after).
  const emptyState = history ? null : (
    <>
      <p className="search-meta">
        Type a card name to search the whole card database.{targetHint && ` ${targetHint}`}
      </p>
      {recent}
    </>
  );

  return (
    <div className="search-overlay">
      <div className="search-overlay-inner">
        {chips}
        {history}

        {scoped ? (
          <>
            {scope && scope !== 'movers' && <ScopedResults scope={scope} query={query} />}
            {containerOn && target.kind === 'deck' && (
              <ContainerScopedResults deckId={target.deckId} kind={containerMeta.kind} format={deckCtx?.format} query={query} />
            )}
            {profileActive && profile && session && (
              <ProfileScopedResults
                token={session.token}
                username={profile.username}
                query={query}
                showTrade={profileTradeOn}
                showWish={profileWishOn}
              />
            )}
          </>
        ) : (
          <CardSearchView
            query={query}
            filters={filters}
            setFilters={setFilters}
            effectiveFilters={rankedFilters}
            filterExtras={filterExtras}
            showFilters={false}
            sortKey="search"
            emptyState={emptyState}
            badgeFor={(card, printing) => ownedBadge(ownership?.lookup(card.oracleId, shownId(card, printing)))}
            actionsFor={actionsFor}
            quickAdd={quickAdd}
            listOnlyActions
            selection={{ sel, onKeys: setResultKeys }}
            onCardClick={(card, printing) => setSheetCard({ card, scryfallId: printing?.scryfallId })}
          />
        )}

        <SelectionBar
          sel={sel}
          keys={resultKeys}
          actions={[{ label: 'Add to wishlist', icon: 'wishlist', onClick: () => void bulkWish() }]}
        />

        {sheetCard && (
          <CardSheet
            mode="add"
            oracleCard={sheetCard.card}
            initialScryfallId={sheetCard.scryfallId}
            addTarget={target.kind === 'deck' ? { ...target, format: deckCtx?.format } : target}
            onClose={() => setSheetCard(null)}
          />
        )}
      </div>
    </div>
  );
}
