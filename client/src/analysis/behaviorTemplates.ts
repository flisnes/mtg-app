import type { BehaviorRule, BehaviorStep, CardBehavior } from '@mtg/shared';

// Rebuild plan C5: rules nobody has to write from a blank page.
//
// Two kinds, and they answer different questions.
//
// *Pre-written* rules are for one named card. Somebody read Craterhoof and
// wrote it down, so the editor can offer the finished rule. They are written
// in the grammar phase F grew (statics, tokens, tap rules, cast options), which
// is why they waited for it: Ashaya and Chalice cannot be said without it.
//
// *Starting points* are for every other card. Scryfall's tags know a card has
// landfall, or draws off an upkeep, or makes tokens, without knowing how much.
// A starting point is the right trigger with a placeholder number, one tap
// from a rule that fires. The user reads the card and fixes the number.
//
// Neither is applied on its own. §11.4's floor holds only while every number
// above the database's reading is one the user chose, so a pre-written rule is
// an offer like a rule from another deck (C4): Use this, Save, and the toast
// says what it moved. Both are written to err low where a card has a clause
// the grammar cannot say ("once each turn", "you may pay {1}").

const rule = (on: BehaviorRule['on'], steps: BehaviorStep[], q?: string): BehaviorRule => (q ? { on, q, steps } : { on, steps });
const n = (k: number) => ({ kind: 'fixed' as const, n: k });
const draw = (k = 1): BehaviorStep => ({ op: 'draw', x: n(k) });
const token = (tp: number, tt: number, k: BehaviorStep['x'] = n(1)): BehaviorStep => ({ op: 'token', x: k, tk: 'custom', ty: 'C', tp, tt });
/** A token card out of the database, by oracle id. template-check.ts checks the id names that token. */
const cardToken = (tid: string, tn: string, k: BehaviorStep['x'] = n(1)): BehaviorStep => ({ op: 'token', x: k, tk: 'card', tid, tn });
const behavior = (...rules: BehaviorRule[]): CardBehavior => ({ v: 1, rules });

const LAND = 't:land';
const NONTOKEN_CREATURE = 't:creature -t:token';
const INSTANT_SORCERY = 't:instant or t:sorcery';

/**
 * Pre-written rules, by card name. Only cards the database reads as nothing
 * (or as less than the card does, like Chalice's fixed {C}), and only what the
 * grammar can say without lying upward. A card whose database reading a rule
 * would replace and not restate (Aesi's extra land drop, Lotus Cobra read as a
 * dork) is left out: the rule would take away something true.
 *
 * `notes/checks/template-check.ts` sanitizes and compiles every entry and
 * checks each name against the full card DB, so a typo here fails there.
 */
