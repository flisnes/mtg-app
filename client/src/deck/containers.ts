import type { ContainerKind, Deck } from '@mtg/shared';
import type { IconName } from '../components/icons.js';

// Decks, binders and boxes are the same stored row (a `Deck` with a `kind`) —
// a deck is a list you brew, a binder or box is where cards physically live.
// Everything that differs between them is a label, an icon or a route, and it
// all lives here so no screen has to spell out the three cases itself.

interface ContainerMeta {
  kind: ContainerKind;
  /** Singular, lower case ("deck"), for sentences. */
  noun: string;
  /** Singular, capitalised ("Deck"), for headings and buttons. */
  Noun: string;
  /** Plural, capitalised ("Decks"), for the segment control and list titles. */
  Plural: string;
  icon: IconName;
  /** List route ('/decks'); the detail route is `${path}/${id}`. */
  path: string;
  /** Name a freshly created one gets when the field was left blank. */
  untitled: string;
  /** One-liner under the list title. */
  subtitle: string;
}

export const CONTAINER_META: Record<ContainerKind, ContainerMeta> = {
  deck: {
    kind: 'deck',
    noun: 'deck',
    Noun: 'Deck',
    Plural: 'Decks',
    icon: 'decks',
    path: '/decks',
    untitled: 'Untitled deck',
    subtitle: 'Brew decks; owned cards get a green check.',
  },
  binder: {
    kind: 'binder',
    noun: 'binder',
    Noun: 'Binder',
    Plural: 'Binders',
    icon: 'binder',
    path: '/binders',
    untitled: 'Untitled binder',
    subtitle: 'Sort cards into binders to mirror where you actually keep them.',
  },
  box: {
    kind: 'box',
    noun: 'box',
    Noun: 'Box',
    Plural: 'Boxes',
    icon: 'box',
    path: '/boxes',
    untitled: 'Untitled box',
    subtitle: 'Sort cards into boxes to mirror where you actually keep them.',
  },
};

/** The "are you sure" for deleting a container, worded once for every page that offers it. */
export function deleteContainerConfirm(row: Pick<Deck, 'name' | 'kind'>) {
  const meta = containerMeta(row);
  return {
    title: `Delete “${row.name}”?`,
    body: `The ${meta.noun} and everything filed in it goes. Cards you own stay in your collection. This can’t be undone.`,
    confirmLabel: `Delete ${meta.noun}`,
    danger: true,
  };
}

/** A row's kind, defaulting rows written before storage existed to 'deck'. */
export function containerKind(row: Pick<Deck, 'kind'> | undefined | null): ContainerKind {
  return row?.kind ?? 'deck';
}

export function containerMeta(row: Pick<Deck, 'kind'> | undefined | null): ContainerMeta {
  return CONTAINER_META[containerKind(row)];
}

/**
 * The wording for an add or scan target: a container target names its kind
 * (default deck); any other target reads as a deck, which is what the copy
 * assumes when it isn't about a container at all.
 */
export function containerMetaFor(target: { kind: string; containerKind?: ContainerKind }): ContainerMeta {
  return CONTAINER_META[(target.kind === 'deck' && target.containerKind) || 'deck'];
}


