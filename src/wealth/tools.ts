/**
 * The owner's whole financial position in one place: securities, cash
 * reserve, real estate equity, recurring commitments, and the income all of
 * it produces over the next twelve months. Person-agnostic: every amount is
 * converted to the owner's base currency.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { jsonFile } from '../utils/json-store.js';
import { baseCurrency } from '../utils/locale.js';
import { yahoo, type MarketData } from '../market/yahoo.js';
import { valueHoldings, buildProposal } from '../rebalance/check.js';
import { incomeStore } from '../income/store.js';
import { refreshIncome } from '../income/refresh.js';
import { allocate, planFor, type YieldAction } from '../income/plan.js';
import { reviewProperty } from '../realestate/analysis.js';
import { realEstateStore } from '../realestate/tools.js';

export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'yearly' | 'once';

export interface Commitment {
  id: string;
  name: string;
  kind: 'savings_plan' | 'loan' | 'capital_call' | 'insurance' | 'subscription' | 'other';
  amount: number;
  currency: string;
  frequency: Frequency;
  /** What the money goes into: a ticker, a property id, a fund. */
  target?: string;
  start?: string;
  end?: string;
  /** `once` only: when it is due. */
  due?: string;
  notes?: string;
}

const PER_YEAR: Record<Frequency, number> = { monthly: 12, quarterly: 4, semiannual: 2, yearly: 1, once: 0 };
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export const commitmentStore = jsonFile<{ commitments: Commitment[] }>('commitments.json', { commitments: [] });

/** Cash a commitment takes over the next twelve months from `from`. */
export function nextTwelveMonths(c: Commitment, from: string): number {
  const start = Date.parse(from);
  const end = start + 365 * DAY;
  if (c.end && Date.parse(c.end) < start) return 0;
  if (c.frequency === 'once') return c.due && Date.parse(c.due) >= start && Date.parse(c.due) < end ? c.amount : 0;
  let share = 1;
  if (c.end && Date.parse(c.end) < end) share = (Date.parse(c.end) - start) / (365 * DAY);
  if (c.start && Date.parse(c.start) > start) share = Math.min(share, (end - Date.parse(c.start)) / (365 * DAY));
  return c.amount * PER_YEAR[c.frequency] * Math.max(0, share);
}

async function toBase(market: MarketData, currency: string): Promise<number | null> {
  return currency.toUpperCase() === baseCurrency().toUpperCase() ? 1 : market.rate(currency, baseCurrency());
}

export const commitmentsTool = new DynamicStructuredTool({
  name: 'commitments',
  description:
    "The owner's recurring and one-off financial commitments: savings plans, loan payments other than mortgages (those come from the properties), capital calls, insurance, subscriptions. `show` totals the next 12 months in the base currency. add/remove are durable: confirm with the owner first.",
  schema: z.object({
    action: z.enum(['show', 'add', 'remove']),
    id: z.string().optional().describe('For remove'),
    commitment: z.object({
      name: z.string(),
      kind: z.enum(['savings_plan', 'loan', 'capital_call', 'insurance', 'subscription', 'other']),
      amount: z.number().positive(),
      currency: z.string(),
      frequency: z.enum(['monthly', 'quarterly', 'semiannual', 'yearly', 'once']),
      target: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      due: z.string().optional(),
      notes: z.string().optional(),
    }).optional().describe('For add'),
  }),
  func: async ({ action, id, commitment }) => {
    const store = commitmentStore.read();
    if (action === 'add') {
      if (!commitment) return formatToolResult({ error: 'commitment is required for add' });
      const c: Commitment = { ...commitment, id: `${commitment.kind}-${Date.now().toString(36)}` };
      store.commitments.push(c);
      commitmentStore.write(store);
      return formatToolResult({ added: c });
    }
    if (action === 'remove') {
      const before = store.commitments.length;
      store.commitments = store.commitments.filter((c) => c.id !== id);
      commitmentStore.write(store);
      return formatToolResult(before === store.commitments.length ? { error: `no commitment ${id}` } : { removed: id });
    }
    const rows = [];
    let total = 0;
    for (const c of store.commitments) {
      const fx = await toBase(yahoo, c.currency);
      const next12 = nextTwelveMonths(c, today());
      const base = fx == null ? null : r2(next12 * fx);
      if (base != null) total += base;
      rows.push({ ...c, next_12_months: r2(next12), next_12_months_base: base });
    }
    return formatToolResult({ base_currency: baseCurrency(), commitments: rows, total_next_12_months: r2(total) });
  },
});

