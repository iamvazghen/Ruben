/**
 * Purchases from a bank or card statement export (CSV). Column names are
 * matched across languages, only money going out is a purchase, and each line
 * gets a category from the owner's own past choices first, keywords second.
 */
import { parseCsv, parseDate, parseNumber } from '../importer/parse.js';
import { newId, spendingStore, subscriptionStore, type Purchase } from './store.js';

const norm = (h: string) => h.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

const COLUMNS: Record<string, string[]> = {
  date: ['date', 'datum', 'buchungstag', 'buchungsdatum', 'transactiondate', 'bookingdate', 'valuta', 'valutadatum', 'wertstellung', 'completeddate', 'starteddate'],
  amount: ['amount', 'betrag', 'betrageur', 'umsatz', 'value', 'sum', 'debit', 'soll'],
  currency: ['currency', 'wahrung', 'waehrung', 'ccy'],
  merchant: ['merchant', 'payee', 'beneficiary', 'counterparty', 'name', 'empfanger', 'empfaenger', 'zahlungsempfanger', 'zahlungsempfaenger', 'auftraggeberempfanger', 'beguenstigterzahlungspflichtiger', 'begunstigterzahlungspflichtiger', 'nameauftraggeberzahlungsempfanger'],
  description: ['description', 'reference', 'purpose', 'verwendungszweck', 'buchungstext', 'details', 'memo', 'text'],
};

/** Merchant keywords to a category: a starting point, overridden by the owner's own corrections. */
const KEYWORDS: [RegExp, string][] = [
  [/rewe|edeka|aldi|lidl|kaufland|netto|penny|carrefour|tesco|walmart|spar\b|billa|yerevan city|sas supermarket/i, 'groceries'],
  [/restaurant|cafe|coffee|starbucks|mcdonald|burger|pizza|lieferando|wolt|uber ?eats|deliveroo|doordash/i, 'dining'],
  [/\bdb\b|deutsche bahn|bvg|mvv|hvv|uber|bolt|lyft|taxi|ryanair|lufthansa|easyjet|flixbus|ticket/i, 'transport'],
  [/aral|shell|esso|total|jet\b|tankstelle|fuel|gas station/i, 'car'],
  [/apotheke|pharmacy|doctor|arzt|zahnarzt|clinic|hospital/i, 'health'],
  [/amazon|mediamarkt|saturn|apple store|ebay|otto/i, 'electronics'],
  [/h&m|zara|zalando|primark|uniqlo|c&a|about you/i, 'clothing'],
  [/ikea|bauhaus|obi|hornbach|toom/i, 'home'],
  [/vodafone|telekom|o2|1&1|stadtwerke|vattenfall|e\.on|eon\b|strom|gas\b|wasser|internet/i, 'utilities'],
  [/miete|rent\b|hausgeld|nebenkosten/i, 'housing'],
  [/allianz|huk|axa|ergo|versicherung|insurance/i, 'insurance'],
  [/netflix|spotify|disney|youtube|apple\.com|google|microsoft|adobe|dazn|audible|chatgpt|openai|anthropic/i, 'entertainment'],
  [/booking\.com|airbnb|hotel|expedia/i, 'travel'],
  [/dm-drogerie|\bdm\b|rossmann|douglas|friseur|barber/i, 'personal_care'],
  [/gym|fitness|mcfit|urban sports/i, 'sport'],
];

function pick(header: string[], name: keyof typeof COLUMNS): number {
  const keys = header.map(norm);
  return keys.findIndex((k) => COLUMNS[name]!.includes(k));
}

export function categorise(merchant: string, description: string, learned: Record<string, string>): string {
  const m = merchant.toLowerCase().trim();
  if (learned[m]) return learned[m]!;
  for (const [re, cat] of KEYWORDS) if (re.test(merchant) || re.test(description)) return cat;
  return 'other';
}

export interface StatementPreview {
  purchases: Purchase[];
  skipped_income: number;
  duplicates: number;
  linked_to_subscriptions: number;
  warnings: string[];
}

export function parseStatement(text: string, opts: { currency: string; account?: string; payment_method?: string }): StatementPreview {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  // The header is the first row that names a date and an amount column (banks put account info above it).
  const h = rows.findIndex((r) => pick(r, 'date') >= 0 && pick(r, 'amount') >= 0);
  if (h < 0) return { purchases: [], skipped_income: 0, duplicates: 0, linked_to_subscriptions: 0, warnings: ['No date and amount columns found: is this a bank or card statement CSV?'] };
  const header = rows[h]!;
  const col = { date: pick(header, 'date'), amount: pick(header, 'amount'), currency: pick(header, 'currency'), merchant: pick(header, 'merchant'), description: pick(header, 'description') };
  if (col.merchant < 0) warnings.push('No payee column: the description is used as the merchant.');

  const store = spendingStore.read();
  const seen = new Set(store.purchases.map((p) => `${p.date}|${p.amount}|${p.merchant.toLowerCase()}`));
  const subs = subscriptionStore.read().subscriptions.filter((s) => s.status !== 'cancelled');
  const out: Purchase[] = [];
  let income = 0, duplicates = 0, linked = 0;

  for (const r of rows.slice(h + 1)) {
    const date = parseDate(r[col.date]);
    const value = parseNumber(r[col.amount]);
    if (!date || !Number.isFinite(value)) continue;
    if (value >= 0) { income++; continue; }
    const amount = Math.round(-value * 100) / 100;
    const description = (col.description >= 0 ? r[col.description] : '') ?? '';
    const merchant = ((col.merchant >= 0 ? r[col.merchant] : '') || description.split(/\s{2,}|\//)[0] || 'unknown').trim();
    const key = `${date}|${amount}|${merchant.toLowerCase()}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const sub = subs.find((s) => {
      const hay = `${merchant} ${description}`.toLowerCase();
      return (hay.includes(s.provider.toLowerCase()) || hay.includes(s.name.toLowerCase())) && Math.abs(amount - s.amount) <= s.amount * 0.15;
    });
    if (sub) linked++;
    out.push({
      id: newId('p'), date, amount,
      currency: (col.currency >= 0 && r[col.currency]) || opts.currency,
      merchant, description, category: sub?.category ?? categorise(merchant, description, store.merchant_categories),
      payment_method: opts.payment_method, account: opts.account, subscription_id: sub?.id,
    });
  }
  return { purchases: out, skipped_income: income, duplicates, linked_to_subscriptions: linked, warnings };
}