export const PREWRITTEN: Readonly<Record<string, CardBehavior>> = {
  // Statics and grants (phase F6).
  'Ashaya, Soul of the Wild': behavior(rule('static', [{ op: 'addtype', x: n(1), ty: 'L', sub: 'G' }], NONTOKEN_CREATURE)),
  'Badgermole Cub': behavior(rule('static', [{ op: 'extramana', x: n(1), colors: 'G' }], 't:creature')),
  'Ramunap Excavator': behavior(rule('static', [{ op: 'landfrom', x: n(1), from: 'graveyard' }])),
  'Courser of Kruphix': behavior(rule('static', [{ op: 'landfrom', x: n(1), from: 'librarytop' }])),
  'Reliquary Tower': behavior(rule('static', [{ op: 'nomaxhand', x: n(1) }])),
  // "During your turn" is every turn a goldfish has. The attack's land pick is
  // left out: milling three and keeping none is the floor.
  Six: behavior(
    rule('static', [{ op: 'grantcast', x: n(1), from: 'graveyard', gk: 'retrace', q: 'is:permanent -t:land' }]),
    rule('attack', [{ op: 'mill', x: n(3) }]),
  ),
  'Mole Man, Moloid Master': behavior(
    rule('static', [{ op: 'landfrom', x: n(1), from: 'graveyard' }]),
    rule('enters', [cardToken('26457778-9e7e-4de8-b5a9-78990b1fca13', 'Moloid')], LAND),
  ),
  // Impending is left out: cast for five, it is a creature from the start.
  'Overlord of the Hauntwoods': behavior(
    rule('etb', [cardToken('77872673-2806-41ee-bc4c-57fbc488a40f', 'Everywhere')]),
    rule('attack', [cardToken('77872673-2806-41ee-bc4c-57fbc488a40f', 'Everywhere')]),
  ),
  'Glorious Anthem': behavior(rule('static', [{ op: 'pump', x: n(1) }], 't:creature')),
  "Mirari's Wake": behavior(rule('static', [{ op: 'pump', x: n(1) }], 't:creature'), rule('static', [{ op: 'extramana', x: n(1) }], LAND)),
  'Zendikar Resurgent': behavior(rule('static', [{ op: 'extramana', x: n(1) }], LAND), rule('cast', [draw()], 't:creature')),
  'Fires of Yavimaya': behavior(rule('static', [{ op: 'keyword', x: n(1), kw: 'H' }], 't:creature')),
  'Concordant Crossroads': behavior(rule('static', [{ op: 'keyword', x: n(1), kw: 'H' }], 't:creature')),
  // Riot: haste or a counter, and haste is the one this model acts on.
  'Rhythm of the Wild': behavior(rule('static', [{ op: 'keyword', x: n(1), kw: 'H' }], NONTOKEN_CREATURE)),
  // Combat and tokens (F2, F3).
  'Craterhoof Behemoth': behavior(rule('etb', [{ op: 'pump', x: { kind: 'creatures' } }])),
  'Rampaging Baloths': behavior(rule('enters', [{ op: 'token', x: n(1), tk: 'beast' }], LAND)),
  'Omnath, Locus of Rage': behavior(rule('enters', [token(5, 5)], LAND)),
  // The copy clause at six lands is left out: a floor, not a Swarm.
  'Scute Swarm': behavior(rule('enters', [token(1, 1)], LAND)),
  'Avenger of Zendikar': behavior(rule('etb', [token(0, 1, { kind: 'lands' })])),
  'Grave Titan': behavior(rule('etb', [{ op: 'token', x: n(2), tk: 'zombie' }]), rule('attack', [{ op: 'token', x: n(2), tk: 'zombie' }])),
  'Tireless Provisioner': behavior(rule('enters', [{ op: 'token', x: n(1), tk: 'treasure' }], LAND)),
  Bitterblossom: behavior(rule('upkeep', [token(1, 1)])),
  // "Each upkeep" is every player's; a goldfish only has yours.
  'Tendershoot Dryad': behavior(rule('upkeep', [token(1, 1)])),
  'Talrand, Sky Summoner': behavior(rule('cast', [token(2, 2)], INSTANT_SORCERY)),
  'Young Pyromancer': behavior(rule('cast', [token(1, 1)], INSTANT_SORCERY)),
  'Monastery Mentor': behavior(rule('cast', [token(1, 1)], '-t:creature')),
  'Impact Tremors': behavior(rule('enters', [{ op: 'damage', x: n(1) }], 't:creature')),
  'Purphoros, God of the Forge': behavior(rule('enters', [{ op: 'damage', x: n(2) }], 't:creature')),
  // Mana (F4, F5).
  'Everflowing Chalice': {
    v: 1,
    rules: [rule('etb', [{ op: 'counter', x: { kind: 'kicked' }, ck: 'charge' }]), rule('tap', [{ op: 'tapsfor', x: { kind: 'counters' }, colors: 'C' }])],
    cast: [{ kind: 'multikicker', cost: '{2}' }],
  },
  'Primeval Titan': behavior(
    rule('etb', [{ op: 'move', x: n(2), from: 'library', to: 'battlefield', q: LAND }]),
    rule('attack', [{ op: 'move', x: n(2), from: 'library', to: 'battlefield', q: LAND }]),
  ),
  'Solemn Simulacrum': behavior(rule('etb', [{ op: 'move', x: n(1), from: 'library', to: 'battlefield', q: 't:basic' }]), rule('death', [draw()])),
  // Card flow.
  'Beast Whisperer': behavior(rule('cast', [draw()], 't:creature')),
  'Archmage Emeritus': behavior(rule('cast', [draw()], INSTANT_SORCERY)),
  "Enchantress's Presence": behavior(rule('cast', [draw()], 't:enchantment')),
  'Argothian Enchantress': behavior(rule('cast', [draw()], 't:enchantment')),
  'Mesa Enchantress': behavior(rule('cast', [draw()], 't:enchantment')),
  "Sythis, Harvest's Hand": behavior(rule('cast', [draw()], 't:enchantment')),
  // The name clause is left out; in a singleton deck it rarely bites.
  'Guardian Project': behavior(rule('enters', [draw()], NONTOKEN_CREATURE)),
  'Soul of the Harvest': behavior(rule('enters', [draw()], NONTOKEN_CREATURE)),
  // The +1/+1 counter and the cost reduction are left out.
  'The Great Henge': behavior(rule('enters', [draw()], NONTOKEN_CREATURE)),
  'Elemental Bond': behavior(rule('enters', [draw()], 't:creature pow>=3')),
  "Garruk's Packleader": behavior(rule('enters', [draw()], 't:creature pow>=3')),
  "Garruk's Uprising": behavior(rule('enters', [draw()], 't:creature pow>=4')),
  'Tatyova, Benthic Druid': behavior(rule('enters', [draw()], LAND)),
  'Up the Beanstalk': behavior(rule('etb', [draw()]), rule('cast', [draw()], 'mv>=5')),
  'Dark Confidant': behavior(rule('upkeep', [draw()])),
  // Nobody blocks in a goldfish, and Toski attacks each combat if able.
  'Toski, Bearer of Secrets': behavior(rule('attack', [draw()])),
  'Eternal Witness': behavior(rule('etb', [{ op: 'move', x: n(1), from: 'graveyard', to: 'hand' }])),
  "Rishkar's Expertise": behavior(rule('play', [{ op: 'draw', x: { kind: 'power' } }])),
  'Return of the Wildspeaker': behavior(rule('play', [{ op: 'draw', x: { kind: 'power' } }])),
};

