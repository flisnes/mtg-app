import { KW_HASTE, type SimCard } from './simDeck.js';

// The permanents you control, one slot each (rebuild plan F0/F2).
//
// This used to be three parallel arrays inside the simulate() closure, card,
// arrival turn and expiry, and nothing else: a permanent was an index into the
// deck plus two turns. Everything a card *became* on the battlefield had
// nowhere to live. No current power, so no anthem and no +1/+1 counter. No
// tapped state, so a Llanowar Elves could tap for green and then attack. No
// type of its own, so an Ashaya could not make a creature a land.
//
// So it is its own module now, still typed arrays and still allocation-free in
// the game loop: one slot per permanent, swap-removed, every array moved
// together. The simulator owns *when* things change; this owns what a
// permanent is and keeps the derived fields (power, types, keywords) in step
// with their parts.

export class Permanents {
  /** Slots in use. Everything past it is garbage. */
  len = 0;
  /** The card it is, as an index into `SimDeck.cards`. Two copies are two slots with one number. */
  readonly card: Int32Array;
  /** The turn it arrived, so summoning sickness is `since === turn`. */
  readonly since: Int32Array;
  /** Last turn it is still around, or 0 for "it does not go away". */
  readonly until: Int32Array;
  /**
   * An id unique within one game. Slots move when something is swap-removed,
   * and a mana source has to be able to find the permanent it is a view of
   * after that has happened.
   */
  readonly oid: Int32Array;
  /** Current power and toughness: printed, plus counters, plus static and until-end-of-turn pumps. */
  readonly power: Int32Array;
  readonly toughness: Int32Array;
  /** +1/+1 counters and every other counter, which only ever gets counted. */
  readonly p1p1: Int32Array;
  readonly charge: Int32Array;
  /** Pumps from static rules, recomputed whenever the battlefield changes. */
  readonly staticPump: Int32Array;
  /** Pumps until end of turn: a Craterhoof's +X/+X. */
  readonly eotPump: Int32Array;
  /** Tapped this turn, for mana. Untapped at the start of every turn. */
  readonly tapped: Uint8Array;
  /** Current card types, T_ bits. The printed ones plus whatever a static rule added. */
  readonly types: Uint8Array;
  /** Which of `SimDeck.typeGrants` it has, which is also the filter row it matches on. */
  readonly added: Uint8Array;
  /** Colors of the basic land types it was given, WUBRGC bits: a Forest taps for {G}. */
  readonly sub: Uint8Array;
  /** Current keywords: printed, granted by a static, granted to this object, granted until end of turn. */
  readonly kw: Uint8Array;
  /** Granted to this object for as long as it stays: a suspended creature's haste. */
  readonly kwOwn: Uint8Array;
  readonly kwStatic: Uint8Array;
  readonly kwEot: Uint8Array;
  /** Extra mana it makes when tapped for mana, from a static rule (Badgermole Cub), and its colors. */
  readonly extra: Int32Array;
  readonly extraMask: Uint8Array;
  /** The card whose static rule that extra mana is, for the mana credit. */
  readonly extraBy: Int32Array;
  private nextOid = 1;

  constructor(readonly capacity: number) {
    this.card = new Int32Array(capacity);
    this.since = new Int32Array(capacity);
    this.until = new Int32Array(capacity);
    this.oid = new Int32Array(capacity);
    this.power = new Int32Array(capacity);
    this.toughness = new Int32Array(capacity);
    this.p1p1 = new Int32Array(capacity);
    this.charge = new Int32Array(capacity);
    this.staticPump = new Int32Array(capacity);
    this.eotPump = new Int32Array(capacity);
    this.tapped = new Uint8Array(capacity);
    this.types = new Uint8Array(capacity);
    this.added = new Uint8Array(capacity);
    this.sub = new Uint8Array(capacity);
    this.kw = new Uint8Array(capacity);
    this.kwOwn = new Uint8Array(capacity);
    this.kwStatic = new Uint8Array(capacity);
    this.kwEot = new Uint8Array(capacity);
    this.extra = new Int32Array(capacity);
    this.extraMask = new Uint8Array(capacity);
    this.extraBy = new Int32Array(capacity);
  }

  /** A new game. */
  reset(): void {
    this.len = 0;
    this.nextOid = 1;
  }

