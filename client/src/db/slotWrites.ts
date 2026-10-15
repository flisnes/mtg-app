import { normalizeCardTags, prefsCompatible, sameCardTags } from '@mtg/shared';
import type { CollectionEntry, Color, CopyPrefs, Deck, DeckBoard, DeckCard, EventSource, UserEvent } from '@mtg/shared';
import { db } from './schema.js';
import { markOwnedForTrade, ownedByOracle } from './collectionWrites.js';
import type { MarkForTradeRequest } from './collectionWrites.js';
import { batchFields, groupByOracle, slotEvent } from './events.js';
import type { EventExtra } from './events.js';
import { exactSlotKey, namedCopy, newId, push, slotKey } from './keys.js';
import type { SlotWants } from './keys.js';
import { adjustRow, DECK_TABLES, deleteSynced, deleteSyncedMany, patchSynced, putSynced, putSyncedMany, write } from './write.js';
import type { BatchMeta, WriteCtx } from './write.js';

/**
 * How little a slot says about the copy filling it: 2 = no printing, no traits
 * (a pasted decklist line), 1 = a printing only, 0 = a named physical copy. The
 * deck re-scan re-points the vaguest slot it can find before it describes a
 * copy it can't match.
 */
const vagueness = (s: DeckCard) => (s.condition || s.finish || s.lang ? 0 : s.scryfallId ? 1 : 2);

/** The wants worth storing — drops the "any" (undefined) ones. */
function wantFields(wants: SlotWants | undefined): SlotWants {
  if (!wants) return {};
  return {
    ...(wants.condition ? { condition: wants.condition } : {}),
    ...(wants.finish ? { finish: wants.finish } : {}),
    ...(wants.lang ? { lang: wants.lang } : {}),
  };
}

export interface AddDeckCardInput {
  deckId: string;
  oracleId: string;
  /** Preferred printing for the slot; falls back to the card's default. */
  scryfallId?: string;
  quantity?: number;
  board?: DeckBoard;
  /** "Any printing" basic land — see DeckCard.anyBasic. Pins no printing. */
  anyBasic?: boolean;
  /** Finish/condition/language the slot wants (e.g. copied off a collection copy). */
  wants?: SlotWants;
}

/**
 * Add a slot, merging into the one that already names the same copy — printing,
 * finish, condition and language, the same `exactSlotKey` a bulk filing uses. A
 * slot is identified by what it names, so the two Nazgûl arts you picked in the
 * edition picker stay two lines in the binder, and adding a third of the first
 * one lands on the line that's already there. A slot that names no printing is
 * the "any printing" line, and repeat adds pile onto it as ever.
 *
 * Folding editions together by name is a *decklist* thing (a pasted list wants
 * one "4 Lightning Bolt" line however many printings it mentions), and that
 * lives in `addDeckCardsBulk` without `exact` — not here, where every add came
 * from a person looking at one card.
 */
export async function addDeckCard(input: AddDeckCardInput): Promise<void> {
  const board = input.board ?? 'main';
  const quantity = input.quantity ?? 1;
  const anyBasic = !!input.anyBasic;
  const wants = wantFields(input.wants);
  // "Any printing" basics are their own slot: four Islands from the lands box
  // shouldn't fold into the four foil Islands you actually own.
  const key = exactSlotKey({ oracleId: input.oracleId, board, anyBasic, scryfallId: input.scryfallId || undefined }, wants);
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    if (board === 'companion') {
      // One companion a deck: setting a new one moves the old one to Considering,
      // and setting the same one again is not a second copy of it.
      const seated = await db.deckCards.where('[deckId+board]').equals([input.deckId, 'companion']).toArray();
      if (seated.some((s) => s.oracleId === input.oracleId)) return;
      for (const s of seated) await moveSlotRaw(ctx, s.id, 'maybe', { source: 'manual' });
    }
    const candidates = await db.deckCards
      .where('[deckId+board]')
      .equals([input.deckId, board])
      .and((c) => c.oracleId === input.oracleId)
      .toArray();
    // A stored slot carries its wants as plain fields, so it is its own wants.
    const existing = candidates.find((c) => exactSlotKey(c, c) === key);
    let slot: DeckCard;
    if (existing) {
      slot = { ...existing, quantity: existing.quantity + quantity, updatedAt: now };
    } else {
      slot = {
        id: newId(),
        deckId: input.deckId,
        oracleId: input.oracleId,
        ...(anyBasic ? { anyBasic: true } : { ...(input.scryfallId ? { scryfallId: input.scryfallId } : {}), ...wants }),
        quantity,
        board,
        updatedAt: now,
      };
    }
    await putSynced('deckCards', slot);
    const deck = await ctx.touchDeck(input.deckId);
    const named = { ...input, scryfallId: anyBasic ? undefined : input.scryfallId, board };
    ctx.emit(slotEvent('deck.add', named, quantity, now, deck));
    ctx.touchCopies([slot]);
  });
}

