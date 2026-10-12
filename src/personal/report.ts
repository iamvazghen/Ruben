/**
 * Monthly, quarterly and annual results: income, spending, subscriptions and
 * what is left, against the previous period and the same period last year,
 * with the places where cost can be cut. Everything in the base currency.
 */
import { baseCurrency } from '../utils/locale.js';
import { yahoo } from '../market/yahoo.js';
import { incomeStore } from '../income/store.js';
import { realEstateStore } from '../realestate/tools.js';
import { commitmentStore } from '../wealth/tools.js';
import { budgetStore, salaryStore, spendingStore, subscriptionStore, type Purchase, type Subscription } from './store.js';
import { chargesBetween, inPeriod, lastYearPeriod, parsePeriod, PER_YEAR, previousPeriod, type Period } from './periods.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? r2(((a - b) / Math.abs(b)) * 100) : null);
const monthsIn = (p: Period, from?: string) => {
  if (!from || from <= p.start) return p.months;
  if (from >= p.end) return 0;
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ey, em] = [Number(p.end.slice(0, 4)), Number(p.end.slice(5, 7))];
  return Math.max(0, (ey - fy) * 12 + (em - fm));
};

/** Units of base per one unit of `currency`, fetched once per currency. */
export async function rates(currencies: Iterable<string>): Promise<(c: string) => number> {
  const base = baseCurrency().toUpperCase();
  const map = new Map<string, number>();
  for (const c of new Set([...currencies].map((x) => x.toUpperCase()))) {
    map.set(c, c === base ? 1 : (await yahoo.rate(c, base)) ?? NaN);
  }
  return (c) => map.get(c.toUpperCase()) ?? NaN;
}

export interface Totals {
  period: Period;
  salary_gross: number;
  salary_net: number;
  salary_tax_and_social: number;
  investment_income: number;
  rental_income: number;
  income_total: number;
  spending: number;
  subscriptions: number;
  mortgage_payments: number;
  other_commitments: number;
  expenses_total: number;
  net_cash_flow: number;
  savings_rate_pct: number | null;
  invested: number;
  by_category: Record<string, number>;
  by_merchant: Record<string, number>;
  purchases: Purchase[];
  subscription_charges: { sub: Subscription; amount: number; count: number }[];
}

export function totalsFor(p: Period, fx: (c: string) => number): Totals {
  const slips = salaryStore.read().payslips.filter((s) => inPeriod(s.pay_date, p));
  const salaryGross = slips.reduce((s, x) => s + x.gross * fx(x.currency), 0);
  const salaryNet = slips.reduce((s, x) => s + x.net * fx(x.currency), 0);

  const investment = incomeStore.ledger().entries
    .filter((e) => inPeriod(e.confirmedAt.slice(0, 10), p))
    .reduce((s, e) => s + e.net, 0);

  let rental = 0, mortgage = 0;
  for (const prop of realEstateStore.read().properties) {
    const months = monthsIn(p, prop.purchase_date);
    if (prop.use === 'rented') rental += (prop.rent_monthly ?? 0) * months * fx(prop.currency);
    mortgage += prop.mortgages.reduce((s, m) => s + m.monthly_payment, 0) * months * fx(prop.currency);
  }

  let invested = 0, otherCommitments = 0;
  for (const c of commitmentStore.read().commitments) {
    if (c.end && c.end < p.start) continue;
    const amount = c.frequency === 'once'
      ? (c.due && inPeriod(c.due, p) ? c.amount : 0)
      : c.amount * PER_YEAR[c.frequency] * monthsIn(p, c.start) / 12;
    if (c.kind === 'savings_plan' || c.kind === 'capital_call') invested += amount * fx(c.currency);
    else otherCommitments += amount * fx(c.currency);
  }

  const purchases = spendingStore.read().purchases.filter((x) => inPeriod(x.date, p) && !x.subscription_id);
  const byCategory: Record<string, number> = {};
  const byMerchant: Record<string, number> = {};
  for (const x of purchases) {
    const v = x.amount * fx(x.currency);
    byCategory[x.category] = (byCategory[x.category] ?? 0) + v;
    byMerchant[x.merchant] = (byMerchant[x.merchant] ?? 0) + v;
  }
  const spending = purchases.reduce((s, x) => s + x.amount * fx(x.currency), 0);

  const subscriptionCharges = subscriptionStore.read().subscriptions.map((sub) => {
    const charges = chargesBetween(sub, p.start, p.end);
    return { sub, amount: charges.reduce((s, c) => s + c.amount, 0) * fx(sub.currency), count: charges.length };
  }).filter((c) => c.count > 0);
  const subscriptions = subscriptionCharges.reduce((s, c) => s + c.amount, 0);

  const income = salaryNet + investment + rental;
  const expenses = spending + subscriptions + mortgage + otherCommitments;
  return {
    period: p,
    salary_gross: r2(salaryGross), salary_net: r2(salaryNet), salary_tax_and_social: r2(salaryGross - salaryNet),
    investment_income: r2(investment), rental_income: r2(rental), income_total: r2(income),
    spending: r2(spending), subscriptions: r2(subscriptions), mortgage_payments: r2(mortgage), other_commitments: r2(otherCommitments),
    expenses_total: r2(expenses), net_cash_flow: r2(income - expenses),
    savings_rate_pct: income > 0 ? r2(((income - expenses) / income) * 100) : null,
    invested: r2(invested),
    by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, r2(v)])),
    by_merchant: Object.fromEntries(Object.entries(byMerchant).map(([k, v]) => [k, r2(v)])),
    purchases, subscription_charges: subscriptionCharges,
  };
}

