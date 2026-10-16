import { describe, expect, it } from 'vitest';
import type { CollectionEntry, OracleCard, Printing } from '@mtg/shared';
import { commandZoneDeckId, modeFlags, type ModeInput } from '../src/components/cardSheet/modeFlags.js';
import { clampFinish, formFrom, initialForm } from '../src/components/cardSheet/useCardForm.js';
import { ANY_PRINTING } from '../src/components/cardSheet/types.js';

const card = (name: string, extra: Partial<OracleCard> = {}): OracleCard =>
  ({
    oracleId: name,
    name,
    typeLine: 'Creature — Human',
    oracleText: '',
    colorIdentity: ['W'],
    cmc: 1,
    legalities: { commander: 'legal' },
    defaultScryfallId: `${name}-default`,
    ...extra,
  }) as unknown as OracleCard;

const bear = card('Grizzly Bears');
const lurrus = card('Lurrus of the Dream-Den', {
  typeLine: 'Legendary Creature — Cat Nightmare',
  oracleText: 'Companion — Each permanent card in your starting deck has mana value 2 or less.\nLifelink',
  cmc: 3,
});
const plains = card('Plains', { typeLine: 'Basic Land — Plains', cmc: 0 });

const input = (over: Partial<ModeInput>): ModeInput => ({
  propsMode: 'info',
  addFlow: null,
  editMode: false,
  hasWishView: false,
  ...over,
});

describe('modeFlags', () => {
  it('an owned copy is a form only once Edit is on', () => {
    expect(modeFlags(input({ propsMode: 'edit' }), bear, []).formEditable).toBe(false);
    expect(modeFlags(input({ propsMode: 'edit', editMode: true }), bear, []).formEditable).toBe(true);
  });

  it('stepping into an add from a deck slot is an add to that list', () => {
    const f = modeFlags(
      input({ propsMode: 'deck', addFlow: 'collection', deckCard: { id: 's', quantity: 1, board: 'main' } }),
      bear,
      [],
    );
    expect(f.mode).toBe('add');
    expect(f.addTo).toEqual({ kind: 'collection' });
    expect(f.listAddKind).toBe('collection');
    expect(f.deckPrefs).toBe(false);
    expect(f.collectionFields).toBe(true);
  });

  it('a wish being viewed is read-only and Any-able', () => {
    const f = modeFlags(input({ hasWishView: true }), bear, []);
    expect(f.wishInfo).toBe(true);
    expect(f.anyPrefs).toBe(true);
    expect(f.editionPickable).toBe(false);
  });

  it('a session line shows only the traits its scan tracks', () => {
    const f = modeFlags(
      input({ propsMode: 'session', sessionCard: { scryfallId: 'x', quantity: 1, finish: 'foil' } }),
      bear,
      [],
    );
    expect([f.showCondition, f.showFinish, f.showLang]).toEqual([false, true, false]);
    expect(f.canOpenInCollection).toBe(false);
  });

  it('a basic added into a deck defaults to any printing; into a binder it is offered, not defaulted', () => {
    const deck = modeFlags(input({ propsMode: 'add', addTarget: { kind: 'deck', deckId: 'd' } }), plains, []);
    expect([deck.basicAny, deck.basicAnyDefault, deck.deckAddIsDeck]).toEqual([true, true, true]);
    const binder = modeFlags(
      input({ propsMode: 'add', addTarget: { kind: 'deck', deckId: 'b', containerKind: 'binder' } }),
      plains,
      [],
    );
    expect([binder.basicAny, binder.basicAnyDefault, binder.deckAddIsDeck]).toEqual([true, false, false]);
  });

  it('a companion slot in a Commander deck can be seated; a binder slot has no zones', () => {
    const slot = { id: 's', quantity: 1, board: 'main' as const, deckId: 'd', commanderDeck: true };
    expect(modeFlags(input({ propsMode: 'deck', deckCard: slot }), lurrus, []).canSetCompanion).toBe(true);
    expect(modeFlags(input({ propsMode: 'deck', deckCard: { ...slot, containerKind: 'binder' } }), lurrus, []).zones).toEqual([]);
  });

  it('reads the command zone of the slot deck or the Commander deck being added to', () => {
    expect(commandZoneDeckId(input({ propsMode: 'deck', deckCard: { id: 's', quantity: 1, deckId: 'd', commanderDeck: true } }))).toBe('d');
    expect(commandZoneDeckId(input({ propsMode: 'add', addTarget: { kind: 'deck', deckId: 'c', format: 'commander' } }))).toBe('c');
    expect(commandZoneDeckId(input({ propsMode: 'add', addTarget: { kind: 'deck', deckId: 'm', format: 'modern' } }))).toBeUndefined();
  });
});

describe('the form', () => {
  const entry = {
    id: 'e',
    oracleId: 'o',
    scryfallId: 'p1',
    condition: 'LP',
    finish: 'foil',
    lang: 'de',
    quantity: 3,
    quantityForTrade: 1,
    special: ['signed'],
  } as unknown as CollectionEntry;

  it('opens on an owned copy as stored', () => {
    const f = modeFlags(input({ propsMode: 'edit' }), bear, []);
    expect(initialForm(f, { entry, defaultScryfallId: 'd' })).toMatchObject({
      scryfallId: 'p1',
      condition: 'LP',
      finish: 'foil',
      lang: 'de',
      quantity: 3,
      forTrade: 1,
      special: ['signed'],
    });
  });

  it('a slot that pins nothing is any printing, any traits', () => {
    expect(formFrom({ id: 's', quantity: 2, board: 'side' })).toMatchObject({
      scryfallId: ANY_PRINTING,
      condition: '',
      finish: '',
      lang: '',
      quantity: 2,
      zone: 'side',
    });
  });

  it('a wishlist add starts on any printing; a tradelist add on one copy for trade', () => {
    const wish = modeFlags(input({ propsMode: 'add', addTarget: { kind: 'wishlist' } }), bear, []);
    expect(initialForm(wish, { recordedId: 'p1', defaultScryfallId: 'd' })).toMatchObject({ scryfallId: ANY_PRINTING, condition: '' });
    const trade = modeFlags(input({ propsMode: 'add', addTarget: { kind: 'tradelist' } }), bear, []);
    expect(initialForm(trade, { defaultScryfallId: 'd' })).toMatchObject({ scryfallId: 'd', condition: 'NM', forTrade: 1 });
  });

  it('clamps a concrete finish to the printing, never a wish or "Any"', () => {
    const nonfoilOnly = { finishes: ['nonfoil'] } as unknown as Printing;
    expect(clampFinish('foil', nonfoilOnly, false)).toBe('nonfoil');
    expect(clampFinish('foil', nonfoilOnly, true)).toBe('foil');
    expect(clampFinish('', nonfoilOnly, false)).toBe('');
    expect(clampFinish('foil', undefined, false)).toBe('foil');
  });
});
