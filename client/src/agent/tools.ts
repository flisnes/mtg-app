// The v1 agent tool surface. Every tool runs inside the tab against the real
// data layer, so writes go through dataAccess: outbox staging, events and
// batchIds (one tool call = one history entry = one undo) come for free.
//
// Deck writes are LIST-ONLY on purpose: slots are added without wants, so
// they claim no physical copy and can never trigger a filing move. Filing
// stays a human decision in the app (kanban: Agent bridge 2).

import {
  CONDITIONS,
  CONTAINER_KINDS,
  DECK_FORMATS,
  FINISHES,
  compileCardQuery,
  rowPrintingSummary,
  toSearchableEntry,
  type Condition,
  type ContainerKind,
  type DeckBoard,
  type DeckFormat,
  type Finish,
  type OracleCard,
  type RowPrinting,
} from '@mtg/shared';
import { loadOracleTags } from '../cardDb/oracleTags.js';
import { getPricesByIds, priceForFinish } from '../cardDb/prices.js';
import { resolveOracleByName, searchCards } from '../cardDb/search.js';
import { priceValue } from '../components/cardSort.js';
import {
  addDeckCardsBulk,
  addToWishlistBulk,
  applyImport,
  createContainer,
  createDeckFolder,
  newId,
  removeDeckCardsBulk,
  setDeckCardQuantity,
  setDeckFolder,
  setQuantityForTradeBulk,
  undoEntry,
  type ImportLine,
} from '../db/dataAccess.js';
import { joinCollectionEntries, joinDeckCards, joinWishlistEntries } from '../db/queries.js';
import { db } from '../db/schema.js';
import type { AgentTool } from './registry.js';
import { resolveNames, type NameLine } from './resolveNames.js';

const BOARDS: readonly DeckBoard[] = ['main', 'side', 'commander', 'token'];

// ---------------------------------------------------------------------------
// Argument coercion (args arrive as unknown JSON from the agent)
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(min, Math.min(max, n));
}

interface ToolLine extends NameLine {
  condition: Condition;
  finish: Finish;
  lang: string;
  board: DeckBoard;
}

/** Normalize a lines[] argument; throws on structurally hopeless input. */
function readLines(v: unknown, max = 500): ToolLine[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error('lines must be a non-empty array');
  if (v.length > max) throw new Error(`at most ${max} lines per call`);
  return v.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`line ${i} is not an object`);
    const o = raw as Record<string, unknown>;
    const name = str(o.name);
    if (!name) throw new Error(`line ${i} has no name`);
    const condition = str(o.condition) as Condition | undefined;
    if (condition && !CONDITIONS.includes(condition)) throw new Error(`line ${i}: condition must be one of ${CONDITIONS.join(', ')}`);
    const finish = str(o.finish) as Finish | undefined;
    if (finish && !FINISHES.includes(finish)) throw new Error(`line ${i}: finish must be one of ${FINISHES.join(', ')}`);
    const board = str(o.board) as DeckBoard | undefined;
    if (board && !BOARDS.includes(board)) throw new Error(`line ${i}: board must be one of ${BOARDS.join(', ')}`);
    return {
      name,
      set: str(o.set)?.toLowerCase(),
      collectorNumber: str(o.collectorNumber),
      quantity: int(o.quantity, 1, 1, 999),
      condition: condition ?? 'NM',
      finish: finish ?? 'nonfoil',
      lang: str(o.lang) ?? 'en',
      board: board ?? 'main',
    };
  });
}

const LINE_PROPS = {
  name: { type: 'string', description: 'Exact card name (front face is enough for double-faced cards)' },
  set: { type: 'string', description: 'Set code, e.g. "neo" (optional)' },
  collectorNumber: { type: 'string', description: 'Collector number within the set (optional)' },
  quantity: { type: 'integer', minimum: 1, default: 1 },
} as const;

function linesSchema(extraProps: Record<string, unknown>, description: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        description,
        items: { type: 'object', properties: { ...LINE_PROPS, ...extraProps }, required: ['name'] },
      },
      label: { type: 'string', description: 'Optional label for the history entry' },
    },
    required: ['lines'],
  };
}

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

/** P/T as one "2/2" string (fewer tokens than two fields); absent for non-creatures. */
function pt(oracle: OracleCard | undefined): { pt?: string } {
  return oracle?.power != null && oracle.toughness != null ? { pt: `${oracle.power}/${oracle.toughness}` } : {};
}

