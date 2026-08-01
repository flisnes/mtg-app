import { getPrefs, notifyPrefsChanged, type BaseCurrency } from '../prefs.js';

// Currency conversion for display. Scryfall gives us EUR and USD; everything
// else is converted from those through European Central Bank daily reference
// rates, fetched from Frankfurter (frankfurter.dev — no API key, CORS open,
// ECB data). Rates move once a day, so one fetch per calendar day is plenty.
//
// We always ask for EUR-based rates regardless of the user's base currency: the
// response carries USD too, so both directions fall out of one request
// (eur→X = rates[X], usd→X = rates[X] / rates.USD). Nothing here is load-
// bearing — with no cached rates the app shows raw EUR/USD exactly as before.

const ENDPOINT = 'https://api.frankfurter.dev/v1/latest?base=EUR';
const STORAGE_KEY = 'fxRates';

/**
 * The 30 currencies the ECB publishes, in the order the picker shows them, each
 * with the locale it's written in. Amounts are formatted in the *currency's*
 * locale rather than the browser's, so a krone total groups the Norwegian way
 * ("kr 12 346") even in an English browser, and a yen total drops the decimals
 * yen never had. Israel gets en-IL, not he-IL: the Hebrew pattern carries RTL
 * marks that flip the surrounding text in our left-to-right lists.
 */
export const CURRENCIES: { code: string; name: string; locale: string }[] = [
  { code: 'EUR', name: 'Euro', locale: 'de-DE' },
  { code: 'USD', name: 'US dollar', locale: 'en-US' },
  { code: 'GBP', name: 'British pound', locale: 'en-GB' },
  { code: 'NOK', name: 'Norwegian krone', locale: 'nb-NO' },
  { code: 'SEK', name: 'Swedish krona', locale: 'sv-SE' },
  { code: 'DKK', name: 'Danish krone', locale: 'da-DK' },
  { code: 'ISK', name: 'Icelandic króna', locale: 'is-IS' },
  { code: 'CHF', name: 'Swiss franc', locale: 'de-CH' },
  { code: 'PLN', name: 'Polish złoty', locale: 'pl-PL' },
  { code: 'CZK', name: 'Czech koruna', locale: 'cs-CZ' },
  { code: 'HUF', name: 'Hungarian forint', locale: 'hu-HU' },
  { code: 'RON', name: 'Romanian leu', locale: 'ro-RO' },
  { code: 'TRY', name: 'Turkish lira', locale: 'tr-TR' },
  { code: 'CAD', name: 'Canadian dollar', locale: 'en-CA' },
  { code: 'AUD', name: 'Australian dollar', locale: 'en-AU' },
  { code: 'NZD', name: 'New Zealand dollar', locale: 'en-NZ' },
  { code: 'JPY', name: 'Japanese yen', locale: 'ja-JP' },
  { code: 'CNY', name: 'Chinese yuan', locale: 'zh-CN' },
  { code: 'HKD', name: 'Hong Kong dollar', locale: 'zh-HK' },
  { code: 'SGD', name: 'Singapore dollar', locale: 'en-SG' },
  { code: 'KRW', name: 'South Korean won', locale: 'ko-KR' },
  { code: 'INR', name: 'Indian rupee', locale: 'en-IN' },
  { code: 'IDR', name: 'Indonesian rupiah', locale: 'id-ID' },
  { code: 'MYR', name: 'Malaysian ringgit', locale: 'ms-MY' },
  { code: 'PHP', name: 'Philippine peso', locale: 'en-PH' },
  { code: 'THB', name: 'Thai baht', locale: 'th-TH' },
  { code: 'ILS', name: 'Israeli shekel', locale: 'en-IL' },
  { code: 'MXN', name: 'Mexican peso', locale: 'es-MX' },
  { code: 'BRL', name: 'Brazilian real', locale: 'pt-BR' },
  { code: 'ZAR', name: 'South African rand', locale: 'en-ZA' },
];

const KNOWN = new Map(CURRENCIES.map((c) => [c.code, c]));

export function isKnownCurrency(code: string): boolean {
  return KNOWN.has(code);
}

/** The locale a currency is written in; undefined (= the browser's) if we don't know it. */
export function localeFor(currency: string): string | undefined {
  return KNOWN.get(currency)?.locale;
}