/** The pre-written rule for a card, or null. */
export function prewritten(name: string): CardBehavior | null {
  return PREWRITTEN[name] ?? null;
}

// ---------------------------------------------------------------------------
// Starting points
// ---------------------------------------------------------------------------

export interface Template {
  id: string;
  /** What it is, for the offer's first line. */
  label: string;
  /**
   * Tag slugs, as groups: the card needs a tag (or a descendant) from every
   * group. `[['landfall'], ['draw']]` is landfall and a draw card.
   */
  tags: readonly (readonly string[])[];
  /** What the card has to be. Absent is anything. */
  needs?: 'permanent' | 'creature' | 'spell';
  /** A catch-all: offered only when nothing more specific fits. */
  fallback?: true;
  behavior: CardBehavior;
}

/**
 * First match wins a slot; at most MAX_TEMPLATES are shown. Ordered from the
 * most specific (a trigger and an effect) to the catch-alls, so a landfall draw
 * engine is offered "Landfall: draw a card" before "Each upkeep: draw a card".
 */
export const TEMPLATES: readonly Template[] = [
  { id: 'landfall-draw', label: 'Landfall: draw a card', tags: [['landfall'], ['draw']], needs: 'permanent', behavior: behavior(rule('enters', [draw()], LAND)) },
  { id: 'landfall-token', label: 'Landfall: create a token', tags: [['landfall'], ['repeatable-token-generator']], needs: 'permanent', behavior: behavior(rule('enters', [token(1, 1)], LAND)) },
  { id: 'landfall-treasure', label: 'Landfall: create a Treasure', tags: [['landfall'], ['repeatable-treasures']], needs: 'permanent', behavior: behavior(rule('enters', [{ op: 'treasure', x: n(1) }], LAND)) },
  { id: 'landfall-mana', label: 'Landfall: add one mana', tags: [['landfall'], ['ramp']], needs: 'permanent', behavior: behavior(rule('enters', [{ op: 'mana', x: n(1) }], LAND)) },
  { id: 'cast-draw', label: 'Casting an instant or sorcery draws', tags: [['cast-trigger-you'], ['draw']], needs: 'permanent', behavior: behavior(rule('cast', [draw()], INSTANT_SORCERY)) },
  { id: 'cast-creature-draw', label: 'Casting a creature draws', tags: [['cast-trigger-you'], ['draw']], needs: 'permanent', behavior: behavior(rule('cast', [draw()], 't:creature')) },
  { id: 'cast-token', label: 'Casting an instant or sorcery makes a token', tags: [['cast-trigger-you'], ['repeatable-token-generator']], needs: 'permanent', behavior: behavior(rule('cast', [token(1, 1)], INSTANT_SORCERY)) },
  { id: 'attack-draw', label: 'Attacking draws a card', tags: [['attack-trigger', 'attacking-matters'], ['draw']], needs: 'creature', behavior: behavior(rule('attack', [draw()])) },
  { id: 'attack-token', label: 'Attacking makes a token', tags: [['attack-trigger', 'attacking-matters'], ['repeatable-token-generator']], needs: 'creature', behavior: behavior(rule('attack', [token(1, 1)])) },
  { id: 'death-draw', label: 'Dying draws a card', tags: [['death-trigger-self'], ['draw']], needs: 'permanent', behavior: behavior(rule('death', [draw()])) },
  { id: 'upkeep-draw', label: 'Each upkeep: draw a card', tags: [['repeatable-draw', 'draw-engine']], needs: 'permanent', behavior: behavior(rule('upkeep', [draw()])) },
  { id: 'upkeep-token', label: 'Each upkeep: create a token', tags: [['repeatable-token-generator']], needs: 'permanent', behavior: behavior(rule('upkeep', [token(1, 1)])) },
  { id: 'upkeep-treasure', label: 'Each upkeep: create a Treasure', tags: [['repeatable-treasures']], needs: 'permanent', behavior: behavior(rule('upkeep', [{ op: 'treasure', x: n(1) }])) },
  { id: 'anthem', label: 'Your creatures get +1/+1', tags: [['anthem']], needs: 'permanent', behavior: behavior(rule('static', [{ op: 'pump', x: n(1) }], 't:creature')) },
  { id: 'haste', label: 'Your creatures have haste', tags: [['gives-haste']], needs: 'permanent', behavior: behavior(rule('static', [{ op: 'keyword', x: n(1), kw: 'H' }], 't:creature')) },
  { id: 'hand-size', label: 'No maximum hand size', tags: [['hand-size-increase']], needs: 'permanent', behavior: behavior(rule('static', [{ op: 'nomaxhand', x: n(1) }])) },
  { id: 'taps-for', label: 'Taps for one mana', tags: [['mana-dork', 'mana-rock']], needs: 'permanent', behavior: behavior(rule('tap', [{ op: 'tapsfor', x: n(1) }])) },
  { id: 'etb-ramp', label: 'Entering fetches a basic land', tags: [['land-ramp']], needs: 'permanent', behavior: behavior(rule('etb', [{ op: 'move', x: n(1), from: 'library', to: 'battlefield', q: 't:basic' }])) },
  { id: 'play-ramp', label: 'Fetches a basic land', tags: [['land-ramp']], needs: 'spell', behavior: behavior(rule('play', [{ op: 'move', x: n(1), from: 'library', to: 'battlefield', q: 't:basic' }])) },
  { id: 'tutor', label: 'Tutors a card to hand', tags: [['tutor']], behavior: behavior(rule('play', [{ op: 'move', x: n(1), from: 'library', to: 'hand' }])) },
  { id: 'recursion', label: 'Returns a card from your graveyard', tags: [['recursion']], behavior: behavior(rule('play', [{ op: 'move', x: n(1), from: 'graveyard', to: 'hand' }])) },
  { id: 'impulse', label: 'Exile the top card and play it (as a draw)', tags: [['impulsive-draw']], fallback: true, behavior: behavior(rule('play', [draw()])) },
  { id: 'etb-draw', label: 'Entering draws a card', tags: [['card-advantage', 'draw']], needs: 'permanent', fallback: true, behavior: behavior(rule('etb', [draw()])) },
  { id: 'play-draw', label: 'Draws a card', tags: [['draw']], needs: 'spell', fallback: true, behavior: behavior(rule('play', [draw()])) },
];

export const MAX_TEMPLATES = 3;

/** What the templates need to know about a card. */
export interface TemplateCard {
  tags: readonly number[];
  permanent: boolean;
  creature: boolean;
}

/**
 * The starting points that fit this card, most specific first, or an empty
 * list when the tag vocabulary is not loaded (nothing to ask) or none fit.
 * `closure` is oracleTagClosure, passed in so this module stays loadable
 * outside the app (the check rig imports it under plain node).
 */
export function templatesFor(card: TemplateCard, closure: (slug: string) => ReadonlySet<number> | null): Template[] {
  if (card.tags.length === 0) return [];
  const has = (slug: string) => {
    const set = closure(slug);
    return !!set && card.tags.some((t) => set.has(t));
  };
  const out: Template[] = [];
  for (const t of TEMPLATES) {
    if (t.needs === 'permanent' && !card.permanent) continue;
    if (t.needs === 'creature' && !card.creature) continue;
    if (t.needs === 'spell' && card.permanent) continue;
    if (t.fallback && out.length > 0) continue;
    if (!t.tags.every((group) => group.some(has))) continue;
    out.push(t);
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}