/** `brief` drops the oracle text, by far the largest field in a list. */
function cardRow(oracle: OracleCard | undefined, brief = false) {
  if (!oracle) return { name: '(unknown card — card DB too small?)' };
  return {
    name: oracle.name,
    manaCost: oracle.manaCost,
    typeLine: oracle.typeLine,
    ...pt(oracle),
    ...(brief ? {} : { oracleText: oracle.oracleText }),
  };
}

const QUERY_PROP = {
  type: 'string',
  description:
    'Filter with the app search syntax, e.g. "id:b t:creature pow<=1", "o:sacrifice -t:land", "set:neo is:foil". Printing terms match the row\'s own printing.',
} as const;
const BRIEF_PROP = { type: 'boolean', default: false, description: 'Omit oracle text to save tokens' } as const;

/**
 * Predicate over joined rows for an optional query: the same matcher as the
 * collection screen's search box. Null when there is no query.
 */
async function rowMatcher(
  query: string | undefined,
): Promise<((oracle: OracleCard | undefined, printing: RowPrinting | undefined, finish?: Finish) => boolean) | null> {
  if (!query) return null;
  // `otag:` resolves its slug at parse time, so the tags must be loaded first.
  await loadOracleTags();
  const q = compileCardQuery(query);
  if (q.isEmpty) return null;
  return (oracle, printing, finish) => !!oracle && q.matches(toSearchableEntry(oracle, rowPrintingSummary(printing, finish)));
}