/**
 * Bulk-add (deck import / scan / multi-select), merging by (oracleId, board) —
 * or, with `exact`, by the full copy identity (printing + finish + condition +
 * language), which is what filing cards you own out of the collection wants.
 * Every line shares a batchId so the edit-history view collapses the whole
 * operation into one entry (labelled with the deck name).
 */
export async function addDeckCardsBulk(
  deckId: string,
  cards: Array<{
    oracleId: string;
    quantity: number;
    board: DeckBoard;
    scryfallId?: string;
    anyBasic?: boolean;
    wants?: SlotWants;
  }>,
  meta: { source?: EventSource; exact?: boolean } & BatchMeta = {},
): Promise<void> {
  const keyOf = meta.exact
    ? (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean; scryfallId?: string }, w?: SlotWants) =>
        exactSlotKey(c, w)
    : (c: { oracleId: string; board: DeckBoard; anyBasic?: boolean }) => slotKey(c);
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    // A stored slot carries its wants as plain fields, so it is its own wants.
    const map = new Map(existing.map((c) => [keyOf(c, c), c]));
    const touched = new Set<DeckCard>();
    const deck = await ctx.touchDeck(deckId);
    // Default 'manual' (not 'import') so deck adds don't land in the collection
    // "Imports" filter; the batchId still collapses them into one history entry.
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel ?? deck?.name);
    for (const c of cards) {
      const ex = map.get(keyOf(c, c.wants));
      if (ex) {
        ex.quantity += c.quantity;
        // Adopt the incoming printing and wants if the slot named none of its own
        // (an "any printing" basic never takes any on).
        if (!ex.anyBasic) {
          if (!ex.scryfallId && c.scryfallId) ex.scryfallId = c.scryfallId;
          if (!ex.condition && !ex.finish && !ex.lang) Object.assign(ex, wantFields(c.wants));
        }
        ex.updatedAt = now;
        touched.add(ex);
      } else {
        const dc: DeckCard = {
          id: newId(),
          deckId,
          oracleId: c.oracleId,
          quantity: c.quantity,
          board: c.board,
          ...(c.anyBasic ? { anyBasic: true } : { scryfallId: c.scryfallId, ...wantFields(c.wants) }),
          updatedAt: now,
        };
        map.set(keyOf(c, c.wants), dc);
        touched.add(dc);
      }
      const named = { ...c, scryfallId: c.anyBasic ? undefined : c.scryfallId, deckId };
      ctx.emit(slotEvent('deck.add', named, c.quantity, now, deck, extra));
    }
    const writes = [...touched];
    await putSyncedMany('deckCards', writes);
    ctx.touchCopies(writes);
  }, meta);
}

/**
 * Reconcile a deck to *exactly* the given slots (deck re-scan): matching slots
 * have their quantity set to the target, copies the deck didn't list get a new
 * slot, and any current slot the scan didn't see is removed. Everything shares
 * one batchId — the whole re-scan collapses to a single undoable history entry,
 * labelled with the deck name. A slot whose quantity is unchanged emits no event
 * (a bare re-pin stages silently, like patchDeckCard). "Any printing" basic slots
 * sit this out entirely — no camera can see a card you never sleeved. Returns the
 * change counts.
 *
 * Targets are *copies*, not decklist lines: each one names a printing and its
 * traits, so a re-scan files what it saw the same way every other route into a
 * container does (see deck/filing.ts). Matching is exact first — same printing,
 * same finish, condition and language — then falls back to the vaguest slot the
 * deck has for that card, which the scan re-points at the cardboard the camera
 * actually found. That keeps the slot (and its tags) instead of sweeping a
 * pasted decklist line away and adding a copy beside it.
 */
