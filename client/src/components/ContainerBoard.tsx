import { memo, useMemo, useState, type ReactNode } from 'react';
import { COLOR_NAME, COLORS, isMarkerCard, namesCopy, type Color } from '@mtg/shared';
import { setDeckCardChosenColor } from '../db/dataAccess.js';
import type { OwnershipIndex } from '../db/useOwnership.js';
import type { PlacementIndex } from '../db/usePlacements.js';
import { needsColorChoice } from '../deck/legality.js';
import { useDisplayPrintings } from '../cardDb/useDisplayPrintings.js';
import type { DeckCardEdit, EditTarget, Row, SlotStack } from '../routes/container/rows.js';
import { CardItems, type CardItem, type ViewMode } from './CardViews.js';
import { extraLands, groupCards, GroupCountBadge, type GroupKey } from './CardSorting.js';
import { FINISH_LABELS } from './copyTraits.js';
import { ownedBadge } from './OwnedBadge.js';
import { langMark } from './LangFlag.js';
import { yearMark } from './cardRows.js';
import { Icon } from './icons.js';
import { plural } from '../util/format.js';
import { sumQty } from '../util/groupBy.js';

/** Considering is outside the deck, so legality has nothing to say about it. */
export const EMPTY_ISSUES = new Map<string, string>();

/** A slot's wants, spelled out for the row's sub-line ('' = it wants nothing special). */
function wantsDetail(r: Row): string {
  const bits: string[] = [];
  if (r.finish) bits.push(FINISH_LABELS[r.finish] ?? r.finish);
  if (r.condition) bits.push(`min ${r.condition}`);
  if (r.lang) bits.push(r.lang);
  return bits.join(' · ');
}

/**
 * Tokens are named tersely by Scryfall ("Plant", "Zombie") — this rebuilds the
 * fuller description players actually use ("0/1 Green Plant Creature Token"),
 * out of fields every card already carries. Non-creature tokens (Treasure,
 * Clue…) already have a self-describing name, so they just get " Token"
 * appended. Marker cards (Poison Counter, an emblem, Day // Night, Morph) are
 * not tokens at all and keep their printed name verbatim.
 */
export function tokenLabel(o: {
  name: string;
  colors: Color[];
  typeLine: string;
  power?: string | null;
  toughness?: string | null;
}): string {
  if (isMarkerCard(o.name, o.typeLine)) return o.name;
  if (!/\bCreature\b/i.test(o.typeLine)) return `${o.name} Token`;
  const pt = o.power != null && o.toughness != null ? `${o.power}/${o.toughness} ` : '';
  const colorWord = o.colors.length ? `${o.colors.map((c) => COLOR_NAME[c]).join('/')} ` : '';
  return `${pt}${colorWord}${o.name} Creature Token`;
}

/** The selection props every board hands its CardItems, built once by the page. */
export interface BoardSelection {
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onToggleSelect?: (key: string) => void;
}

interface BoardProps {
  title: string;
  rows: Row[];
  /** The rows grouped into tiles, by the page (it needs the same stacks for selection). */
  stacks: SlotStack[];
  /** The container these rows live in, so the card sheet can read its command zone. */
  deckId: string;
  group: GroupKey;
  view: ViewMode;
  issues: Map<string, string>;
  onEdit: (target: EditTarget) => void;
  /** Passed down (not re-queried) so every board reads the same index. */
  ownership?: OwnershipIndex;
  placements?: PlacementIndex;
  /** Slots cut to the clipboard and not yet pasted. */
  cutIds: ReadonlySet<string>;
  /** Multi-select state, shared across every board so one bar covers them all. */
  selection: BoardSelection;
  /** Commander-format deck: show move-to/from-command-zone actions. */
  commanderDeck?: boolean;
  /** Sorted by release date: every slot shows the year it's being ordered on. */
  showYear?: boolean;
  emptyHint?: string;
  /** Command zone only: offer the choose-a-color pips on commanders that ask. */
  colorChoice?: boolean;
  /** Rendered under the cards — the "Find a partner" button. */
  footer?: ReactNode;
}

/**
 * One zone of a deck (or the single pile of a binder or box). Memoized: a page
 * draws up to six of these, and a render of the page (a sheet opening, the
 * name being typed) shouldn't rebuild every tile.
 */