  /**
   * File a card on the battlefield and return its slot, or -1 when there is no
   * room. Idempotent is exactly what this must *not* be: two Islands are two
   * slots carrying the same card index.
   */
  add(index: number, card: SimCard, turn: number): number {
    if (this.len >= this.capacity) return -1;
    const p = this.len++;
    this.card[p] = index;
    this.since[p] = turn;
    this.until[p] = card.life > 0 ? turn + card.life - 1 : 0;
    this.oid[p] = this.nextOid++;
    this.p1p1[p] = 0;
    this.charge[p] = 0;
    this.staticPump[p] = 0;
    this.eotPump[p] = 0;
    this.tapped[p] = 0;
    this.types[p] = card.types;
    this.added[p] = 0;
    this.sub[p] = 0;
    this.kwOwn[p] = 0;
    this.kwStatic[p] = 0;
    this.kwEot[p] = 0;
    this.extra[p] = 0;
    this.extraMask[p] = 0;
    this.extraBy[p] = -1;
    this.refresh(p, card);
    return p;
  }

  /** Swap-remove a slot. Every array moves together or not at all. */
  drop(at: number): void {
    const last = --this.len;
    if (at === last) return;
    this.card[at] = this.card[last]!;
    this.since[at] = this.since[last]!;
    this.until[at] = this.until[last]!;
    this.oid[at] = this.oid[last]!;
    this.power[at] = this.power[last]!;
    this.toughness[at] = this.toughness[last]!;
    this.p1p1[at] = this.p1p1[last]!;
    this.charge[at] = this.charge[last]!;
    this.staticPump[at] = this.staticPump[last]!;
    this.eotPump[at] = this.eotPump[last]!;
    this.tapped[at] = this.tapped[last]!;
    this.types[at] = this.types[last]!;
    this.added[at] = this.added[last]!;
    this.sub[at] = this.sub[last]!;
    this.kw[at] = this.kw[last]!;
    this.kwOwn[at] = this.kwOwn[last]!;
    this.kwStatic[at] = this.kwStatic[last]!;
    this.kwEot[at] = this.kwEot[last]!;
    this.extra[at] = this.extra[last]!;
    this.extraMask[at] = this.extraMask[last]!;
    this.extraBy[at] = this.extraBy[last]!;
  }

  /** The first slot holding this card, or -1. */
  find(index: number): number {
    for (let p = 0; p < this.len; p++) if (this.card[p] === index) return p;
    return -1;
  }

  /** The most recent arrival of this card, or -1: the copy an entry rule is talking about. */
  newest(index: number): number {
    let best = -1;
    for (let p = 0; p < this.len; p++) {
      if (this.card[p] === index && (best < 0 || this.oid[p]! > this.oid[best]!)) best = p;
    }
    return best;
  }

  /** The slot with this object id, or -1 once it has left. */
  slotOf(oid: number): number {
    for (let p = 0; p < this.len; p++) if (this.oid[p] === oid) return p;
    return -1;
  }

  /** Still around this turn: a Lotus Petal's slot outlives the Petal. */
  stillOut(p: number, turn: number): boolean {
    const until = this.until[p]!;
    return until === 0 || turn <= until;
  }

  /** It can attack, or tap for mana if it is a creature: here since before this turn, or hasty. */
  ready(p: number, turn: number): boolean {
    return this.since[p]! < turn || (this.kw[p]! & KW_HASTE) !== 0;
  }

  /** Power, toughness and keywords from their parts. Called whenever a part changes. */
  refresh(p: number, card: SimCard): void {
    const bonus = this.p1p1[p]! + this.staticPump[p]! + this.eotPump[p]!;
    this.power[p] = Math.max(0, card.power + bonus);
    this.toughness[p] = card.toughness + bonus;
    this.kw[p] = card.keywords | this.kwOwn[p]! | this.kwStatic[p]! | this.kwEot[p]!;
  }

  /** End of turn: every until-end-of-turn pump and keyword wears off. */
  clearEot(cards: readonly SimCard[]): void {
    for (let p = 0; p < this.len; p++) {
      if (this.eotPump[p] === 0 && this.kwEot[p] === 0) continue;
      this.eotPump[p] = 0;
      this.kwEot[p] = 0;
      this.refresh(p, cards[this.card[p]!]!);
    }
  }

  /** Untap step. */
  untapAll(): void {
    this.tapped.fill(0, 0, this.len);
  }
}