export async function reconcileDeck(
  deckId: string,
  target: Array<{ oracleId: string; board: DeckBoard; quantity: number; scryfallId?: string; wants?: SlotWants }>,
  meta: { source?: EventSource } & BatchMeta = {},
): Promise<{ added: number; removed: number; changed: number }> {
  let added = 0;
  let removed = 0;
  let changed = 0;
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    const existing = await db.deckCards.where('deckId').equals(deckId).toArray();
    // An "any printing" basic isn't a piece of cardboard the camera could have
    // seen, so a re-scan neither matches nor sweeps it away.
    const slots = existing.filter((c) => !c.anyBasic);
    const byCopy = new Map<string, DeckCard[]>();
    const byCard = new Map<string, DeckCard[]>();
    for (const s of slots) {
      // Match an emptied-out slot (DeckCard.unfiled) as if it were filed: the
      // camera just saw the card, so it's holding its copy again.
      push(byCopy, exactSlotKey({ ...s, unfiled: false }, s), s);
      push(byCard, slotKey(s), s);
    }
    // Which slot each scanned copy lands on: exact first, then a re-point.
    const taken = new Set<string>();
    const pairs: Array<{ t: (typeof target)[number]; cur?: DeckCard }> = [];
    for (const t of target) {
      if (t.quantity <= 0) continue;
      const cur = (byCopy.get(exactSlotKey(t, t.wants)) ?? []).find((s) => !taken.has(s.id));
      if (cur) taken.add(cur.id);
      pairs.push({ t, cur });
    }
    for (const p of pairs) {
      if (p.cur) continue;
      // Vaguest slot first: a line naming no printing and no traits is a brew
      // line the scan can pin outright, ahead of one describing another copy.
      const free = (byCard.get(slotKey(p.t)) ?? []).filter((s) => !taken.has(s.id)).sort((a, b) => vagueness(b) - vagueness(a));
      if (free.length === 0) continue;
      p.cur = free[0];
      taken.add(free[0]!.id);
    }
    const puts: DeckCard[] = [];
    const deletes: string[] = [];
    // Slots the re-scan swept away, kept so the copies they held get stamped.
    const swept: DeckCard[] = [];
    const deck = await ctx.touchDeck(deckId);
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel ?? deck?.name);

    for (const { t, cur } of pairs) {
      if (!cur) {
        puts.push({
          id: newId(),
          deckId,
          oracleId: t.oracleId,
          ...(t.scryfallId ? { scryfallId: t.scryfallId } : {}),
          ...wantFields(t.wants),
          quantity: t.quantity,
          board: t.board,
          updatedAt: now,
        });
        added++;
        ctx.emit(slotEvent('deck.add', { ...t, deckId }, t.quantity, now, deck, extra));
        continue;
      }
      const delta = t.quantity - cur.quantity;
      // A scan is the ground truth about cardboard, so the slot takes on the
      // printing and the traits of the copy the camera saw. That's what makes it
      // hold that copy (claimKeyOf) and go green, instead of staying a brew line
      // claiming nothing.
      const scryfallId = t.scryfallId ?? cur.scryfallId;
      const wants = wantFields(t.wants);
      const repinned =
        scryfallId !== cur.scryfallId ||
        wants.condition !== cur.condition ||
        wants.finish !== cur.finish ||
        wants.lang !== cur.lang;
      // Write when the quantity moved OR the slot now names a different copy OR
      // it said the card wasn't here (DeckCard.unfiled).
      if (delta !== 0 || repinned || cur.unfiled) {
        puts.push({
          ...cur,
          quantity: t.quantity,
          ...(scryfallId ? { scryfallId } : {}),
          condition: undefined,
          finish: undefined,
          lang: undefined,
          ...wants,
          unfiled: undefined,
          updatedAt: now,
        });
      }
      if (delta !== 0) {
        changed++;
        ctx.emit(slotEvent(delta > 0 ? 'deck.add' : 'deck.remove', cur, Math.abs(delta), now, deck, extra));
      }
    }

    for (const cur of slots) {
      if (taken.has(cur.id)) continue;
      deletes.push(cur.id);
      swept.push(cur);
      removed++;
      ctx.emit(slotEvent('deck.remove', cur, cur.quantity, now, deck, extra));
    }

    await putSyncedMany('deckCards', puts);
    await deleteSyncedMany('deckCards', deletes);
    ctx.touchCopies([...puts, ...swept]);
  }, meta);
  return { added, removed, changed };
}

/**
 * Move one slot to another board inside an already-open transaction, merging
 * into the slot that card already has there. Returns the copies moved (0 when
 * the slot is gone or already on that board). Events carry `extra`, so a bulk
 * move can stamp them all with one batchId; a null `extra` records no history
 * (the app tidying its own zones).
 */
export async function moveSlotRaw(ctx: WriteCtx, id: string, board: DeckBoard, extra: EventExtra | null): Promise<number> {
  const { now } = ctx;
  const card = await db.deckCards.get(id);
  if (!card || card.board === board) return 0;
  // A deck has one companion: setting a new one sends the old one to
  // Considering, in the same batch, so one undo swaps them back.
  if (board === 'companion') {
    const seated = await db.deckCards.where('[deckId+board]').equals([card.deckId, 'companion']).toArray();
    for (const s of seated) {
      if (s.oracleId !== card.oracleId) await moveSlotRaw(ctx, s.id, 'maybe', extra);
    }
  }
  if (await mergeIntoSlot(card, card.deckId, board, now)) await deleteSynced('deckCards', id);
  else await putSynced('deckCards', { ...card, board, updatedAt: now });
  const deck = await ctx.touchDeck(card.deckId);
  // A move is a leave and an arrival: the pair is what the history reads, and
  // what undo replays backwards to put the card back where it was.
  if (extra) {
    ctx.emit(slotEvent('deck.remove', card, card.quantity, now, deck, extra));
    ctx.emit(slotEvent('deck.add', { ...card, board }, card.quantity, now, deck, extra));
  }
  ctx.touchCopies([card]);
  return card.quantity;
}

