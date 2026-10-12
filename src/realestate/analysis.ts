/**
 * Real estate held directly: the property, its mortgages and what they earn,
 * person-agnostic (any country, any currency). Pure functions; the store and
 * the tools sit on top.
 */

export interface Mortgage {
  lender?: string;
  /** Outstanding principal on `balance_date`. */
  balance: number;
  balance_date: string;
  /** Nominal annual interest rate in percent. */
  rate_pct: number;
  /** Monthly instalment, interest plus repayment (annuity). */
  monthly_payment: number;
  /** End of the rate fixation, when the loan must be refinanced at the market rate. */
  fixed_until?: string;
  original_principal?: number;
}

export type PropertyUse = 'rented' | 'vacant' | 'owner_occupied';

export interface Property {
  id: string;
  name: string;
  type: 'apartment' | 'house' | 'multi_family' | 'commercial' | 'land' | 'parking' | 'other';
  /** ISO 3166 alpha-2. Drives which market data applies. */
  country: string;
  city: string;
  postcode?: string;
  size_m2?: number;
  year_built?: number;
  currency: string;
  purchase_date?: string;
  purchase_price?: number;
  /** Transfer tax, notary, broker: part of the cost basis. */
  purchase_costs?: number;
  /** Share of the price that is land, which is not depreciated. */
  land_share_pct?: number;
  /** Latest valuation, dated and sourced, so a stale one is visible. */
  value?: { amount: number; as_of: string; source: string };
  use: PropertyUse;
  /** Net cold rent per month, excluding service charges the tenant reimburses. */
  rent_monthly?: number;
  lease_start?: string;
  last_rent_increase?: string;
  /** Costs the owner carries per month: management, maintenance reserve, non-recoverable fees. */
  costs_monthly?: number;
  property_tax_annual?: number;
  insurance_annual?: number;
  /** Local market rent per m² for comparable units, dated and sourced. */
  market_rent_m2?: { amount: number; as_of: string; source: string };
  /** Annual tax depreciation of the building share, in percent (DE: 2, 3 for buildings finished after 2022). */
  depreciation_rate_pct?: number;
  mortgages: Mortgage[];
  notes?: string;
}

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
export const monthsBetween = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / (DAY * 30.4375)));

/** Run an annuity forward `months` months. Returns the balance and what was paid as interest and principal. */
export function amortize(balance: number, ratePct: number, payment: number, months: number) {
  const r = ratePct / 100 / 12;
  let interest = 0;
  let principal = 0;
  for (let i = 0; i < months && balance > 0; i++) {
    const int = balance * r;
    const pay = Math.min(payment, balance + int);
    interest += int;
    principal += pay - int;
    balance -= pay - int;
  }
  return { balance: Math.max(0, balance), interest, principal };
}

/** Months until the loan is repaid at this rate and instalment; Infinity when the instalment does not cover interest. */
export function monthsToPayoff(balance: number, ratePct: number, payment: number): number {
  const r = ratePct / 100 / 12;
  if (balance <= 0) return 0;
  if (r === 0) return Math.ceil(balance / payment);
  if (payment <= balance * r) return Infinity;
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}

export interface PropertyReview {
  id: string;
  name: string;
  currency: string;
  value: number | null;
  debt: number;
  equity: number | null;
  ltv_pct: number | null;
  rent_annual: number;
  operating_costs_annual: number;
  noi_annual: number;
  debt_service_annual: number;
  interest_next_12m: number;
  principal_next_12m: number;
  cash_flow_annual: number;
  gross_yield_pct: number | null;
  net_yield_pct: number | null;
  cash_on_cash_pct: number | null;
  rent_m2: number | null;
  market_rent_m2: number | null;
  rent_gap_pct: number | null;
  refinancing: { lender?: string; fixed_until: string; months_left: number; balance_then: number; extra_interest_per_year_at_market: number | null }[];
  payoff_months: number | null;
  flags: string[];
}

/**
 * Everything an owner should know about one property today. `marketRatePct`
 * is the current mortgage rate where it stands, to price the refinancing.
 */