/** Folder id for a name, matched case-insensitively; created when missing. */
async function folderIdFor(name: string): Promise<string> {
  const lower = name.toLowerCase();
  const existing = (await db.deckFolders.toArray()).find((f) => f.name.toLowerCase() === lower);
  return existing ? existing.id : createDeckFolder(name);
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'search_cards',
    description:
      'Search the local Magic card database (all cards, not just owned). Supports the app query syntax, e.g. "t:goblin", "set:neo", "o:draw a card".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        brief: BRIEF_PROP,
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = str(args.query);
      if (!query) throw new Error('query is required');
      const limit = int(args.limit, 20, 1, 50);
      const res = await searchCards(query, {}, limit);
      const brief = args.brief === true;
      return {
        cards: res.cards.slice(0, limit).map((c) => ({
          ...cardRow(c, brief),
          oracleId: c.oracleId,
          rarity: c.rarity,
          priceEur: c.priceEur,
          priceUsd: c.priceUsd,
        })),
      };
    },
  },
  {
    name: 'get_collection',
    description:
      'List owned cards, filtered by query (app search syntax), name substring and/or set code. Paged with limit/offset. Rows carry pt for creatures. Each row carries the market price per copy of its own printing and finish (priceEur/priceUsd, null when unknown); sort "price" ranks the most valuable first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: QUERY_PROP,
        name: { type: 'string', description: 'Case-insensitive name substring' },
        set: { type: 'string', description: 'Set code, e.g. "neo"' },
        sort: {
          type: 'string',
          enum: ['none', 'price'],
          default: 'none',
          description: '"price": highest price per copy first, in the display currency',
        },
        limit: { type: 'integer', minimum: 1, maximum: 300, default: 100 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    handler: async (args) => {
      const joined = await joinCollectionEntries(await db.collection.toArray());
      const name = str(args.name)?.toLowerCase();
      const set = str(args.set)?.toLowerCase();
      const matches = await rowMatcher(str(args.query));
      const filtered = joined.filter((j) => {
        if (name && !(j.oracle?.name.toLowerCase().includes(name) ?? false)) return false;
        if (set && (j.printing?.set.toLowerCase() ?? '') !== set) return false;
        if (matches && !matches(j.oracle, j.printing, j.entry.finish)) return false;
        return true;
      });
      // Priced per finish: a foil row quotes the foil price, as in the app.
      const prices = await getPricesByIds(filtered.map((j) => j.entry.scryfallId));
      const priced = filtered.map((j) => {
        const { eur, usd } = priceForFinish(prices.get(j.entry.scryfallId), j.entry.finish);
        return { j, eur, usd };
      });
      if (str(args.sort) === 'price') {
        const value = new Map(priced.map((p) => [p, priceValue({ priceEur: p.eur, priceUsd: p.usd }) ?? -1]));
        priced.sort((a, b) => value.get(b)! - value.get(a)!);
      }
      const offset = int(args.offset, 0, 0, 1_000_000);
      const limit = int(args.limit, 100, 1, 300);
      return {
        total: priced.length,
        rows: priced.slice(offset, offset + limit).map(({ j, eur, usd }) => ({
          id: j.entry.id,
          name: j.oracle?.name ?? '(unknown)',
          ...pt(j.oracle),
          set: j.printing?.set,
          collectorNumber: j.printing?.collectorNumber,
          condition: j.entry.condition,
          finish: j.entry.finish,
          lang: j.entry.lang,
          quantity: j.entry.quantity,
          quantityForTrade: j.entry.quantityForTrade,
          priceEur: eur,
          priceUsd: usd,
          ...(j.entry.special ? { special: j.entry.special } : {}),
        })),
      };
    },
  },
  {
    name: 'list_containers',
    description:
      'List every deck, binder and box: id, name, kind, format, folder, card count, archived flag. Also lists the deck folders.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [decks, slots, folders] = await Promise.all([
        db.decks.toArray(),
        db.deckCards.toArray(),
        db.deckFolders.toArray(),
      ]);
      const folderName = new Map(folders.map((f) => [f.id, f.name]));
      const counts = new Map<string, number>();
      for (const s of slots) counts.set(s.deckId, (counts.get(s.deckId) ?? 0) + s.quantity);
      return {
        containers: decks.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind ?? 'deck',
          ...(d.format ? { format: d.format } : {}),
          ...(d.folderId && folderName.has(d.folderId) ? { folder: folderName.get(d.folderId) } : {}),
          cards: counts.get(d.id) ?? 0,
          ...(d.archivedAt ? { archived: true } : {}),
        })),
        folders: folders.map((f) => f.name),
      };
    },
  },
  {
    name: 'get_container',
    description:
      'The list of one deck, binder or box (by id from list_containers), with boards and pinned printings. Use query to filter and brief to drop oracle text on big boxes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, query: QUERY_PROP, brief: BRIEF_PROP },
      required: ['id'],
    },
    handler: async (args) => {
      const id = str(args.id);
      if (!id) throw new Error('id is required');
      const deck = await db.decks.get(id);
      if (!deck) throw new Error(`no container with id ${id}`);
      const joined = await joinDeckCards(await db.deckCards.where('deckId').equals(id).toArray());
      const matches = await rowMatcher(str(args.query));
      const brief = args.brief === true;
      const rows = matches ? joined.filter((j) => matches(j.oracle, j.printing, j.entry.finish)) : joined;
      return {
        id: deck.id,
        name: deck.name,
        kind: deck.kind ?? 'deck',
        ...(deck.format ? { format: deck.format } : {}),
        cards: rows.map((j) => ({
          ...cardRow(j.oracle, brief),
          quantity: j.entry.quantity,
          board: j.entry.board,
          ...(j.printing ? { set: j.printing.set, collectorNumber: j.printing.collectorNumber } : {}),
          ...(j.entry.anyBasic ? { anyBasic: true } : {}),
        })),
      };
    },
  },
  {
    name: 'get_wishlist',
    description: 'List the wishlist: wanted cards, quantities and any printing/finish wishes.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const joined = await joinWishlistEntries(await db.wishlist.toArray());
      return {
        rows: joined.map((j) => ({
          name: j.oracle?.name ?? '(unknown)',
          quantity: j.entry.quantity,
          ...(j.printing ? { set: j.printing.set, collectorNumber: j.printing.collectorNumber } : {}),
          ...(j.entry.finish ? { finish: j.entry.finish } : {}),
          ...(j.entry.condition ? { condition: j.entry.condition } : {}),
          ...(j.entry.lang ? { lang: j.entry.lang } : {}),
        })),
      };
    },
  },
  {
    name: 'get_tradelist',
    description: 'List the cards currently marked for trade (quantityForTrade > 0).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const entries = (await db.collection.toArray()).filter((e) => e.quantityForTrade > 0);
      const joined = await joinCollectionEntries(entries);
      return {
        rows: joined.map((j) => ({
          name: j.oracle?.name ?? '(unknown)',
          set: j.printing?.set,
          collectorNumber: j.printing?.collectorNumber,
          condition: j.entry.condition,
          finish: j.entry.finish,
          lang: j.entry.lang,
          quantityForTrade: j.entry.quantityForTrade,
        })),
      };
    },
  },
  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------
  {
    name: 'add_cards',
    description:
      'Add cards to the collection by name (optionally set/collectorNumber/condition/finish/lang). One call is one history entry; undo it with the undo tool and the returned batchId.',
    write: true,
    inputSchema: linesSchema(
      {
        condition: { type: 'string', enum: [...CONDITIONS], default: 'NM' },
        finish: { type: 'string', enum: [...FINISHES], default: 'nonfoil' },
        lang: { type: 'string', default: 'en' },
      },
      'Cards to add',
    ),
    handler: async (args) => {
      const lines = readLines(args.lines);
      const { resolved, unmatched } = await resolveNames(lines);
      const batchId = newId();
      let added = 0;
      if (resolved.length > 0) {
        const importLines: ImportLine[] = resolved.map((r) => ({
          oracleId: r.oracle.oracleId,
          scryfallId: r.scryfallId,
          condition: r.line.condition,
          finish: r.line.finish,
          lang: r.line.lang,
          quantity: r.line.quantity,
          quantityForTrade: 0,
        }));
        const res = await applyImport(importLines, {
          source: 'import',
          batchId,
          label: str(args.label) ?? 'Agent import',
        });
        added = res.cards;
      }
      return { added, unmatched, ...(added > 0 ? { batchId } : {}) };
    },
  },
  {
    name: 'add_to_wishlist',
    description: 'Add cards to the wishlist by name ("any printing" unless set/collectorNumber is given).',
    write: true,
    inputSchema: linesSchema({}, 'Cards to wish for'),
    handler: async (args) => {
      const lines = readLines(args.lines);
      const { resolved, unmatched } = await resolveNames(lines);
      const batchId = newId();
      let added = 0;
      if (resolved.length > 0) {
        const res = await addToWishlistBulk(
          resolved.map((r) => ({
            oracleId: r.oracle.oracleId,
            scryfallId: r.line.set || r.line.collectorNumber ? r.scryfallId : null,
            quantity: r.line.quantity,
          })),
          { label: 'Agent wishlist add', batchId },
        );
        added = res.cards;
      }
      return { added, unmatched, ...(added > 0 ? { batchId } : {}) };
    },
  },
  {
    name: 'create_container',
    description: 'Create a new empty deck, binder or box.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['deck', 'binder', 'box'], default: 'deck' },
        format: {
          type: 'string',
          enum: [...DECK_FORMATS],
          description: 'Decks only',
        },
        folder: { type: 'string', description: 'Decks only: folder name, created if it does not exist' },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const name = str(args.name);
      if (!name) throw new Error('name is required');
      const kind = (str(args.kind) ?? 'deck') as ContainerKind;
      if (!CONTAINER_KINDS.includes(kind)) throw new Error('kind must be deck, binder or box');
      const format = (str(args.format) ?? 'casual') as DeckFormat;
      if (!DECK_FORMATS.includes(format)) throw new Error(`format must be one of ${DECK_FORMATS.join(', ')}`);
      const folder = str(args.folder);
      if (folder && kind !== 'deck') throw new Error('only decks go in folders');
      const id = await createContainer(name, kind, format);
      if (folder) await setDeckFolder(id, await folderIdFor(folder));
      return { id, name, kind, ...(folder ? { folder } : {}) };
    },
  },
  {
    name: 'set_deck_folder',
    description:
      'Move a deck into a folder by name (created if it does not exist), or out of its folder when folder is omitted.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        containerId: { type: 'string', description: 'From list_containers' },
        folder: { type: 'string', description: 'Folder name; omit to take the deck out of its folder' },
      },
      required: ['containerId'],
    },
    handler: async (args) => {
      const containerId = str(args.containerId);
      if (!containerId) throw new Error('containerId is required');
      const deck = await db.decks.get(containerId);
      if (!deck) throw new Error(`no container with id ${containerId}`);
      if ((deck.kind ?? 'deck') !== 'deck') throw new Error('only decks go in folders');
      const folder = str(args.folder);
      await setDeckFolder(containerId, folder ? await folderIdFor(folder) : undefined);
      return { id: containerId, folder: folder ?? null };
    },
  },
  {
    name: 'add_deck_cards',
    description:
      'Add cards to a deck, binder or box list by name. LIST-ONLY: the slots claim no physical copy and never move cards between containers; file copies in the app itself.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        containerId: { type: 'string', description: 'From list_containers' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ...LINE_PROPS, board: { type: 'string', enum: [...BOARDS], default: 'main' } },
            required: ['name'],
          },
        },
      },
      required: ['containerId', 'lines'],
    },
    handler: async (args) => {
      const containerId = str(args.containerId);
      if (!containerId) throw new Error('containerId is required');
      const deck = await db.decks.get(containerId);
      if (!deck) throw new Error(`no container with id ${containerId}`);
      const lines = readLines(args.lines);
      const { resolved, unmatched } = await resolveNames(lines);
      const batchId = newId();
      if (resolved.length > 0) {
        await addDeckCardsBulk(
          containerId,
          resolved.map((r) => ({
            oracleId: r.oracle.oracleId,
            quantity: r.line.quantity,
            board: r.line.board,
            scryfallId: r.scryfallId,
          })),
          { batchId },
        );
      }
      return { added: resolved.reduce((n, r) => n + r.line.quantity, 0), unmatched, ...(resolved.length > 0 ? { batchId } : {}) };
    },
  },
  {
    name: 'remove_deck_cards',
    description:
      'Remove cards from a deck, binder or box list by name (optionally limited to a board). Removes up to the given quantity per line.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        containerId: { type: 'string', description: 'From list_containers' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: LINE_PROPS.name,
              quantity: LINE_PROPS.quantity,
              board: { type: 'string', enum: [...BOARDS], description: 'Omit to match any board' },
            },
            required: ['name'],
          },
        },
      },
      required: ['containerId', 'lines'],
    },
    handler: async (args) => {
      const containerId = str(args.containerId);
      if (!containerId) throw new Error('containerId is required');
      const rawLines = Array.isArray(args.lines) ? args.lines : [];
      const slots = await db.deckCards.where('deckId').equals(containerId).toArray();
      let removed = 0;
      const toDelete: string[] = [];
      const notFound: string[] = [];
      for (const raw of rawLines) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const name = str(o.name);
        if (!name) continue;
        const board = str(o.board) as DeckBoard | undefined;
        const oracle = await resolveOracleByName(name);
        if (!oracle) {
          notFound.push(name);
          continue;
        }
        let want = int(o.quantity, 1, 1, 999);
        const matching = slots.filter((s) => s.oracleId === oracle.oracleId && (!board || s.board === board));
        if (matching.length === 0) {
          notFound.push(name);
          continue;
        }
        for (const slot of matching) {
          if (want <= 0) break;
          const take = Math.min(want, slot.quantity);
          if (take >= slot.quantity) toDelete.push(slot.id);
          else await setDeckCardQuantity(slot.id, slot.quantity - take);
          slot.quantity -= take;
          want -= take;
          removed += take;
        }
      }
      if (toDelete.length > 0) await removeDeckCardsBulk(toDelete);
      return { removed, notFound };
    },
  },
  {
    name: 'set_quantity_for_trade',
    description:
      'Set how many copies of a card are marked for trade (the tradelist). Sets the TOTAL per card, distributed across the owned copies; 0 removes it from the tradelist.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: LINE_PROPS.name, quantity: { type: 'integer', minimum: 0 } },
            required: ['name', 'quantity'],
          },
        },
      },
      required: ['lines'],
    },
    handler: async (args) => {
      const rawLines = Array.isArray(args.lines) ? args.lines : [];
      const all = await db.collection.toArray();
      const updates: { id: string; quantityForTrade: number }[] = [];
      const notOwned: string[] = [];
      for (const raw of rawLines) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const name = str(o.name);
        if (!name) continue;
        const oracle = await resolveOracleByName(name);
        const rows = oracle ? all.filter((e) => e.oracleId === oracle.oracleId) : [];
        if (rows.length === 0) {
          notOwned.push(name);
          continue;
        }
        let want = int(o.quantity, 0, 0, 9999);
        for (const row of rows) {
          const take = Math.min(want, row.quantity);
          updates.push({ id: row.id, quantityForTrade: take });
          want -= take;
        }
      }
      await setQuantityForTradeBulk(updates);
      return { updated: updates.length, notOwned };
    },
  },
  {
    name: 'undo',
    description: 'Undo one earlier write of this session by its batchId (returned by add_cards, add_to_wishlist, add_deck_cards).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { batchId: { type: 'string' } },
      required: ['batchId'],
    },
    handler: async (args) => {
      const batchId = str(args.batchId);
      if (!batchId) throw new Error('batchId is required');
      const res = await undoEntry({ type: 'batch', batchId });
      return res.undone ? { undone: true, events: res.events.length } : { undone: false, reason: res.reason };
    },
  },
];
