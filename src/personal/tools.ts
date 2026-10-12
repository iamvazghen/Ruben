import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { baseCurrency } from '../utils/locale.js';
import {
  budgetStore, CATEGORIES, newId, salaryStore, spendingStore, subscriptionStore,
  type Payslip, type Purchase, type Subscription,
} from './store.js';
import { addCycles, nextRenewal, parsePeriod, PER_YEAR, inPeriod } from './periods.js';
import { rates } from './report.js';
import { runReportCommand } from './commands.js';
import { sendFilesToOwner } from './deliver.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- salary

export const salaryTool = new DynamicStructuredTool({
  name: 'salary',
  description:
    "The owner's employment income. add_employer / add_payslip / remove record it (durable: confirm the figures first; read them off the payslip the owner gives). show: per employer and year the gross, income tax, social contributions, net, deduction rate and average monthly net, the change on the previous year, bonuses, payslips missing this year, and gross against the contract.",
  schema: z.object({
    action: z.enum(['show', 'add_employer', 'add_payslip', 'remove']),
    id: z.string().optional().describe('For remove: an employer or payslip id'),
    employer: z.object({
      name: z.string(), currency: z.string(), country: z.string().optional(), role: z.string().optional(),
      start: z.string().optional(), end: z.string().optional(), gross_annual: z.number().optional(), notes: z.string().optional(),
    }).optional(),
    payslip: z.object({
      employer: z.string().describe('Employer id or name'), period: z.string().describe('YYYY-MM the pay is for'),
      pay_date: z.string(), currency: z.string(), gross: z.number(), net: z.number(),
      income_tax: z.number().optional(), social: z.record(z.string(), z.number()).optional().describe('e.g. {"pension":186,"health":146}'),
      other_deductions: z.number().optional(), bonus: z.number().optional(), notes: z.string().optional(),
    }).optional(),
  }),
  func: async ({ action, id, employer, payslip }) => {
    const store = salaryStore.read();
    if (action === 'add_employer') {
      if (!employer) return formatToolResult({ error: 'employer is required' });
      const e = { ...employer, id: newId('emp') };
      store.employers.push(e);
      salaryStore.write(store);
      return formatToolResult({ added: e });
    }
    if (action === 'add_payslip') {
      if (!payslip) return formatToolResult({ error: 'payslip is required' });
      const emp = store.employers.find((e) => e.id === payslip.employer || e.name.toLowerCase() === payslip.employer.toLowerCase());
      if (!emp) return formatToolResult({ error: `no employer "${payslip.employer}": add it first`, employers: store.employers.map((e) => e.name) });
      const p: Payslip = { ...payslip, employer: emp.id, id: newId('pay') };
      const known = (p.income_tax ?? 0) + Object.values(p.social ?? {}).reduce((a, b) => a + b, 0) + (p.other_deductions ?? 0);
      const warning = known && Math.abs(p.gross - known - p.net) > 1 ? `gross - deductions = ${r2(p.gross - known)} but net is ${p.net}: check the figures` : undefined;
      store.payslips.push(p);
      salaryStore.write(store);
      return formatToolResult({ added: p, warning });
    }
    if (action === 'remove') {
      const before = store.employers.length + store.payslips.length;
      store.employers = store.employers.filter((e) => e.id !== id);
      store.payslips = store.payslips.filter((p) => p.id !== id);
      salaryStore.write(store);
      return formatToolResult(before === store.employers.length + store.payslips.length ? { error: `no ${id}` } : { removed: id });
    }
    const year = new Date().getFullYear();
    const employers = store.employers.map((e) => {
      const slips = store.payslips.filter((p) => p.employer === e.id);
      const years = [...new Set(slips.map((p) => Number(p.pay_date.slice(0, 4))))].sort();
      const byYear = years.map((y) => {
        const s = slips.filter((p) => p.pay_date.startsWith(String(y)));
        const gross = s.reduce((a, p) => a + p.gross, 0), net = s.reduce((a, p) => a + p.net, 0);
        const tax = s.reduce((a, p) => a + (p.income_tax ?? 0), 0);
        const social = s.reduce((a, p) => a + Object.values(p.social ?? {}).reduce((x, v) => x + v, 0), 0);
        return { year: y, payslips: s.length, gross: r2(gross), income_tax: r2(tax), social: r2(social), net: r2(net),
          deduction_rate_pct: gross ? r2(((gross - net) / gross) * 100) : null, avg_monthly_net: s.length ? r2(net / s.length) : 0,
          bonus: r2(s.reduce((a, p) => a + (p.bonus ?? 0), 0)) };
      });
      byYear.forEach((y, i) => {
        const prev = byYear[i - 1];
        (y as Record<string, unknown>).avg_monthly_net_change_pct = prev?.avg_monthly_net ? r2(((y.avg_monthly_net - prev.avg_monthly_net) / prev.avg_monthly_net) * 100) : null;
      });
      const have = new Set(slips.map((p) => p.period));
      const lastMonth = new Date().getMonth(); // months already finished this year
      const startMonth = e.start?.startsWith(String(year)) ? Number(e.start.slice(5, 7)) : 1;
      const missing = Array.from({ length: Math.max(0, lastMonth - startMonth + 1) }, (_, i) => `${year}-${String(startMonth + i).padStart(2, '0')}`)
        .filter((m) => !have.has(m) && !e.end);
      const latest = [...slips].sort((a, b) => b.pay_date.localeCompare(a.pay_date))[0];
      return {
        ...e, by_year: byYear, latest_payslip: latest, missing_payslips_this_year: missing,
        contract_vs_paid: e.gross_annual && latest ? { contract_monthly: r2(e.gross_annual / 12), latest_gross_excl_bonus: r2(latest.gross - (latest.bonus ?? 0)) } : undefined,
      };
    });
    return formatToolResult({ employers, note: 'Real growth: compare the net change with inflation (ecb_hicp / get_economic_indicators).' });
  },
});