interface RateCache {
  /** ECB reference date the rates carry, e.g. "2026-07-29". */
  date: string;
  /** EUR → code. Always includes USD; EUR itself is implicit (1). */
  rates: Record<string, number>;
  /** Local date we fetched on, so one failed day doesn't retry on every render. */
  fetchedOn: string;
}

let cache: RateCache | null | undefined; // undefined = not read from storage yet

function today(): string {
  // Local calendar day; toISOString would roll over at the wrong moment for
  // anyone west of UTC.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load(): RateCache | null {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as RateCache) : null;
    cache = parsed && parsed.rates && typeof parsed.rates === 'object' ? parsed : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** The cached rates, or null when we've never successfully fetched any. */
export function getRates(): RateCache | null {
  return load();
}

let inFlight: Promise<void> | null = null;

/**
 * Make sure today's rates are cached, if the user's settings need any. Silent
 * on failure: prices then render in the base currency, which is what a build
 * without this feature did anyway. Called once at boot and after a currency
 * change.
 */
export function ensureRates(): Promise<void> {
  const { displayCurrency, baseCurrency } = getPrefs();
  if (displayCurrency === baseCurrency) return Promise.resolve();
  const cached = load();
  if (cached?.fetchedOn === today()) return Promise.resolve();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' });
      if (!res.ok) throw new Error(`rates HTTP ${res.status}`);
      const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
      if (!body.rates || typeof body.rates.USD !== 'number') throw new Error('rates payload missing USD');
      cache = { date: body.date ?? today(), rates: body.rates, fetchedOn: today() };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
      } catch {
        /* quota — this session still has the rates in memory */
      }
      notifyPrefsChanged(); // re-render anything showing a converted price
    } catch {
      // Offline, blocked, or Frankfurter down. Keep whatever we had; the next
      // launch tries again.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** EUR → `code`, or null when we can't get there. */
function rateFromEur(code: string): number | null {
  if (code === 'EUR') return 1;
  const r = load()?.rates[code];
  return typeof r === 'number' && r > 0 ? r : null;
}

/**
 * Convert an amount in `from` to the display currency. Returns null when no
 * rate is available, so callers can fall back to showing the raw figure.
 */
export function convertToDisplay(amount: number, from: BaseCurrency): number | null {
  const { displayCurrency } = getPrefs();
  if (displayCurrency === from) return amount;
  const target = rateFromEur(displayCurrency);
  if (target == null) return null;
  if (from === 'EUR') return amount * target;
  const usdPerEur = rateFromEur('USD');
  if (usdPerEur == null) return null;
  return (amount / usdPerEur) * target;
}

/** True when the display currency is reachable — i.e. converted prices are showable. */
export function canConvert(): boolean {
  const { displayCurrency, baseCurrency } = getPrefs();
  if (displayCurrency === baseCurrency) return true;
  return rateFromEur(displayCurrency) != null && rateFromEur('USD') != null;
}

// narrowSymbol keeps "€12.34" / "kr 129" rather than "EUR 12.34"; constructing
// a NumberFormat is expensive enough to be worth caching per (currency, digits).
const fmtCache = new Map<string, Intl.NumberFormat | null>();

/** `digits: null` = let the currency decide (2 for euros, 0 for yen…). */
function formatter(currency: string, digits: number | null): Intl.NumberFormat | null {
  const key = `${currency}:${digits ?? 'auto'}`;
  if (fmtCache.has(key)) return fmtCache.get(key)!;
  const locale = localeFor(currency);
  const opts = digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  let f: Intl.NumberFormat | null = null;
  try {
    f = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...opts });
  } catch {
    try {
      // Engine without narrowSymbol support: the wide symbol still reads fine.
      f = new Intl.NumberFormat(locale, { style: 'currency', currency, ...opts });
    } catch {
      f = null; // unknown code — fmtMoney appends it by hand
    }
  }
  fmtCache.set(key, f);
  return f;
}

/**
 * Render an amount as money. Cents matter for single cards and small piles; a
 * five-figure collection total just wants a clean round number, which is the
 * rule the old fmtAmount used. Below that threshold the currency picks its own
 * precision, so yen and won don't sprout a decimal point they never use.
 */
export function fmtMoney(amount: number, currency: string): string {
  const digits = Math.abs(amount) >= 1000 ? 0 : null;
  const f = formatter(currency, digits);
  if (f) return f.format(amount);
  return `${amount.toFixed(digits ?? 2)} ${currency}`;
}