export const ContainerBoard = memo(function ContainerBoard({
  title,
  rows,
  stacks,
  deckId,
  group,
  view,
  issues,
  onEdit,
  ownership,
  placements,
  cutIds,
  selection,
  commanderDeck = false,
  showYear = false,
  emptyHint,
  colorChoice = false,
  footer,
}: BoardProps) {
  // A slot on "any printing" wears your preferred printing, as a search result would.
  const anySlots = useMemo(() => rows.filter((r) => !r.scryfallId), [rows]);
  const shownAny = useDisplayPrintings(anySlots);
  if (rows.length === 0 && title === 'Sideboard') return null;

  const imageOf = (r: Row) =>
    r.printing?.imageSmall ?? (r.scryfallId ? undefined : shownAny.get(r.oracleId)?.imageSmall) ?? r.oracle?.imageSmall ?? null;
  // Same reason as the row spread in ContainerDetail: the slot's own fields
  // come across whole, and only the deck context is added by hand.
  const toEdit = (r: Row): DeckCardEdit => ({ ...r, deckId, commanderDeck });
  /** What a tile and a stack tile share: the card, its art and its warning. */
  const baseItem = (r: Row, issue: string | undefined) => {
    const year = yearMark(r.printing, showYear);
    return {
      key: r.id,
      ...(year ? { year } : {}),
      name: r.oracle ? (r.board === 'token' ? tokenLabel(r.oracle) : r.oracle.name) : '(unknown card)',
      image: imageOf(r),
      mana: r.oracle?.manaCost,
      issueChip: issue && <span className="badge badge-illegal-chip">{issue}</span>,
    };
  };

  /** A stack of several slots as one tile; a stack of one is its slot's own item. */
  const toStackItem = (g: SlotStack): CardItem => {
    if (g.rows.length === 1) return toItem(g.rows[0]!);
    const r = g.lead;
    const issue = issues.get(r.oracleId);
    const { issueChip, ...base } = baseItem(r, issue);
    const enough = g.rows.some((x) => x.anyBasic) || r.owned >= g.quantity;
    // Per card, not per slot: a stack has no single edition, finish or
    // language to be exact about, so the badge says "you own this card".
    const own = ownedBadge(ownership?.lookup(r.oracleId), 13);
    const editions = new Set(g.rows.map((x) => x.scryfallId ?? '')).size;
    return {
      ...base,
      foil: g.rows.some((x) => !!x.finish && x.finish !== 'nonfoil'),
      count: g.quantity,
      badge: issue ? '⚠' : own?.icon,
      badgeClass: issue ? 'badge-illegal' : own?.cls,
      badgeTitle: issue ?? own?.title,
      dim: !enough,
      cut: g.rows.every((x) => cutIds.has(x.id)),
      sub: (
        <>
          {`owned ${r.owned} · ${editions > 1 ? `${editions} editions` : `${g.rows.length} slots`}`}
          {issueChip}
        </>
      ),
      onClick: r.oracle ? () => onEdit({ card: r.oracle!, deckCard: toEdit(r), slots: g.rows.map(toEdit) }) : undefined,
    };
  };

  const toItem = (r: Row): CardItem => {
    const enough = r.anyBasic || r.owned >= r.quantity;
    const issue = issues.get(r.oracleId);
    const { issueChip, ...base } = baseItem(r, issue);
    const wants = r.anyBasic ? '' : wantsDetail(r);
    // Ownership checkmark (own this exact printing / another / for trade), same
    // as everywhere else. A legality problem still wins the badge slot (⚠). A
    // lands-box basic is had by definition, so it gets the plain check.
    // A slot's double check means "I own exactly this card": it names an edition,
    // finish, condition and language, and a copy in your collection fits. A slot
    // that leaves any of those on "any" hasn't picked a card yet, so it keeps the
    // single check even when you own the thing.
    //
    // Above that sits the green collection badge: this slot doesn't just match a
    // card you own, it *holds* it. A pinned slot that lost the copy to a newer
    // filing keeps the double check and shows up in the filing conflicts — and so
    // does one you emptied out by hand (DeckCard.unfiled), which claims nothing
    // and so can never be filed here.
    const pinned = namesCopy(r);
    const filedHere = !r.anyBasic && (placements?.allocated(r.id) ?? 0) >= r.quantity;
    const own = r.anyBasic
      ? { icon: <Icon name="check" size={13} />, cls: 'own-yes', title: 'Any printing, from your lands box' }
      : ownedBadge(
          ownership?.lookupWanted(r.oracleId, {
            scryfallId: r.scryfallId,
            condition: r.condition,
            finish: r.finish,
            lang: r.lang,
          }),
          13,
          r.unfiled
            ? { yes: 'this copy is out of here right now', no: 'but nothing matching this slot' }
            : pinned
              ? { yes: 'including the copy this slot names', no: 'but nothing matching this slot' }
              : { yes: 'including the copy this slot names', no: 'this slot hasn’t picked a copy yet' },
          filedHere,
        );
    // A slot that pinned a language: the flag says which copy the list wants,
    // so a deck built out of your Japanese cards reads as one at a glance.
    const lang = langMark(r.lang);
    // Prismatic Piper & co: pick the color the commander is, right on the card.
    const colorPips =
      colorChoice && r.oracle && needsColorChoice(r.oracle) ? (
        <ColorChoicePicker chosen={r.chosenColor} onPick={(c) => void setDeckCardChosenColor(r.id, c)} />
      ) : undefined;
    return {
      ...base,
      ...(lang ? { lang } : {}),
      ...(colorPips ? { sideStrip: colorPips } : {}),
      // A slot asking for a foil or etched copy gets the sheen; one still on
      // "any finish" hasn't picked a shiny card yet, so it stays matte.
      foil: !!r.finish && r.finish !== 'nonfoil',
      count: r.quantity,
      badge: issue ? '⚠' : own?.icon,
      badgeClass: issue ? 'badge-illegal' : own?.cls,
      badgeTitle: issue ?? own?.title,
      dim: !enough,
      // Cut but not yet pasted: still here, and still yours if you never paste.
      cut: cutIds.has(r.id),
      sub: (
        <>
          {r.anyBasic ? 'any printing' : `owned ${r.owned}`}
          {wants && ` · ${wants}`}
          {r.unfiled && ' · not filed here'}
          {issueChip}
          {r.tags?.length ? (
            <span className="tag-chips">
              {r.tags.map((t) => (
                <span key={t} className="tag-chip">
                  {t}
                </span>
              ))}
            </span>
          ) : null}
        </>
      ),
      onClick: r.oracle ? () => onEdit({ card: r.oracle!, deckCard: toEdit(r) }) : undefined,
    };
  };

  const groups = group === 'none' ? null : groupCards(stacks, (g) => g.lead.oracle, group, (g) => g.lead.tags);
  // Land drops the Land heading would otherwise miss: MDFC backs, Dryad Arbor.
  const landSources = group === 'type' ? extraLands(rows, (r) => r.oracle, (r) => r.quantity) : [];
  // Grouping by tag lists a multi-tagged card under each of its tags, so the
  // headings can add up to more than the board. Say so rather than let the
  // arithmetic look broken.
  const multiTagged = group === 'tag' ? rows.filter((r) => (r.tags?.length ?? 0) > 1).length : 0;
  return (
    <div className="about-section">
      <h2>
        {title} <span className="badge">{sumQty(rows)}</span>
      </h2>
      {multiTagged > 0 && (
        <p className="fine-print">
          {multiTagged} {plural(multiTagged, 'card')} carr{multiTagged === 1 ? 'ies' : 'y'} more than one tag, so
          {multiTagged === 1 ? ' it shows' : ' they show'} up under each of them.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="fine-print">{emptyHint ?? 'Empty.'}</p>
      ) : groups ? (
        groups.map((g) => (
          <div key={g.label} className="card-group">
            <h3 className="card-group-title">
              {g.label}{' '}
              <GroupCountBadge
                quantity={sumQty(g.items)}
                extras={g.label === 'Land' && group === 'type' ? landSources : undefined}
              />
            </h3>
            <CardItems view={view} items={g.items.map(toStackItem)} {...selection} />
          </div>
        ))
      ) : (
        <CardItems view={view} items={stacks.map(toStackItem)} {...selection} />
      )}
      {footer && <div className="board-footer">{footer}</div>}
    </div>
  );
});

/**
 * The mana pips a choose-a-color commander shows until a color is picked (see
 * DeckCard.chosenColor). Picking collapses the strip to the one chosen pip;
 * tapping that pip reopens the strip to change the choice.
 */
function ColorChoicePicker({ chosen, onPick }: { chosen?: Color; onPick: (c: Color) => void }) {
  const [changing, setChanging] = useState(false);
  if (chosen && !changing) {
    return (
      <button
        className="color-pip color-pip-chosen"
        title={`Chosen color: ${COLOR_NAME[chosen]}. Tap to change.`}
        onClick={() => setChanging(true)}
      >
        <i className={`ms ms-${chosen.toLowerCase()} ms-cost`} aria-hidden />
      </button>
    );
  }
  return (
    <div className="color-pip-strip" role="group" aria-label="Choose this commander's color">
      {COLORS.map((c) => (
        <button
          key={c}
          className={`color-pip${chosen === c ? ' color-pip-chosen' : ''}`}
          title={`Be ${COLOR_NAME[c].toLowerCase()}`}
          onClick={() => {
            setChanging(false);
            onPick(c);
          }}
        >
          <i className={`ms ms-${c.toLowerCase()} ms-cost`} aria-hidden />
        </button>
      ))}
    </div>
  );
}