// ---------------------------------------------------------------- spending

const purchaseFields = z.object({
  date: z.string(), amount: z.number().positive(), currency: z.string().optional(),
  merchant: z.string().describe('Shop, company or person paid'), description: z.string().describe('What was bought'),
  items: z.array(z.object({ name: z.string(), qty: z.number().optional(), price: z.number().optional() })).optional(),
  category: z.string().optional().describe(`One of: ${CATEGORIES.join(', ')}`),
  payment_method: z.string().optional(), account: z.string().optional(), location: z.string().optional(),
  receipt: z.string().optional(), tags: z.array(z.string()).optional(), notes: z.string().optional(),
});

export const spendingTool = new DynamicStructuredTool({
  name: 'spending',
  description:
    "The owner's purchases: date, amount, merchant, what was bought (and items), category, payment method, receipt. add/update/remove are durable: confirm with the owner. list filters by period (2026-09, 2026-Q3, 2026, last_month…), category or merchant and totals it. set_category corrects a purchase's category and remembers it for that merchant. budget_set / budget_show manage monthly limits per category. Bank statements are imported with /spending <file> or by sending the CSV to the Telegram bot.",
  schema: z.object({
    action: z.enum(['add', 'update', 'remove', 'list', 'set_category', 'budget_set', 'budget_show']),
    id: z.string().optional(),
    purchase: purchaseFields.partial().optional(),
    period: z.string().optional(), category: z.string().optional(), merchant: z.string().optional(),
    monthly_limit: z.number().optional().describe('budget_set; 0 removes the budget'),
  }),
  func: async ({ action, id, purchase, period, category, merchant, monthly_limit }) => {
    const store = spendingStore.read();
    if (action === 'add') {
      const p = purchaseFields.safeParse(purchase);
      if (!p.success) return formatToolResult({ error: 'date, amount, merchant and description are required', issues: p.error.issues.map((i) => i.path.join('.')) });
      const learned = store.merchant_categories[p.data.merchant.toLowerCase().trim()];
      const row: Purchase = { ...p.data, id: newId('p'), currency: p.data.currency ?? baseCurrency(), category: p.data.category ?? learned ?? 'other' };
      store.purchases.push(row);
      spendingStore.write(store);
      return formatToolResult({ added: row, category_needs_review: !p.data.category && !learned });
    }
    const i = store.purchases.findIndex((p) => p.id === id);
    if (action === 'update' || action === 'remove' || action === 'set_category') {
      if (i < 0) return formatToolResult({ error: `no purchase ${id}` });
      if (action === 'remove') store.purchases.splice(i, 1);
      else if (action === 'update') store.purchases[i] = { ...store.purchases[i]!, ...purchase } as Purchase;
      else {
        if (!category) return formatToolResult({ error: 'category is required' });
        store.purchases[i]!.category = category;
        store.merchant_categories[store.purchases[i]!.merchant.toLowerCase().trim()] = category;
      }
      spendingStore.write(store);
      return formatToolResult({ ok: true, purchase: store.purchases[i] });
    }
    if (action === 'budget_set') {
      if (!category || monthly_limit == null) return formatToolResult({ error: 'category and monthly_limit are required' });
      const b = budgetStore.read();
      b.budgets = b.budgets.filter((x) => x.category !== category);
      if (monthly_limit > 0) b.budgets.push({ category, monthly_limit, currency: baseCurrency() });
      budgetStore.write(b);
      return formatToolResult({ budgets: b.budgets });
    }
    if (action === 'budget_show') {
      const month = parsePeriod('this_month');
      const fx = await rates(store.purchases.map((p) => p.currency));
      const spent = (c: string) => store.purchases.filter((p) => p.category === c && inPeriod(p.date, month) && !p.subscription_id).reduce((s, p) => s + p.amount * fx(p.currency), 0);
      return formatToolResult({ month: month.id, budgets: budgetStore.read().budgets.map((b) => ({ ...b, spent: r2(spent(b.category)), left: r2(b.monthly_limit - spent(b.category)) })) });
    }
    const p = period ? parsePeriod(period) : null;
    const rows = store.purchases.filter((x) => (!p || inPeriod(x.date, p)) && (!category || x.category === category)
      && (!merchant || x.merchant.toLowerCase().includes(merchant.toLowerCase())))
      .sort((a, b) => b.date.localeCompare(a.date));
    const fx = await rates(rows.map((x) => x.currency));
    const byCat: Record<string, number> = {};
    for (const x of rows) byCat[x.category] = r2((byCat[x.category] ?? 0) + x.amount * fx(x.currency));
    return formatToolResult({ period: p?.id ?? 'all', count: rows.length, total_base: r2(rows.reduce((s, x) => s + x.amount * fx(x.currency), 0)), by_category: byCat, purchases: rows.slice(0, 200), truncated: rows.length > 200 });
  },
});