/**
 * Fold `card` into the slot that card already has on `board` of `deckId`, when
 * there is one. Two slots becoming one: the tags of both come along, or moving
 * a tagged card to the sideboard would quietly strip what you labelled it.
 * Returns whether it merged; the caller deletes or re-homes `card` either way.
 */
async function mergeIntoSlot(card: DeckCard, deckId: string, board: DeckBoard, now: number): Promise<boolean> {
  const existing = await db.deckCards
    .where('[deckId+board]')
    .equals([deckId, board])
    .and((c) => c.oracleId === card.oracleId && !!c.anyBasic === !!card.anyBasic)
    .first();
  if (!existing) return false;
  await putSynced('deckCards', {
    ...existing,
    quantity: existing.quantity + card.quantity,
    tags: normalizeCardTags([...(existing.tags ?? []), ...(card.tags ?? [])]),
    updatedAt: now,
  });
  return true;
}

/** Move a slot to another board, merging into an existing slot for the same card there. */
export async function moveDeckCard(id: string, board: DeckBoard): Promise<void> {
  // The leave/arrive pair is one thing the user did, so it shares a batchId
  // and reads as a single "Moved to …" entry (which undoes in one tap).
  await write(DECK_TABLES, async (ctx) => {
    await moveSlotRaw(ctx, id, board, { source: 'manual', batchId: ctx.batchId });
  });
}

/**
 * Move slots out of one container and into another (cut here, paste there).
 *
 * The whole thing is one batch, so it reads as a single move in the history and
 * comes back in one undo — and because that batch names both containers, the
 * undo is offered at either end. Pasting on the far side is usually the only
 * end you can see, so this is the one operation that has to be reversible from
 * somewhere other than where it started.
 *
 * `boardFor` picks the arriving slot's zone per card, since the source zone
 * doesn't always exist over here (a binder has no sideboard, and a commander
 * pasted into a 60-card deck is just a creature). Returns copies moved.
 */
export async function moveDeckCardsToContainer(
  ids: string[],
  targetDeckId: string,
  boardFor: (slot: DeckCard) => DeckBoard,
): Promise<number> {
  if (ids.length === 0) return 0;
  let moved = 0;
  await write(DECK_TABLES, async (ctx) => {
    const target = await ctx.touchDeck(targetDeckId);
    if (!target) return;
    const { now } = ctx;
    const extra = batchFields('manual', ctx.batchId, target.name);
    for (const id of ids) {
      const card = await db.deckCards.get(id);
      if (!card) continue;
      const board = boardFor(card);
      // Same container and same zone: nothing to do. Same container, different
      // zone: that's an ordinary board move, and moveSlotRaw already knows how.
      if (card.deckId === targetDeckId) {
        moved += await moveSlotRaw(ctx, id, board, extra);
        continue;
      }
      // Merge into whatever is already sitting on that zone over here, exactly
      // as a board move merges, so pasting a second copy doesn't split the slot.
      if (!(await mergeIntoSlot(card, targetDeckId, board, now))) {
        await putSynced('deckCards', { ...card, id: newId(), deckId: targetDeckId, board, updatedAt: now });
      }
      await deleteSynced('deckCards', id);
      ctx.touchCopies([card]);
      // A leave from over there and an arrival over here. Same pair a board
      // move writes, so isMoveBatch reads it as a move and undo replays it back.
      const source = await ctx.touchDeck(card.deckId);
      ctx.emit(slotEvent('deck.remove', card, card.quantity, now, source, extra));
      ctx.emit(slotEvent('deck.add', { ...card, deckId: targetDeckId, board }, card.quantity, now, target, extra));
      moved += card.quantity;
    }
  });
  return moved;
}

/**
 * Move whole slots to another board in one go (the multi-select "Move to…").
 * Every line shares a batchId labelled with the deck, so the edit history shows
 * one entry the user can undo in a single tap. Slots already on that board are
 * skipped. Returns how many copies moved.
 */
export async function moveDeckCardsBulk(ids: string[], board: DeckBoard): Promise<number> {
  if (ids.length === 0) return 0;
  let moved = 0;
  await write(DECK_TABLES, async (ctx) => {
    const first = await db.deckCards.get(ids[0]!);
    const deck = first ? await ctx.getDeck(first.deckId) : undefined;
    const extra = batchFields('manual', ctx.batchId, deck?.name);
    // One at a time on purpose: two selected slots can target the same slot on
    // the far side, and each move has to see what the one before it merged.
    // The deck is stamped once at the end, not once per slot.
    for (const id of ids) moved += await moveSlotRaw(ctx, id, board, extra);
  });
  return moved;
}