/** The 12-month income calendar, with the plan's split of every payment. */
async function incomeNextYear() {
  if (!incomeStore.calendar().refreshed_at) await refreshIncome({ market: yahoo });
  const now = Date.now();
  const events = incomeStore.calendar().events.filter(
    (e) => e.status !== 'paid' && e.status !== 'skipped' && Date.parse(e.payDate) >= now - DAY && Date.parse(e.payDate) <= now + 365 * DAY,
  );
  const plan = incomeStore.plan();
  const byAction: Record<YieldAction, number> = { reinvest: 0, reserve: 0, withdraw: 0, repurpose: 0 };
  const byHolding = new Map<string, { gross: number; net: number; payments: number; cut: boolean; cutRisk?: number }>();
  const byMonth = new Map<string, number>();
  for (const e of events) {
    for (const a of allocate(e.tax.net, planFor(plan, e.ticker).parts)) byAction[a.action] += a.amount;
    const h = byHolding.get(e.ticker) ?? { gross: 0, net: 0, payments: 0, cut: false };
    h.gross += e.gross; h.net += e.tax.net; h.payments += 1;
    if (e.previousPerShare && e.perShare < e.previousPerShare) h.cut = true;
    if (e.cutRisk != null) h.cutRisk = Math.max(h.cutRisk ?? 0, e.cutRisk);
    byHolding.set(e.ticker, h);
    byMonth.set(e.payDate.slice(0, 7), (byMonth.get(e.payDate.slice(0, 7)) ?? 0) + e.tax.net);
  }
  return { events, byAction, byHolding, byMonth };
}

export const incomeForecastTool = new DynamicStructuredTool({
  name: 'income_forecast',
  description:
    "Dividends, fund distributions and coupons expected over the next 12 months: per month and per holding, gross and net of all tax, flagged cuts, what was already received this year, and how the owner's yield plan splits it (reinvest / reserve / withdraw / repurpose). With rebalancing targets set, it also says where the reinvested part should go to move the portfolio back toward target. Before recommending specific buys, check the market (ecb_policy_rate for what cash earns, grade_ticker for candidates).",
  schema: z.object({ refresh: z.boolean().optional().describe('Re-fetch dividend data first (slower)') }),
  func: async ({ refresh }) => {
    if (refresh) await refreshIncome({ market: yahoo });
    const { events, byAction, byHolding, byMonth } = await incomeNextYear();
    const year = new Date().getFullYear();
    const received = incomeStore.ledger().entries.filter((e) => e.confirmedAt.startsWith(String(year)));
    const gross = events.reduce((s, e) => s + e.gross, 0);
    const net = events.reduce((s, e) => s + e.tax.net, 0);
    const toPlace = byAction.reinvest + byAction.repurpose;
    let deployment: unknown = 'No rebalancing targets set: set them (rebalance_targets) to get a recommendation for where reinvested income should go.';
    // buildProposal already counts the next 30 days of reinvested income; pass only the rest.
    const plan = incomeStore.plan();
    const soon = events.filter((e) => Date.parse(e.payDate) <= Date.now() + 30 * DAY).reduce((s, e) => s + e.tax.net * planFor(plan, e.ticker).parts
      .filter((x) => x.action === 'reinvest' || x.action === 'repurpose').reduce((a, x) => a + x.pct, 0) / 100, 0);
    const proposal = toPlace > 0 ? await buildProposal(Math.max(0, toPlace - soon), yahoo) : null;
    if (proposal) {
      deployment = {
        cash_to_place: r2(toPlace - soon + proposal.incomeCash),
        buys: proposal.proposal.trades.filter((t) => t.side === 'buy' && t.funded_by !== 'sales').map((t) => ({ bucket: t.key, ticker: t.ticker, amount: t.amount })),
        drift: proposal.proposal.drifts.map((d) => ({ bucket: d.key, weight_pct: d.weight_pct, target_pct: d.target_pct })),
        note: 'Buys are with new cash only, so no sale and no tax. Underweight buckets are filled first.',
      };
    }
    return formatToolResult({
      base_currency: baseCurrency(),
      next_12_months: { gross: r2(gross), net: r2(net), payments: events.length, estimated: events.filter((e) => e.status === 'estimated').length },
      by_month: Object.fromEntries([...byMonth].map(([m, v]) => [m, r2(v)])),
      by_holding: [...byHolding].map(([ticker, h]) => ({ ticker, gross: r2(h.gross), net: r2(h.net), payments: h.payments, cut_flagged: h.cut, cut_probability: h.cutRisk }))
        .sort((a, b) => b.net - a.net),
      received_this_year: { payments: received.length, net: r2(received.reduce((s, e) => s + e.net, 0)) },
      plan_split: Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, r2(v)])),
      deployment,
    });
  },
});

