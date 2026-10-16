import { normalizeName, type Finish, type OracleCard, type Printing } from '@mtg/shared';
import { db } from '../../db/schema.js';
import { printingsByCardmarketId } from '../../cardDb/cardmarket.js';
import { cleanCardName, type PurchaseLine, type PurchaseOrder } from './parse.js';

// Purchase lines → printings. What each file gives us, best evidence first:
//
//   a Cardmarket product id       exact, via the card DB's id index
//   set code + collector number   exact, when the marketplace uses Scryfall's
//                                 codes (CardTrader nearly always does)
//   name + number + set name      CardTrader's packing slip and the Cardmarket
//                                 PDF, whose set names and codes are their own
//
// A line that none of these pin down is left unresolved rather than guessed:
// putting a 2023 price on the wrong printing is worse than not putting it on.

export interface ResolvedPurchaseLine {
  line: PurchaseLine;
  printing: Printing | null;
  /** The card's name as the card DB has it (or the file's, when unresolved). */
  name: string;
  /** The finish to record: the line's, unless this printing doesn't come in it. */
  finish: Finish;
  /** Why it couldn't be resolved. */
  problem?: string;
}

/** "052" and "52" are the same card; "108e" is CardTrader's etched suffix. */
const numberForms = (n: string): string[] => {
  const base = n.trim().toLowerCase().replace(/^0+(?=\w)/, '');
  return base.endsWith('e') && /\d/.test(base) ? [base, base.slice(0, -1)] : [base];
};

const nameKeys = (o: OracleCard): string[] => {
  const keys = [normalizeName(o.name)];
  if (o.name.includes(' // ')) keys.push(normalizeName(o.name.split(' // ')[0]!));
  return keys;
};

/** Words worth comparing in a set name ("Commander: The Lord of the Rings"). */
const setWords = (s: string): Set<string> =>
  new Set(
    normalizeName(s)
      .split(' ')
      .filter((w) => w.length > 2 && !['the', 'and', 'of', 'commander', 'decks', 'collectors', 'edition'].includes(w)),
  );

/** A marketplace set code and the parent codes it may stand for (CMAT → mat, FDNS → fdn, XLTR → ltr). */
const codeForms = (code: string): string[] => {
  const c = code.toLowerCase();
  return [...new Set([c, c.slice(1), c.slice(0, -1)])].filter((x) => x.length >= 2);
};

function setScore(p: Printing, line: PurchaseLine): number {
  if (line.setCode && codeForms(line.setCode).includes(p.set)) return 2;
  if (!line.setName) return 0;
  const want = setWords(line.setName);
  if (!want.size) return 0;
  const have = setWords(p.setName);
  let hits = 0;
  for (const w of want) if (have.has(w)) hits++;
  return hits / want.size;
}

function finishFor(p: Printing, wanted: Finish): Finish {
  if (p.finishes.includes(wanted)) return wanted;
  // Foil and etched get mixed up between marketplaces; keep it shiny.
  if (wanted === 'etched' && p.finishes.includes('foil')) return 'foil';
  if (wanted === 'foil' && p.finishes.includes('etched')) return 'etched';
  return p.finishes[0] ?? wanted;
}

export async function resolvePurchase(order: PurchaseOrder): Promise<ResolvedPurchaseLine[]> {
  const ids = order.lines.flatMap((l) => (l.cardmarketId ? [l.cardmarketId] : []));
  const byCardmarket = ids.length ? await printingsByCardmarketId(ids) : new Map<number, Printing>();

  const setCache = new Map<string, Printing[]>();
  const inSet = async (code: string) => {
    if (!setCache.has(code)) setCache.set(code, await db.printings.where('set').equals(code).toArray());
    return setCache.get(code)!;
  };
  const oracleCache = new Map<string, OracleCard | undefined>();
  const oracle = async (id: string) => {
    if (!oracleCache.has(id)) oracleCache.set(id, await db.oracleCards.get(id));
    return oracleCache.get(id);
  };

  const out: ResolvedPurchaseLine[] = [];
  for (const line of order.lines) {
    const fileName = line.name ? cleanCardName(line.name) : '';
    const wantName = fileName ? normalizeName(fileName) : null;
    const unresolved = (problem: string): ResolvedPurchaseLine => ({
      line,
      printing: null,
      name: fileName || `Cardmarket product ${line.cardmarketId}`,
      finish: line.finish,
      problem,
    });
    const done = async (p: Printing): Promise<ResolvedPurchaseLine> => ({
      line,
      printing: p,
      name: (await oracle(p.oracleId))?.name ?? fileName,
      finish: finishFor(p, line.finish),
    });

    if (line.cardmarketId) {
      const p = byCardmarket.get(line.cardmarketId);
      out.push(p ? await done(p) : unresolved('No card in the card database has this Cardmarket product id'));
      continue;
    }

    const numbers = line.collectorNumber ? numberForms(line.collectorNumber) : [];

    // Set code + number. CardTrader files a set's extras under a code of its
    // own (CMAT, DCLB, FDNS), so the parent's code is tried too.
    if (line.setCode && numbers.length) {
      let hit: Printing | undefined;
      for (const c of codeForms(line.setCode)) {
        for (const p of await inSet(c)) {
          if (!numbers.includes(p.collectorNumber.toLowerCase())) continue;
          const o = await oracle(p.oracleId);
          if (wantName && o && !nameKeys(o).includes(wantName)) continue;
          hit = p;
          break;
        }
        if (hit) break;
      }
      if (hit) {
        out.push(await done(hit));
        continue;
      }
    }

    if (!wantName) {
      out.push(unresolved('The file names no card'));
      continue;
    }
    const front = fileName.split(' // ')[0]!;
    const oracles = [
      ...(await db.oracleCards.where('name').equalsIgnoreCase(fileName).toArray()),
      ...(await db.oracleCards.where('name').startsWithIgnoreCase(`${front} // `).toArray()),
    ];
    if (!oracles.length) {
      out.push(unresolved(`No card called "${fileName}"`));
      continue;
    }
    const printings = (await db.printings.where('oracleId').anyOf(oracles.map((o) => o.oracleId)).toArray()).filter(
      (p) => p.lang === 'en' || !p.lang,
    );
    // The List numbers its cards after where they came from ("ODY-313"), so
    // a reprint there shares the original's number and has to be counted too.
    const numbered = (p: Printing) => {
      const n = p.collectorNumber.toLowerCase();
      return numbers.some((want) => n === want || n.endsWith(`-${want}`));
    };
    const byNumber = numbers.length ? printings.filter(numbered) : [];
    const pool = byNumber.length ? byNumber : printings;
    const ranked = pool.map((p) => ({ p, score: setScore(p, line) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    // Trust a number match the set agrees with, or the only printing with that
    // number when the file gives no set code to disagree with it. Without a
    // number, only a set that clearly matches.
    const unique = byNumber.length === 1;
    const trusted = byNumber.length ? best!.score > 0 || (unique && !line.setCode) : (best?.score ?? 0) >= 1;
    if (best && trusted) {
      out.push(await done(best.p));
    } else {
      out.push(
        unresolved(
          byNumber.length
            ? `Several printings of ${fileName} are numbered ${line.collectorNumber}`
            : `Couldn't tell which printing of ${fileName} this is`,
        ),
      );
    }
  }
  return out;
}