/**
 * Change a slot's quantity/printing/wants; quantity ≤ 0 deletes the slot.
 * `scryfallId` and `wants` are only touched when the patch names them, and an
 * empty string / an all-undefined `wants` clears them back to "any" — so the
 * edit sheet can move a slot from a pinned foil to "any edition, any finish".
 */
/** How long a run of hand edits to one slot keeps folding into a single entry. */
const SLOT_COALESCE_MS = 30_000;

/**
 * Record a hand edit to one slot's quantity, folding it into the last one when
 * that was the same slot a moment ago.
 *
 * Stepping a playset up one card at a time is four presses of `+`, and four
 * lines in the edit history is not what happened: you added four Bolts. So a
 * run of edits in the same direction reads as one entry that grows.
 *
 * Only the same direction. Letting a removal eat the add before it would be
 * tidier still, and it would quietly delete the only thing undo had to work
 * with: delete a card you added a minute ago and both entries vanish, so Ctrl+Z
 * reaches past it and takes back something else instead. An extra line in the
 * history is a far smaller price than a deletion nothing can reverse.
 *
 * The folded event's timestamp moves to now, so "the last thing you did" stays
 * the last thing undo reaches for even when you touched something else in
 * between. Only ungrouped hand edits fold: an import, a scan or a trade already
 * has a batch of its own and is nobody's idea of clutter.
 */
async function emitSlotDelta(ctx: WriteCtx, card: DeckCard, kind: 'deck.add' | 'deck.remove', qty: number): Promise<void> {
  const { now } = ctx;

  const recent = await db.events.where('ts').above(now - SLOT_COALESCE_MS).toArray();
  // The newest ungrouped hand edit to this exact slot. Anything of the other
  // kind in between ends the run, so +,-,+ stays three honest entries rather
  // than folding the last press into one from before you changed direction.
  const last = recent
    .filter(
      (e) =>
        (e.kind === 'deck.add' || e.kind === 'deck.remove') &&
        e.deckId === card.deckId &&
        (e.board ?? 'main') === (card.board ?? 'main') &&
        e.oracleId === card.oracleId &&
        e.batchId == null &&
        e.tradeId == null &&
        e.source == null,
    )
    .sort((a, b) => b.ts - a.ts)[0];

  if (last?.kind === kind) {
    const grown: UserEvent = { ...last, qty: (last.qty ?? 0) + qty, ts: now, updatedAt: now };
    await putSynced('events', grown);
    return;
  }
  ctx.emit(slotEvent(kind, card, qty, now, await ctx.getDeck(card.deckId)));
}

async function patchDeckCard(
  id: string,
  patch: { quantity?: number; scryfallId?: string; anyBasic?: boolean; wants?: SlotWants; tags?: string[] },
): Promise<void> {
  await write(DECK_TABLES, async (ctx) => {
    const card = await db.deckCards.get(id);
    if (!card) return;
    const { now } = ctx;
    const quantity = patch.quantity ?? card.quantity;
    const delta = quantity - card.quantity;
    const anyBasic = patch.anyBasic ?? !!card.anyBasic;
    // A cleared want has to be written as undefined, not left off the object.
    const clearedWants: SlotWants = { condition: undefined, finish: undefined, lang: undefined };
    const wants = patch.wants ? { ...clearedWants, ...wantFields(patch.wants) } : {};
    // The slot after the edit, when it survives one. Held out here so the stamp
    // below can name both copies: repointing a slot from your English copy to
    // the Italian one is an edit to each of them.
    let next: DeckCard | undefined;

    if (quantity <= 0) {
      await deleteSynced('deckCards', id);
    } else {
      // The two are exclusive: a lands-box basic pins no edition (and asks
      // nothing of your copies), and pinning one turns the slot back into a copy
      // you're counting on owning.
      // Naming the copy a slot holds is saying it holds it: the edit sheet's save
      // and the assembler both come through here, so either one files an emptied
      // slot (DeckCard.unfiled) back in. A bare quantity or tag edit leaves the
      // flag where it was.
      const refiled = 'scryfallId' in patch || !!patch.wants;
      next = {
        ...card,
        quantity,
        ...(anyBasic
          ? { anyBasic: true, scryfallId: undefined, unfiled: undefined, ...clearedWants }
          : {
              anyBasic: undefined,
              ...('scryfallId' in patch ? { scryfallId: patch.scryfallId || undefined } : {}),
              ...(refiled ? { unfiled: undefined } : {}),
              ...wants,
            }),
        // Tags survive every other kind of edit; only a patch that names them
        // rewrites them (an empty list clears the slot back to untagged).
        ...('tags' in patch ? { tags: normalizeCardTags(patch.tags) } : {}),
        updatedAt: now,
      };
      await putSynced('deckCards', next);
    }

    const removedAll = quantity <= 0;
    if (delta !== 0 || removedAll) {
      await emitSlotDelta(
        ctx,
        card,
        removedAll || delta < 0 ? 'deck.remove' : 'deck.add',
        removedAll ? card.quantity : Math.abs(delta),
      );
    }
    ctx.touchCopies(next ? [card, next] : [card]);
    await ctx.touchDeck(card.deckId);
  });
}