export const wealthOverviewTool = new DynamicStructuredTool({
  name: 'wealth_overview',
  description:
    "The owner's whole position in the base currency: securities by asset type and largest holdings, cash reserve, real estate value, debt and equity, net worth and how it is split across asset classes, income expected over 12 months (investment income net of tax, rent net of costs), and the cash the commitments and mortgages take. Flags concentration and gaps. Use it before any allocation advice.",
  schema: z.object({}),
  func: async () => {
    const market = yahoo;
    const flags: string[] = [];
    const { holdings, missing } = await valueHoldings(market);
    if (missing.length) flags.push(`no price for ${missing.join(', ')}: left out of the totals`);
    const securities = holdings.reduce((s, h) => s + h.value, 0);
    const byType: Record<string, number> = {};
    for (const h of holdings) byType[h.position.asset_type ?? 'stock'] = (byType[h.position.asset_type ?? 'stock'] ?? 0) + h.value;
    const largest = [...holdings].sort((a, b) => b.value - a.value).slice(0, 10)
      .map((h) => ({ ticker: h.position.ticker, value: r2(h.value), weight_pct: securities ? r2((h.value / securities) * 100) : 0 }));
    for (const h of largest) {
      const type = holdings.find((x) => x.position.ticker === h.ticker)?.position.asset_type;
      if (type !== 'etf' && type !== 'cash' && h.weight_pct > 10) flags.push(`${h.ticker} is ${h.weight_pct}% of securities: single-name concentration`);
    }
    const reserve = incomeStore.ledger().reserve;

    let reValue = 0, reDebt = 0, reNoi = 0, reService = 0;
    for (const p of realEstateStore.read().properties) {
      const fx = await toBase(market, p.currency);
      if (fx == null) { flags.push(`no ${p.currency} rate: ${p.name} left out`); continue; }
      const r = reviewProperty(p, today());
      reValue += (r.value ?? 0) * fx; reDebt += r.debt * fx; reNoi += r.noi_annual * fx; reService += r.debt_service_annual * fx;
      for (const f of r.flags) flags.push(`${p.name}: ${f}`);
    }
    const reEquity = reValue - reDebt;

    let commitments = 0;
    for (const c of commitmentStore.read().commitments) {
      const fx = await toBase(market, c.currency);
      if (fx != null) commitments += nextTwelveMonths(c, today()) * fx;
    }
    const { events } = await incomeNextYear();
    const investmentIncome = events.reduce((s, e) => s + e.tax.net, 0);

    const netWorth = securities + reserve + reEquity;
    const classes: Record<string, number> = { ...byType, cash_reserve: reserve, real_estate_equity: reEquity };
    if (netWorth > 0 && reEquity / netWorth > 0.6) flags.push(`real estate is ${r2((reEquity / netWorth) * 100)}% of net worth: illiquid and concentrated`);
    if (netWorth > 0 && reserve / netWorth < 0.03 && reService > 0) flags.push('cash reserve is under 3% of net worth while mortgages are running');

    return formatToolResult({
      base_currency: baseCurrency(), as_of: today(),
      net_worth: r2(netWorth),
      allocation_pct: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, netWorth ? r2((v / netWorth) * 100) : 0])),
      securities: { value: r2(securities), by_asset_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, r2(v)])), largest },
      cash_reserve: r2(reserve),
      real_estate: { value: r2(reValue), debt: r2(reDebt), equity: r2(reEquity), net_operating_income_annual: r2(reNoi), debt_service_annual: r2(reService) },
      next_12_months: {
        investment_income_net: r2(investmentIncome),
        rental_noi: r2(reNoi),
        mortgage_payments: r2(reService),
        other_commitments: r2(commitments),
        surplus_before_salary_and_living_costs: r2(investmentIncome + reNoi - reService - commitments),
      },
      flags,
    });
  },
});