export const SUMMARY_METRICS: [keyof Totals, string][] = [
  ['salary_gross', 'Salary, gross'],
  ['salary_tax_and_social', 'Salary tax and social contributions'],
  ['salary_net', 'Salary, net'],
  ['investment_income', 'Investment income, net'],
  ['rental_income', 'Rental income'],
  ['income_total', 'Total income (net)'],
  ['spending', 'Purchases'],
  ['subscriptions', 'Subscriptions'],
  ['mortgage_payments', 'Mortgage payments'],
  ['other_commitments', 'Other commitments'],
  ['expenses_total', 'Total expenses'],
  ['net_cash_flow', 'Net cash flow'],
  ['savings_rate_pct', 'Savings rate %'],
  ['invested', 'Invested (savings plans, capital calls)'],
];

export interface Report {
  base_currency: string;
  period: Period;
  previous: Period;
  last_year: Period;
  summary: { metric: string; current: number | null; previous: number | null; change: number | null; change_pct: number | null; last_year: number | null; yoy_pct: number | null }[];
  categories: { category: string; current: number; previous: number; change_pct: number | null; last_year: number; yoy_pct: number | null; budget: number | null; over_budget: number | null }[];
  merchants: { merchant: string; amount: number; share_pct: number }[];
  transactions: (Purchase & { amount_base: number })[];
  subscriptions: { name: string; provider: string; category: string; status: string; cycle: string; amount: number; currency: string; in_period: number; monthly_equivalent: number; annual_equivalent: number; next_renewal: string; usage: string; notice_days: number | null; price_change: string }[];
  payslips: { pay_date: string; employer: string; period: string; gross: number; net: number; income_tax: number; social: number; bonus: number; currency: string }[];
  suggestions: string[];
}

export async function buildReport(spec: string, now = new Date()): Promise<Report> {
  const p = parsePeriod(spec, now);
  const prev = previousPeriod(p);
  const ly = lastYearPeriod(p);
  const currencies = [
    ...spendingStore.read().purchases.map((x) => x.currency),
    ...subscriptionStore.read().subscriptions.map((x) => x.currency),
    ...salaryStore.read().payslips.map((x) => x.currency),
    ...realEstateStore.read().properties.map((x) => x.currency),
    ...commitmentStore.read().commitments.map((x) => x.currency),
    baseCurrency(),
  ];
  const fx = await rates(currencies);
  const [cur, before, year] = [totalsFor(p, fx), totalsFor(prev, fx), totalsFor(ly, fx)];

  const summary = SUMMARY_METRICS.map(([key, metric]) => {
    const [c, b, y] = [cur[key], before[key], year[key]] as (number | null)[];
    return { metric, current: c, previous: b, change: c != null && b != null ? r2(c - b) : null, change_pct: c != null && b != null ? pct(c, b) : null, last_year: y, yoy_pct: c != null && y != null ? pct(c, y) : null };
  });

  const budgets = budgetStore.read().budgets;
  const cats = new Set([...Object.keys(cur.by_category), ...Object.keys(before.by_category), ...budgets.map((b) => b.category).filter((c) => c !== 'subscriptions')]);
  const categories = [...cats].map((category) => {
    const c = cur.by_category[category] ?? 0, b = before.by_category[category] ?? 0, y = year.by_category[category] ?? 0;
    const bud = budgets.find((x) => x.category === category);
    const limit = bud ? r2(bud.monthly_limit * p.months * fx(bud.currency)) : null;
    return { category, current: c, previous: b, change_pct: pct(c, b), last_year: y, yoy_pct: pct(c, y), budget: limit, over_budget: limit != null && c > limit ? r2(c - limit) : null };
  }).sort((a, b) => b.current - a.current);

  const merchants = Object.entries(cur.by_merchant).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([merchant, amount]) => ({ merchant, amount, share_pct: cur.spending ? r2((amount / cur.spending) * 100) : 0 }));

  const subscriptions = subscriptionStore.read().subscriptions.map((s) => {
    const inPer = cur.subscription_charges.find((c) => c.sub.id === s.id)?.amount ?? 0;
    const monthly = s.status === 'cancelled' || s.status === 'paused' ? 0 : (s.amount * PER_YEAR[s.cycle]) / 12 * fx(s.currency);
    const hist = s.price_history ?? [];
    const first = hist[0]?.amount;
    return {
      name: s.name, provider: s.provider, category: s.category, status: s.status, cycle: s.cycle,
      amount: s.amount, currency: s.currency, in_period: r2(inPer),
      monthly_equivalent: r2(monthly), annual_equivalent: r2(monthly * 12),
      next_renewal: s.next_renewal, usage: s.usage ?? '', notice_days: s.notice_days ?? null,
      price_change: first && first !== s.amount ? `${first} → ${s.amount} (${pct(s.amount, first)}%)` : '',
    };
  });

  const payslips = salaryStore.read().payslips.filter((s) => inPeriod(s.pay_date, p)).map((s) => ({
    pay_date: s.pay_date, employer: s.employer, period: s.period, gross: s.gross, net: s.net,
    income_tax: s.income_tax ?? 0, social: Object.values(s.social ?? {}).reduce((a, b) => a + b, 0), bonus: s.bonus ?? 0, currency: s.currency,
  }));

  return {
    base_currency: baseCurrency(), period: p, previous: prev, last_year: ly,
    summary, categories, merchants,
    transactions: cur.purchases.sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ ...x, amount_base: r2(x.amount * fx(x.currency)) })),
    subscriptions, payslips,
    suggestions: suggest(cur, before, categories, subscriptions),
  };
}