/** Minor-unit digits Intl uses for a currency — 2 for most, 0 for yen and friends. */
export function currencyDigits(currency: string): number {
  return formatter(currency, null)?.resolvedOptions().maximumFractionDigits ?? 2;
}

/** The symbol Intl renders for a currency ("€", "kr", "$"), or the code itself. */
export function currencySymbol(currency: string): string {
  const parts = formatter(currency, 0)?.formatToParts(0);
  return parts?.find((p) => p.type === 'currency')?.value ?? currency;
}

/** Convert and format in one step; null when no rate is available. */
export function fmtConverted(amount: number, from: BaseCurrency): string | null {
  const converted = convertToDisplay(amount, from);
  if (converted == null) return null;
  return fmtMoney(converted, getPrefs().displayCurrency);
}

/**
 * Format an amount already quoted in one of Scryfall's two currencies, using
 * the lowercase tag the price-history and movers code carries. Converts when a
 * rate is available, otherwise shows the original quote.
 */
export function fmtPriceIn(amount: number, cur: 'eur' | 'usd'): string {
  const from: BaseCurrency = cur === 'eur' ? 'EUR' : 'USD';
  return fmtConverted(amount, from) ?? fmtMoney(amount, from);
}

/**
 * Format an amount known to be in EUR — trade balances, recorded acquisition
 * prices, price history. Those stay EUR internally whatever the display
 * settings say, so only the presentation shifts.
 */
export function fmtEur(amount: number): string {
  return fmtPriceIn(amount, 'eur');
}

const plainCache = new Map<string, Intl.NumberFormat | null>();

/** An amount as a bare number in the currency's notation — no symbol, no grouping. */
function fmtPlain(amount: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (!plainCache.has(currency)) {
    let f: Intl.NumberFormat | null = null;
    try {
      f = new Intl.NumberFormat(localeFor(currency), {
        useGrouping: false,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      f = null;
    }
    plainCache.set(currency, f);
  }
  return plainCache.get(currency)?.format(amount) ?? amount.toFixed(digits);
}

/**
 * A typed amount, in any of the notations our currencies use: "12.34", "12,34",
 * grouped, or spaced. Null when there's no number in there — which the callers
 * treat the same as an empty field, i.e. "no price recorded".
 */
function parseAmount(text: string): number | null {
  // Spaces group in the Nordics (non-breaking ones at that), ’ in Switzerland.
  const cleaned = text.replace(/[\s\u00a0\u202f\u2019']/gu, '');
  if (!cleaned) return null;
  // Whichever of . or , comes last is the decimal mark; earlier ones group.
  const dec = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  const normalized =
    dec < 0 ? cleaned : `${cleaned.slice(0, dec).replace(/[.,]/g, '')}.${cleaned.slice(dec + 1)}`;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * How to take a typed price in and put it back out. Amounts are stored in EUR
 * whatever the settings say, but the user types in the currency they read
 * prices in — which is the display currency when a rate exists, EUR when not.
 */
export function moneyInput(): {
  currency: string;
  /** An EUR amount as the bare number the field shows. */
  text: (eur: number) => string;
  /** What the user typed, back in EUR; null when the field holds no number. */
  toEur: (text: string) => number | null;
} {
  const { displayCurrency } = getPrefs();
  const rate = displayCurrency === 'EUR' ? null : convertToDisplay(1, 'EUR');
  const currency = rate == null ? 'EUR' : displayCurrency;
  return {
    currency,
    text: (eur) => fmtPlain(rate == null ? eur : eur * rate, currency),
    toEur: (text) => {
      const n = parseAmount(text);
      return n == null ? null : rate == null ? n : n / rate;
    },
  };
}

/** "1 EUR = 10,998 NOK" for the settings screen; null when there's nothing to show. */
export function rateSummary(): { text: string; date: string } | null {
  const { displayCurrency, baseCurrency } = getPrefs();
  if (displayCurrency === baseCurrency) return null;
  const cached = load();
  const per = convertToDisplay(1, baseCurrency);
  if (!cached || per == null) return null;
  // The rate is a plain number, but it's a number *in* the display currency, so
  // it takes that currency's decimal mark: "10,998 NOK", not "10.998 NOK".
  const rate = new Intl.NumberFormat(localeFor(displayCurrency), { maximumFractionDigits: 4 }).format(per);
  return { text: `1 ${baseCurrency} = ${rate} ${displayCurrency}`, date: cached.date };
}