export function reviewProperty(p: Property, today: string, marketRatePct?: number | null): PropertyReview {
  const flags: string[] = [];
  const loans = p.mortgages.map((m) => {
    const now = amortize(m.balance, m.rate_pct, m.monthly_payment, monthsBetween(m.balance_date, today));
    const year = amortize(now.balance, m.rate_pct, m.monthly_payment, 12);
    return { m, balance: now.balance, year };
  });
  const debt = loans.reduce((s, l) => s + l.balance, 0);
  const value = p.value?.amount ?? p.purchase_price ?? null;
  const rent = p.use === 'rented' ? (p.rent_monthly ?? 0) * 12 : 0;
  const costs = (p.costs_monthly ?? 0) * 12 + (p.property_tax_annual ?? 0) + (p.insurance_annual ?? 0);
  const noi = rent - costs;
  const service = p.mortgages.reduce((s, m) => s + m.monthly_payment * 12, 0);
  const interest = loans.reduce((s, l) => s + l.year.interest, 0);
  const principal = loans.reduce((s, l) => s + l.year.principal, 0);
  const cashFlow = noi - service;
  const borrowed = p.mortgages.reduce((s, m) => s + (m.original_principal ?? 0), 0);
  const ownCash = p.purchase_price != null && borrowed > 0 ? p.purchase_price + (p.purchase_costs ?? 0) - borrowed : null;
  const rentM2 = p.rent_monthly && p.size_m2 ? p.rent_monthly / p.size_m2 : null;
  const marketM2 = p.market_rent_m2?.amount ?? null;
  const gap = rentM2 && marketM2 ? ((rentM2 - marketM2) / marketM2) * 100 : null;

  const refinancing = loans
    .filter((l) => l.m.fixed_until)
    .map((l) => {
      const months = monthsBetween(today, l.m.fixed_until!);
      const then = amortize(l.balance, l.m.rate_pct, l.m.monthly_payment, months).balance;
      const extra = marketRatePct == null ? null : r2(then * (marketRatePct - l.m.rate_pct) / 100);
      if (months <= 24 && extra != null && extra > 0) {
        flags.push(`${l.m.lender ?? 'loan'}: fixation ends ${l.m.fixed_until} (${months} months); at today's ${marketRatePct}% that is about ${r2(extra)} ${p.currency} more interest a year`);
      }
      return { lender: l.m.lender, fixed_until: l.m.fixed_until!, months_left: months, balance_then: r2(then), extra_interest_per_year_at_market: extra };
    });

  const payoff = loans.length
    ? Math.max(...loans.map((l) => monthsToPayoff(l.balance, l.m.rate_pct, l.m.monthly_payment)))
    : 0;
  if (payoff === Infinity) flags.push('an instalment does not cover the interest: the debt grows');
  if (p.use === 'rented' && cashFlow < 0) flags.push(`negative cash flow: ${r2(cashFlow)} ${p.currency} a year after debt service`);
  if (p.use === 'vacant') flags.push('vacant: no rent while costs and debt service run');
  if (value && debt / value > 0.8) flags.push(`loan-to-value ${r2((debt / value) * 100)}%: thin equity cushion`);
  if (gap != null && gap < -10) flags.push(`rent ${r2(-gap)}% below the local market per m² — check what local rent law allows before raising it`);
  if (!p.value) flags.push('no current valuation: value shown is the purchase price');
  else if (Date.parse(today) - Date.parse(p.value.as_of) > 365 * DAY) flags.push(`valuation is from ${p.value.as_of}: refresh it`);
  if (p.market_rent_m2 && Date.parse(today) - Date.parse(p.market_rent_m2.as_of) > 365 * DAY) flags.push('market rent per m² is over a year old');

  return {
    id: p.id, name: p.name, currency: p.currency,
    value, debt: r2(debt),
    equity: value == null ? null : r2(value - debt),
    ltv_pct: value ? r2((debt / value) * 100) : null,
    rent_annual: r2(rent), operating_costs_annual: r2(costs), noi_annual: r2(noi),
    debt_service_annual: r2(service), interest_next_12m: r2(interest), principal_next_12m: r2(principal),
    cash_flow_annual: r2(cashFlow),
    gross_yield_pct: value && rent ? r2((rent / value) * 100) : null,
    net_yield_pct: value && rent ? r2((noi / value) * 100) : null,
    cash_on_cash_pct: ownCash && ownCash > 0 ? r2((cashFlow / ownCash) * 100) : null,
    rent_m2: rentM2 == null ? null : r2(rentM2),
    market_rent_m2: marketM2,
    rent_gap_pct: gap == null ? null : r2(gap),
    refinancing,
    payoff_months: payoff === Infinity ? null : payoff,
    flags,
  };
}

/**
 * Taxable rental result for a calendar year: rent less interest, running
 * costs and building depreciation. Interest is the loan's own amortisation for
 * that year, from the recorded balance; a sale or refinancing inside the year
 * is not modelled and the result says so.
 */
export function rentalResult(p: Property, year: number) {
  const start = `${year}-01-01`;
  const months = p.use === 'rented' ? 12 : 0;
  let interest = 0;
  for (const m of p.mortgages) {
    const toStart = amortize(m.balance, m.rate_pct, m.monthly_payment, monthsBetween(m.balance_date, start));
    interest += amortize(toStart.balance, m.rate_pct, m.monthly_payment, 12).interest;
  }
  const rent = (p.rent_monthly ?? 0) * months;
  const costs = (p.costs_monthly ?? 0) * 12 + (p.property_tax_annual ?? 0) + (p.insurance_annual ?? 0);
  const basis = ((p.purchase_price ?? 0) + (p.purchase_costs ?? 0)) * (1 - (p.land_share_pct ?? 0) / 100);
  const bought = p.purchase_date ? Number(p.purchase_date.slice(0, 4)) : Infinity;
  // The purchase year counts pro rata from the month of purchase (DE § 7 Abs. 1 S. 4 EStG; common elsewhere).
  const share = bought < year ? 1 : bought === year ? (13 - Number(p.purchase_date!.slice(5, 7))) / 12 : 0;
  const depreciation = p.depreciation_rate_pct ? (basis * p.depreciation_rate_pct * share) / 100 : 0;
  return {
    id: p.id, name: p.name, currency: p.currency,
    rent: r2(rent), interest: r2(interest), costs: r2(costs), depreciation: r2(depreciation),
    result: r2(rent - interest - costs - depreciation),
  };
}