/** Where money can be saved, largest first. Facts, not nagging: each line carries its number. */
export function suggest(cur: Totals, prev: Totals, categories: Report['categories'], subs: Report['subscriptions']): string[] {
  const out: { saving: number; text: string }[] = [];
  const floor = Math.max(20, cur.spending * 0.02);
  for (const c of categories) {
    if (c.over_budget) out.push({ saving: c.over_budget, text: `${c.category}: ${c.over_budget} over budget (${c.current} against ${c.budget}).` });
    const grew = c.current - c.previous;
    if (c.previous > 0 && grew > floor && (c.change_pct ?? 0) > 20) out.push({ saving: grew, text: `${c.category} rose ${c.change_pct}% on the previous period (+${r2(grew)}).` });
    const yoy = c.current - c.last_year;
    if (c.last_year > 0 && yoy > floor && (c.yoy_pct ?? 0) > 20) out.push({ saving: yoy, text: `${c.category} is ${c.yoy_pct}% above the same period last year (+${r2(yoy)}).` });
  }
  for (const s of subs.filter((s) => s.status === 'active' || s.status === 'trial')) {
    if (s.usage === 'never' || s.usage === 'rarely') out.push({ saving: s.annual_equivalent, text: `${s.name} is used ${s.usage} and costs ${s.annual_equivalent} a year: cancel or downgrade${s.notice_days ? ` (notice ${s.notice_days} days before ${s.next_renewal})` : ''}.` });
    if (s.price_change) out.push({ saving: 0, text: `${s.name} price changed ${s.price_change}: check for a cheaper plan or a competitor.` });
    if (s.cycle === 'monthly' && s.annual_equivalent > 60) out.push({ saving: s.annual_equivalent * 0.15, text: `${s.name} is billed monthly (${s.annual_equivalent} a year): yearly billing is often 15-20% cheaper.` });
  }
  const byCat = new Map<string, string[]>();
  for (const s of subs.filter((s) => s.status === 'active')) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s.name]);
  for (const [cat, names] of byCat) if (names.length > 1) out.push({ saving: 0, text: `${names.length} active ${cat} subscriptions (${names.join(', ')}): is each one needed?` });
  if (cur.savings_rate_pct != null && cur.savings_rate_pct < 10) out.push({ saving: 0, text: `Savings rate ${cur.savings_rate_pct}%: under 10% leaves little room for investing or shocks.` });
  if (cur.salary_net && prev.salary_net && cur.salary_net < prev.salary_net * 0.97) out.push({ saving: 0, text: `Net salary fell from ${prev.salary_net} to ${cur.salary_net}: check the payslips (tax class, deductions, missing bonus).` });
  return out.sort((a, b) => b.saving - a.saving).map((o) => o.text);
}
