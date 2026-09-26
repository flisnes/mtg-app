import { useEffect, useState } from 'react';
import { sanitizeCardBehavior, type CardBehavior } from '@mtg/shared';
import { PREWRITTEN } from './behaviorTemplates.js';

// Default behaviors: what the simulator plays for a card nobody in this deck
// has written a rule for, when somebody read the card by hand and wrote one.
//
// Two sources. `edhDefaults.json` is the review of the most-played Commander
// cards (notes/edh-top/), built by notes/edh-top/build-defaults.ts; PREWRITTEN
// is C5's hand-picked set. The review wins for any card it covers, including
// when it decided a card should have no rule at all.
//
// Loaded lazily with the analysis page, so nobody downloads it to search.
//
// A default is used without the user choosing it, which §11.4 only allows for
// rules that err low. That is the review's first rule, and the coverage line
// still counts these copies (SimCoverage.defaults), because a floor written by
// somebody else is still a reading above the database's.

export interface ShippedDefaults {
  /** By card name. */
  behaviors: ReadonlyMap<string, CardBehavior>;
  /**
   * Reviewed cards with no rule, by name: the gaps they wait on (ids from
   * notes/edh-top/vocabulary.ts), or an empty list for right as nothing.
   */
  idle: ReadonlyMap<string, readonly string[]>;
}

const fromPrewritten = (): Map<string, CardBehavior> => new Map(Object.entries(PREWRITTEN));

/** Before the file lands, and if it never does: C5's set on its own. */
export const PREWRITTEN_ONLY: ShippedDefaults = { behaviors: fromPrewritten(), idle: new Map() };

let pending: Promise<ShippedDefaults> | null = null;

export function loadDefaults(): Promise<ShippedDefaults> {
  pending ??= import('./edhDefaults.json')
    .then((m) => {
      const file = m.default as { behaviors: Record<string, unknown>; idle: Record<string, string[]> };
      const behaviors = fromPrewritten();
      const idle = new Map<string, readonly string[]>();
      for (const [name, gaps] of Object.entries(file.idle)) {
        behaviors.delete(name);
        idle.set(name, gaps);
      }
      // Through the sanitizer like a synced row, so a file built against a
      // newer grammar plays out as less on an old build rather than breaking it.
      for (const [name, raw] of Object.entries(file.behaviors)) {
        const b = sanitizeCardBehavior(raw);
        if (b) behaviors.set(name, b);
      }
      return { behaviors, idle };
    })
    .catch(() => PREWRITTEN_ONLY);
  return pending;
}

export function useDefaults(): ShippedDefaults {
  const [defaults, setDefaults] = useState<ShippedDefaults>(PREWRITTEN_ONLY);
  useEffect(() => {
    let live = true;
    void loadDefaults().then((d) => live && setDefaults(d));
    return () => {
      live = false;
    };
  }, []);
  return defaults;
}

/**
 * The behaviors the simulator plays for this deck: the user's where they wrote
 * one, else the shipped default. `defaulted` names the second kind so the
 * coverage line can count them apart.
 */
export function effectiveBehaviors(
  cards: Iterable<{ oracleId: string; name: string }>,
  user: ReadonlyMap<string, CardBehavior> | undefined,
  defaults: ShippedDefaults,
): { behaviors: Map<string, CardBehavior>; defaulted: Set<string> } {
  const behaviors = new Map(user ?? []);
  const defaulted = new Set<string>();
  for (const c of cards) {
    if (behaviors.has(c.oracleId)) continue;
    const b = defaults.behaviors.get(c.name);
    if (!b) continue;
    behaviors.set(c.oracleId, b);
    defaulted.add(c.oracleId);
  }
  return { behaviors, defaulted };
}

/** What a reviewed card waits on, in a few words each. Mirrors notes/edh-top/vocabulary.ts. */
export const GAP_WORDS: Readonly<Record<string, string>> = {
  activated: 'activated abilities',
  'sac-outlet': 'sacrifice as a cost',
  'dies-trigger': 'triggers on creatures dying',
  'end-step': 'end step triggers',
  'draw-trigger': 'triggers on draws and other events',
  condition: 'conditions',
  choice: 'picking the best card',
  opponents: 'opponents acting',
  'cost-reduction': 'cost reduction',
  untap: 'untapping',
  'mana-multiply': 'mana doubling',
  'trigger-double': 'trigger doubling',
  'token-double': 'token and counter doubling',
  copy: 'copying',
  'play-from-zone': 'playing cards from the library or exile',
  'zone-cast-static': 'casting from the graveyard',
  life: 'life as a resource',
  modal: 'choosing a mode',
  loyalty: 'loyalty abilities',
  attach: 'equipment and auras',
  'extra-turn': 'extra turns',
  'extra-combat': 'extra combats',
  wincon: 'winning outright',
  'counters-matter': 'other counters',
  'command-zone': 'abilities from the command zone',
  'any-attack': 'other creatures attacking',
  'combat-damage': 'combat damage dealt',
  targeted: 'targeting one creature',
  'zone-ability': 'abilities from hand or graveyard',
  'zone-watch': 'cards leaving the graveyard',
  'spell-count': 'counting spells this turn',
  chosen: 'a chosen type or color',
  'damage-multiply': 'damage doubling',
  transform: 'transforming',
  resource: 'energy, the Ring and other resources',
  'not-self': '"other than this card"',
  'counters-others': 'counters on other creatures',
  'grant-ability': 'granting abilities',
  'trigger-amount': 'reading the triggering card',
  other: 'something not modelled yet',
};

/** "opponents acting and conditions". */
export function gapWords(gaps: readonly string[]): string {
  const words = [...new Set(gaps.map((g) => GAP_WORDS[g] ?? GAP_WORDS.other!))];
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