// ---------------------------------------------------------------- subscriptions

const subFields = z.object({
  name: z.string(), provider: z.string(), category: z.string().describe('e.g. entertainment, software, news, fitness, cloud, telecom, insurance'),
  plan: z.string().optional(), amount: z.number().positive(), currency: z.string(),
  cycle: z.enum(['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly']),
  start_date: z.string().describe('First billing date'), next_renewal: z.string().optional(),
  status: z.enum(['active', 'trial', 'paused', 'cancelled']).optional(), trial_ends: z.string().optional(),
  notice_days: z.number().optional(), commitment_until: z.string().optional(),
  payment_method: z.string().optional(), account: z.string().optional(), account_email: z.string().optional(),
  cancel_url: z.string().optional(), shared_with: z.array(z.string()).optional(),
  usage: z.enum(['daily', 'weekly', 'monthly', 'rarely', 'never']).optional(), notes: z.string().optional(),
});

/** Keep next_renewal current: billing dates that passed roll forward. */
function refreshed(s: Subscription): Subscription {
  return s.status === 'cancelled' ? s : { ...s, next_renewal: nextRenewal(s, today()) };
}

export const subscriptionsTool = new DynamicStructuredTool({
  name: 'subscriptions',
  description:
    "Every subscription the owner pays: provider, plan, price and price history, billing cycle, next renewal, trial end, notice period and cancel-by date, minimum term, payment method, account email, cancel link, who it is shared with, how often it is used. show: monthly and yearly cost, renewals in the next 30 days, trials ending, cancel-by deadlines, price rises, rarely used ones and overlaps. add/update/cancel/remove are durable: confirm first. A changed amount is recorded in the price history.",
  schema: z.object({
    action: z.enum(['show', 'add', 'update', 'cancel', 'remove']),
    id: z.string().optional(),
    subscription: subFields.partial().optional(),
    cancelled_at: z.string().optional().describe('cancel: last day of access (default the next renewal)'),
  }),
  func: async ({ action, id, subscription, cancelled_at }) => {
    const store = subscriptionStore.read();
    if (action === 'add') {
      const p = subFields.safeParse(subscription);
      if (!p.success) return formatToolResult({ error: 'missing fields', issues: p.error.issues.map((i) => i.path.join('.')) });
      const s: Subscription = { ...p.data, id: newId('sub'), status: p.data.status ?? (p.data.trial_ends ? 'trial' : 'active'), next_renewal: p.data.next_renewal ?? '', price_history: [{ date: p.data.start_date, amount: p.data.amount }] };
      s.next_renewal = p.data.next_renewal ?? nextRenewal(s, today());
      store.subscriptions.push(s);
      subscriptionStore.write(store);
      return formatToolResult({ added: s });
    }
    const i = store.subscriptions.findIndex((s) => s.id === id || s.name.toLowerCase() === (id ?? '').toLowerCase());
    if (action !== 'show') {
      if (i < 0) return formatToolResult({ error: `no subscription ${id}`, names: store.subscriptions.map((s) => `${s.id} ${s.name}`) });
      const s = store.subscriptions[i]!;
      if (action === 'remove') store.subscriptions.splice(i, 1);
      if (action === 'cancel') {
        const lastDay = cancelled_at ?? nextRenewal(s, today());
        const deadline = s.notice_days ? plusDays(nextRenewal(s, today()), -s.notice_days) : null;
        store.subscriptions[i] = { ...s, status: 'cancelled', cancelled_at: lastDay };
        subscriptionStore.write(store);
        return formatToolResult({ cancelled: store.subscriptions[i], reminder: `RUBEN records it; the owner still has to cancel with ${s.provider}${s.cancel_url ? ` (${s.cancel_url})` : ''}${deadline ? `, before ${deadline}` : ''}.` });
      }
      if (action === 'update') {
        const next = { ...s, ...subscription } as Subscription;
        if (subscription?.amount != null && subscription.amount !== s.amount) next.price_history = [...(s.price_history ?? []), { date: today(), amount: subscription.amount }];
        store.subscriptions[i] = next;
      }
      subscriptionStore.write(store);
      return formatToolResult({ ok: true, subscription: store.subscriptions[i] ?? null });
    }

    const all = store.subscriptions.map(refreshed);
    subscriptionStore.write({ subscriptions: all });
    const fx = await rates(all.map((s) => s.currency));
    const live = all.filter((s) => s.status === 'active' || s.status === 'trial');
    const monthly = (s: Subscription) => (s.amount * PER_YEAR[s.cycle]) / 12 * fx(s.currency);
    const t = today(), in30 = plusDays(t, 30);
    const rows = live.map((s) => {
      const cancelBy = s.notice_days ? plusDays(s.next_renewal, -s.notice_days) : s.next_renewal;
      const first = s.price_history?.[0]?.amount;
      return { ...s, monthly_base: r2(monthly(s)), yearly_base: r2(monthly(s) * 12), cancel_by: cancelBy,
        locked_until: s.commitment_until && s.commitment_until > t ? s.commitment_until : undefined,
        price_rise_pct: first && first !== s.amount ? r2(((s.amount - first) / first) * 100) : undefined };
    }).sort((a, b) => b.yearly_base - a.yearly_base);
    const byCat = new Map<string, string[]>();
    for (const s of live) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s.name]);
    return formatToolResult({
      base_currency: baseCurrency(), active: rows.length,
      total_monthly: r2(rows.reduce((a, s) => a + s.monthly_base, 0)), total_yearly: r2(rows.reduce((a, s) => a + s.yearly_base, 0)),
      subscriptions: rows,
      renewing_next_30_days: rows.filter((s) => s.next_renewal <= in30).map((s) => ({ name: s.name, date: s.next_renewal, amount: s.amount, currency: s.currency })),
      trials_ending: rows.filter((s) => s.trial_ends && s.trial_ends >= t && s.trial_ends <= plusDays(t, 14)).map((s) => ({ name: s.name, trial_ends: s.trial_ends, then: `${s.amount} ${s.currency}/${s.cycle}` })),
      cancel_deadlines_next_30_days: rows.filter((s) => s.cancel_by >= t && s.cancel_by <= in30).map((s) => ({ name: s.name, cancel_by: s.cancel_by })),
      rarely_used: rows.filter((s) => s.usage === 'rarely' || s.usage === 'never').map((s) => ({ name: s.name, yearly: s.yearly_base })),
      price_rises: rows.filter((s) => s.price_rise_pct).map((s) => ({ name: s.name, pct: s.price_rise_pct })),
      overlaps: [...byCat].filter(([, n]) => n.length > 1).map(([category, names]) => ({ category, names })),
      cancelled: all.filter((s) => s.status === 'cancelled').map((s) => ({ name: s.name, access_until: s.cancelled_at })),
      next_charge_dates: Object.fromEntries(rows.slice(0, 20).map((s) => [s.name, [s.next_renewal, addCycles(s.next_renewal, s.cycle, 1)]])),
    });
  },
});

// ---------------------------------------------------------------- reports

export const financeReportTool = new DynamicStructuredTool({
  name: 'finance_report',
  description:
    "Monthly, quarterly or annual results as a professional Excel workbook (and/or CSV): income (salary, investment, rent), purchases by category and merchant, subscriptions, mortgage and other commitments, net cash flow and savings rate — each against the previous period and the same period last year — plus every transaction, payslip and subscription, and a sheet of where costs can be cut. Set send_telegram to deliver the files to the owner's Telegram chat.",
  schema: z.object({
    period: z.string().describe('2026-09, 2026-Q3, 2026, this_month, last_month, last_quarter, last_year'),
    format: z.enum(['xlsx', 'csv', 'both']).optional(),
    send_telegram: z.boolean().optional(),
  }),
  func: async ({ period, format, send_telegram }) => {
    const { text, files } = await runReportCommand(`${period} ${format ?? 'xlsx'}`);
    if (!files.length) return formatToolResult({ error: text });
    const delivery = send_telegram ? await sendFilesToOwner(files, text.split('\n')[0]!) : undefined;
    return formatToolResult({ summary: text, files, telegram: delivery });
  },
});