/** Set a slot's quantity; deletes the slot at zero. */
export async function setDeckCardQuantity(id: string, quantity: number): Promise<void> {
  await patchDeckCard(id, { quantity });
}

/**
 * Pick (or clear) the color a choose-a-color commander is (see
 * DeckCard.chosenColor). Like a tag edit, it adds and removes no cardboard, so
 * there is no history event to emit — just the slot rewrite and the sync stage.
 */
export async function setDeckCardChosenColor(id: string, color: Color | undefined): Promise<void> {
  await write(DECK_TABLES, async (ctx) => {
    const card = await patchSynced('deckCards', id, (c) => {
      if (c.chosenColor === color) return false;
      c.chosenColor = color;
    }, ctx.now);
    if (card) await ctx.touchDeck(card.deckId);
  });
}

/** Update a slot's quantity, preferred printing and wants (deck edit sheet).
 *  An empty `scryfallId` means "any edition"; omitted wants mean "any". */
export async function updateDeckCard(
  id: string,
  patch: { quantity: number; scryfallId: string; anyBasic?: boolean; wants?: SlotWants; tags?: string[] },
): Promise<void> {
  await patchDeckCard(id, patch);
}

/**
 * Take the cardboard out of a container without touching its list, or put it
 * back — the multi-select "Unfile…" → this deck, and "File back here". The slot
 * keeps everything it names (printing, finish, condition, language); it just
 * stops claiming one of your copies, so the copy is free for another deck and
 * the green collection badge drops to the double checkmark (see
 * DeckCard.unfiled).
 *
 * Only slots that name one physical copy can go either way: a brew line and a
 * lands-box basic never held cardboard, so there is nothing to take out of them.
 * Nothing is added or removed from the container, so — like a tag edit — this
 * emits no history event; there is no card to undo back into place.
 *
 * Returns the copies affected.
 */
export async function setDeckCardsUnfiled(ids: string[], unfiled: boolean): Promise<number> {
  if (ids.length === 0) return 0;
  return write(DECK_TABLES, async (ctx) =>
    setSlotsUnfiled(ctx, (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c), unfiled),
  );
}

export async function setSlotsUnfiled(ctx: WriteCtx, slots: DeckCard[], unfiled: boolean): Promise<number> {
  let copies = 0;
  const writes: DeckCard[] = [];
  for (const s of slots) {
    if (!namedCopy(s)) continue;
    if (!!s.unfiled === unfiled) continue;
    writes.push({ ...s, unfiled: unfiled ? true : undefined, updatedAt: ctx.now });
    copies += s.quantity;
  }
  await putSyncedMany('deckCards', writes);
  for (const w of writes) await ctx.touchDeck(w.deckId);
  // Taking a copy out of a container by hand, or putting it back, is the
  // plainest filing change there is.
  ctx.touchCopies(writes);
  return copies;
}

// ---- Card tags -------------------------------------------------------------
// A container's tags are derived: they exist because slots carry them, so there
// is no registry to keep in step, no orphan rows, and nothing extra to sync —
// a tag rides along in the slot's own row like its quantity or its finish.
// Tag edits deliberately emit no history event: nothing was added or removed
// from the container, so there is nothing to undo a card into.

/**
 * Add and/or remove tags across a set of slots — the multi-select "Tag…" action
 * lands here. Slots already in the wanted state aren't rewritten, so re-applying
 * a tag doesn't churn the sync outbox. Returns how many slots changed.
 */
export async function tagDeckCards(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<number> {
  const add = normalizeCardTags(change.add ?? []) ?? [];
  const remove = new Set((normalizeCardTags(change.remove ?? []) ?? []).map((t) => t.toLocaleLowerCase()));
  if (ids.length === 0 || (add.length === 0 && remove.size === 0)) return 0;
  return retagSlots(
    async () => (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c),
    (tags) => [...tags.filter((t) => !remove.has(t.toLocaleLowerCase())), ...add],
  );
}

/**
 * Rewrite the tags of the slots `load` returns, in one transaction. Slots whose
 * tags come out the same aren't rewritten, so re-applying a tag doesn't churn
 * the sync outbox. Every container a rewritten slot sits in is touched.
 */
async function retagSlots(load: () => Promise<DeckCard[]>, retag: (tags: string[]) => string[]): Promise<number> {
  return write(DECK_TABLES, async (ctx) => {
    const writes: DeckCard[] = [];
    for (const s of await load()) {
      const next = normalizeCardTags(retag(s.tags ?? []));
      if (sameCardTags(s.tags, next)) continue;
      writes.push({ ...s, tags: next, updatedAt: ctx.now });
    }
    await putSyncedMany('deckCards', writes);
    for (const w of writes) await ctx.touchDeck(w.deckId);
    return writes.length;
  });
}

/**
 * Rename a tag everywhere it appears in one container. Because tags are derived
 * from the slots carrying them, renaming *is* rewriting those slots; renaming
 * onto a tag that already exists merges the two.
 */
export async function renameDeckCardTag(deckId: string, from: string, to: string): Promise<number> {
  const target = normalizeCardTags([to])?.[0];
  const key = from.toLocaleLowerCase();
  if (!target || key === target.toLocaleLowerCase()) return 0;
  return retagSlots(
    () => db.deckCards.where('deckId').equals(deckId).toArray(),
    (tags) => tags.map((t) => (t.toLocaleLowerCase() === key ? target : t)),
  );
}

/** Drop a tag from every slot in one container — the tag then stops existing. */
export async function deleteDeckCardTag(deckId: string, tag: string): Promise<number> {
  const key = normalizeCardTags([tag])?.[0]?.toLocaleLowerCase();
  if (!key) return 0;
  return retagSlots(
    () => db.deckCards.where('deckId').equals(deckId).toArray(),
    (tags) => tags.filter((t) => t.toLocaleLowerCase() !== key),
  );
}

export async function removeDeckCard(id: string): Promise<void> {
  await patchDeckCard(id, { quantity: 0 });
}

/**
 * Delete whole slots in one go (the multi-select "remove these from this deck /
 * binder / box"). Every line shares a batchId labelled with the container, so
 * the edit history shows one entry the user can undo in a single tap. Returns
 * how many copies were removed.
 */
export async function removeDeckCardsBulk(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let removed = 0;
  await write(DECK_TABLES, async (ctx) => {
    const slots = (await db.deckCards.bulkGet(ids)).filter((c): c is DeckCard => !!c);
    await deleteSyncedMany('deckCards', slots.map((s) => s.id));
    ctx.touchCopies(slots);
    // Selection lives on one screen, so these are all one container's slots,
    // but touch each named deck anyway rather than assume it.
    for (const s of slots) {
      const deck = await ctx.touchDeck(s.deckId);
      ctx.emit(slotEvent('deck.remove', s, s.quantity, ctx.now, deck, batchFields('manual', ctx.batchId, deck?.name)));
      removed += s.quantity;
    }
  });
  return removed;
}

/**
 * Take copies of the given cards out of *another* container — the multi-select
 * fix for a card promised to two places at once. A slot matches on the card and,
 * where both sides say so, on the printing and on the finish/condition/language
 * the slot wants: the same rule the placement badges use, so what the picker
 * offered is what comes off. Up to `quantity` copies are taken per card, exact
 * printing first; a slot emptied that way is deleted. Returns how many copies
 * were removed.
 */
export async function removeDeckCardsMatching(
  containerId: string,
  cards: Array<{ oracleId: string; scryfallId?: string; quantity: number; wants?: CopyPrefs }>,
  meta: { source?: EventSource } & BatchMeta = {},
): Promise<number> {
  if (cards.length === 0) return 0;
  let removed = 0;
  await write(DECK_TABLES, async (ctx) => {
    const { now } = ctx;
    const byOracle = groupByOracle(await db.deckCards.where('deckId').equals(containerId).toArray());
    // Copies taken off each slot, accumulated so two selected printings of one
    // card don't each write their own event line for the same slot.
    const taken = new Map<DeckCard, number>();
    for (const card of cards) {
      const candidates = (byOracle.get(card.oracleId) ?? []).filter(
        // A lands-box basic never claimed one of your copies, so taking it out
        // resolves nothing — it isn't a placement the picker offered either.
        (s) =>
          !s.anyBasic &&
          (!s.scryfallId || !card.scryfallId || s.scryfallId === card.scryfallId) &&
          (!card.wants || prefsCompatible(s, card.wants)),
      );
      // Exact printing first, then the edition-less slots (a pasted decklist).
      const ranked = [...candidates].sort(
        (a, b) => Number(b.scryfallId === card.scryfallId) - Number(a.scryfallId === card.scryfallId),
      );
      let remaining = card.quantity;
      for (const s of ranked) {
        if (remaining <= 0) break;
        const room = s.quantity - (taken.get(s) ?? 0);
        if (room <= 0) continue;
        const take = Math.min(room, remaining);
        taken.set(s, (taken.get(s) ?? 0) + take);
        remaining -= take;
        removed += take;
      }
    }
    if (taken.size === 0) return;
    const deck = await ctx.touchDeck(containerId);
    const extra = batchFields(meta.source ?? 'manual', ctx.batchId, meta.batchLabel ?? deck?.name);
    for (const [slot, qty] of taken) {
      await adjustRow('deckCards', slot, -qty, now);
      ctx.emit(slotEvent('deck.remove', slot, qty, now, deck, extra));
    }
    ctx.touchCopies(taken.keys());
  }, meta);
  return removed;
}

/**
 * Mark every card in a container for trade (or clear the flag), the bulk
 * "this whole box is up for grabs" action. Container slots name an oracle card
 * and (usually) a preferred printing, so each slot is matched against the
 * copies actually owned — the slot's printing first, then any other edition of
 * the same card — for up to the slot's quantity. Cards you don't own are
 * skipped, as are "any printing" basics (that slot never claimed a copy of
 * yours, so it has none to offer). Returns how many copies changed.
 */
export async function setContainerForTrade(containerId: string, forTrade: boolean): Promise<number> {
  const slots = await db.deckCards.where('deckId').equals(containerId).toArray();
  // An emptied-out slot (DeckCard.unfiled) is a line on the list, not a card in
  // the box, so there's nothing here to put up for grabs.
  return setSlotsForTrade(slots.filter((s) => !s.unfiled), forTrade);
}

/**
 * The same thing for a hand-picked set of slots (multi-select in a deck, binder
 * or box). Returns how many copies changed.
 */
export async function setDeckCardsForTrade(ids: string[], forTrade: boolean): Promise<number> {
  const slots = (await db.deckCards.bulkGet(ids)).filter((s): s is DeckCard => !!s);
  return setSlotsForTrade(slots, forTrade);
}

async function setSlotsForTrade(slots: DeckCard[], forTrade: boolean): Promise<number> {
  const requests: MarkForTradeRequest[] = slots.filter((s) => !s.anyBasic).map((s) => ({
    oracleId: s.oracleId,
    scryfallId: s.scryfallId ?? '',
    // A slot that names a finish/condition/language points at the copy it means;
    // where it says "any", fall back to the usual defaults so the printing
    // decides the match and ties go to whatever's first.
    condition: s.condition ?? 'NM',
    finish: s.finish ?? 'nonfoil',
    lang: s.lang ?? 'en',
    quantity: s.quantity,
  }));
  return forTrade ? markOwnedForTrade(requests) : unmarkOwnedForTrade(requests);
}

/**
 * The inverse of markOwnedForTrade: take copies back off the tradelist,
 * preferring the requested printing. Unmarking isn't an event (nothing entered
 * or left the collection) — the same as clearing the flag from the tradelist
 * screen. Returns how many copies were unflagged.
 */
async function unmarkOwnedForTrade(requests: MarkForTradeRequest[]): Promise<number> {
  if (requests.length === 0) return 0;
  let unflagged = 0;
  await db.transaction('rw', [db.collection, db.outbox], async () => {
    const now = Date.now();
    const byOracle = await ownedByOracle(requests);
    const touched = new Set<CollectionEntry>();
    for (const req of requests) {
      const entries = byOracle.get(req.oracleId);
      if (!entries) continue;
      const ranked = [...entries].sort(
        (a, b) => Number(b.scryfallId === req.scryfallId) - Number(a.scryfallId === req.scryfallId),
      );
      let remaining = req.quantity;
      for (const e of ranked) {
        if (remaining <= 0) break;
        if (e.quantityForTrade <= 0) continue;
        const take = Math.min(e.quantityForTrade, remaining);
        e.quantityForTrade -= take;
        e.updatedAt = now;
        remaining -= take;
        unflagged += take;
        touched.add(e);
      }
    }
    await putSyncedMany('collection', [...touched]);
  });
  return unflagged;
}

/** Change a deck slot by delta (negative removes, positive re-adds). No-op if the deck is gone. */
export async function deckAdjustRaw(e: UserEvent, delta: number, now: number): Promise<void> {
  if (!e.deckId || !delta) return;
  const deck = await db.decks.get(e.deckId);
  if (!deck) return;
  const board = e.board ?? 'main';
  const cards = await db.deckCards.where('[deckId+board]').equals([e.deckId, board]).toArray();
  const dc = cards.find((c) => c.oracleId === e.oracleId);
  await adjustRow('deckCards', dc, delta, now, (q) => ({
    id: newId(),
    deckId: e.deckId!,
    oracleId: e.oracleId,
    ...(e.scryfallId ? { scryfallId: e.scryfallId } : {}),
    quantity: q,
    board,
    updatedAt: now,
  }));
  const touched: Deck = { ...deck, updatedAt: now };
  await putSynced('decks', touched);
}
