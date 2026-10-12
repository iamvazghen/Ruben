/**
 * Read-at-a-glance money commands, answered by code from the same tools the
 * agent uses, identically in the CLI and on Telegram. Writing stays with the
 * agent (it confirms first) except for import/export, which preview first.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { money } from '../utils/locale.js';
import { wealthOverviewTool } from '../wealth/tools.js';
import { accountsTool, transferTool } from '../wealth/accounts.js';
import { portfolioAlertsTool, assetForecastTool } from '../wealth/analysis-tools.js';
import { propertyReview } from '../realestate/tools.js';
import { subscriptionsTool, salaryTool, spendingTool } from '../personal/tools.js';
import { taxYearSummaryTool } from '../tax/annual.js';
import { taxJurisdictionTool } from '../tax/knowledge.js';
import { valueHoldings } from '../rebalance/check.js';
import { yahoo } from '../market/yahoo.js';
import { applyImport, describePlan, exportData, pendingImport, planCsv, planWorkbook, DATASETS } from '../data/backup.js';

export { MONEY_COMMANDS } from './money-names.js';

/** Files a command produced, for the gateway to send as documents. */
export interface CommandResult { text: string; files?: string[] }

async function call<T = any>(tool: StructuredToolInterface, args: Record<string, unknown>): Promise<T> {
  const raw = await tool.invoke(args);
  return (JSON.parse(String(raw)).data ?? {}) as T;
}
const pct = (n: number | null | undefined) => (n == null ? '-' : `${n}%`);

export async function runMoneyCommand(name: string, args: string): Promise<CommandResult> {
  const a = args.trim();
  switch (name) {
    case 'networth': {
      const d = await call(wealthOverviewTool, {});
      const n = d.next_12_months ?? {};
      return { text: [
        `Net worth ${money(d.net_worth, d.base_currency)}`,
        `Allocation: ${Object.entries(d.allocation_pct ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k} ${v}%`).join(' · ') || 'nothing recorded'}`,
        `Securities ${money(d.securities?.value ?? 0)} · reserve ${money(d.cash_reserve ?? 0)} · property equity ${money(d.real_estate?.equity ?? 0)}`,
        `Next 12 months: salary ${money(n.salary_net_annualised ?? 0)}, investment income ${money(n.investment_income_net ?? 0)}, rent ${money(n.rental_noi ?? 0)}; out: living ${money(n.living_costs_last_12_months ?? 0)}, subscriptions ${money(n.subscriptions ?? 0)}, mortgages ${money(n.mortgage_payments ?? 0)}, commitments ${money(n.other_commitments ?? 0)} → surplus ${money(n.surplus ?? 0)}`,
        ...(d.flags ?? []).map((f: string) => `⚠ ${f}`),
      ].join('\n') };
    }
    case 'holdings': {
      const { holdings, missing } = await valueHoldings(yahoo);
      const total = holdings.reduce((s, h) => s + h.value, 0);
      const filter = a.toLowerCase();
      const rows = holdings.filter((h) => !filter || [h.position.account, h.position.asset_type, h.position.ticker].some((x) => (x ?? '').toLowerCase() === filter))
        .sort((x, y) => y.value - x.value)
        .map((h) => `${h.position.ticker.padEnd(10)} ${(h.position.asset_type ?? 'stock').padEnd(9)} ${String(h.position.shares).padStart(10)} ${money(h.value).padStart(14)} ${total ? ((h.value / total) * 100).toFixed(1).padStart(5) : '0'}%  ${h.position.account ?? '(no account)'}`);
      return { text: rows.length ? [`Holdings (${money(total)}):`, ...rows, ...(missing.length ? [`No price: ${missing.join(', ')}`] : [])].join('\n')
        : 'No holdings. Add them by telling RUBEN, /import a broker export, or /importsheet a RUBEN workbook.' };
    }
    case 'accounts': {
      const d = await call(accountsTool, { action: 'show' });
      return { text: [
        `Accounts (residence ${d.residence ?? 'not set'}):`,
        ...(d.accounts ?? []).map((x: any) => `${x.id.padEnd(16)} ${x.type.padEnd(9)} ${x.institution} (${x.country}${x.foreign ? ', foreign' : ''}) ${money(x.value_base)}`),
        'By jurisdiction:',
        ...Object.entries(d.by_jurisdiction ?? {}).map(([c, v]: [string, any]) => `  ${c.padEnd(10)} ${money(v.value)}${v.properties.length ? ` incl. ${v.properties.length} property` : ''}`),
        ...((d.unassigned_holdings ?? []).length ? [`Not tied to an account: ${d.unassigned_holdings.join(', ')}`] : []),
        ...((d.jurisdictions_without_tax_notes ?? []).length ? [`No tax research yet for: ${d.jurisdictions_without_tax_notes.join(', ')} (ask RUBEN to research them)`] : []),
      ].join('\n') };
    }
    case 'jurisdiction': {
      if (a.startsWith('set ')) {
        const code = a.slice(4).trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return { text: 'Usage: /jurisdiction set DE (an ISO country code)' };
        await call(taxJurisdictionTool, { action: 'set', residence: code });
      }
      const d = await call(taxJurisdictionTool, { action: 'show' });
      return { text: [
        `Tax residence: ${d.residence ?? 'not set — /jurisdiction set <country code>'}${d.residence_rules ? ` (${d.residence_rules.built_in ? 'built-in rules' : 'own rules'}, allowance ${d.residence_rules.allowance} ${d.residence_rules.currency})` : ''}`,
        ...(d.jurisdictions ?? []).map((j: any) => `${j.jurisdiction}${j.residence ? ' (residence)' : ''}: holds ${[...j.holds, ...(j.property ? ['property'] : [])].join(', ') || 'nothing'}; researched ${j.researched.length}; to research: ${j.to_research.join(', ') || 'nothing'}`),
        d.next,
      ].join('\n') };
    }
    case 'transfers': {
      const d = await call(transferTool, { action: 'list', from_date: a || undefined });
      return { text: [
        ...(d.transfers ?? []).slice(0, 30).map((t: any) => `${t.date} ${t.from} → ${t.to} ${t.amount} ${t.currency}${t.received_amount ? ` (${t.received_amount} ${t.received_currency})` : ''} ${t.purpose}`),
        ...(d.cross_border_flags ?? []).map((f: any) => `⚠ ${f.date} ${f.route} EUR ${f.eur}: ${f.note}`),
      ].join('\n') || 'No transfers recorded.' };
    }
    case 'subs': {
      const d = await call(subscriptionsTool, { action: 'show' });
      return { text: [
        `${d.active} subscriptions: ${money(d.total_monthly)} a month, ${money(d.total_yearly)} a year`,
        ...(d.subscriptions ?? []).map((s: any) => `${s.name.padEnd(20)} ${String(s.amount).padStart(8)} ${s.currency}/${s.cycle.padEnd(10)} next ${s.next_renewal}  cancel by ${s.cancel_by}${s.usage ? `  used ${s.usage}` : ''}`),
        ...(d.trials_ending ?? []).map((t: any) => `⚠ trial ${t.name} ends ${t.trial_ends}, then ${t.then}`),
        ...(d.rarely_used ?? []).map((t: any) => `⚠ ${t.name} rarely used: ${money(t.yearly)} a year`),
        ...(d.overlaps ?? []).map((o: any) => `⚠ ${o.names.length} in ${o.category}: ${o.names.join(', ')}`),
      ].join('\n') };
    }
    case 'salary': {
      const d = await call(salaryTool, { action: 'show' });
      const lines = (d.employers ?? []).flatMap((e: any) => [
        `${e.name}${e.role ? ` (${e.role})` : ''}`,
        ...e.by_year.map((y: any) => `  ${y.year}: gross ${y.gross}, tax ${y.income_tax}, social ${y.social}, net ${y.net} (${pct(y.deduction_rate_pct)} deducted), avg net/month ${y.avg_monthly_net}${y.avg_monthly_net_change_pct != null ? ` (${y.avg_monthly_net_change_pct > 0 ? '+' : ''}${y.avg_monthly_net_change_pct}%)` : ''}`),
        ...(e.missing_payslips_this_year.length ? [`  missing payslips: ${e.missing_payslips_this_year.join(', ')}`] : []),
      ]);
      return { text: lines.join('\n') || 'No salary recorded. Tell RUBEN your employer and send payslip figures.' };
    }
    case 'budget': {
      const d = await call(spendingTool, { action: 'budget_show' });
      return { text: (d.budgets ?? []).map((b: any) => `${b.category.padEnd(14)} ${b.spent} of ${b.monthly_limit} ${b.currency} (${b.left >= 0 ? `${b.left} left` : `${-b.left} over`})`).join('\n') || 'No budgets. Ask RUBEN to set one, e.g. "dining budget 250 a month".' };
    }
    case 'alerts': {
      const d = await call(portfolioAlertsTool, {});
      return { text: (d.alerts ?? []).map((x: any) => `${x.ticker} (${x.weight_pct}%): ${x.warnings.join('; ')}`).join('\n') || `No warnings on ${d.checked ?? 0} holdings.` };
    }
    case 'forecast': {
      if (!a) return { text: 'Usage: /forecast <symbol>, e.g. /forecast VWCE.DE or /forecast BTC-USD' };
      const d = await call(assetForecastTool, { symbol: a.split(/\s+/)[0] });
      if (d.error) return { text: `${a}: ${d.error}` };
      return { text: [
        `${d.symbol}: ${d.last_close?.close?.toFixed(2)} ${d.currency} · ${d.years_of_data} years of data · CAGR ${d.cagr_pct}% · volatility ${d.volatility_pct}% · worst drawdown ${d.max_drawdown_pct}%`,
        ...d.horizons.map((h: any) => `  ${h.years}y: ${h.p10} – ${h.p50} – ${h.p90} (P10/P50/P90)`),
        `A range from history (drift uncertainty ±${d.drift_std_error_pct}%/yr), not a prediction.`,
      ].join('\n') };
    }
    case 'property': {
      const d = await call(propertyReview, {});
      return { text: (d.reviews ?? []).map((r: any) => [
        `${r.name}: value ${r.value} ${r.currency}, debt ${r.debt}, equity ${r.equity} (LTV ${pct(r.ltv_pct)})`,
        `  rent ${r.rent_annual}/yr, net yield ${pct(r.net_yield_pct)}, cash flow ${r.cash_flow_annual}/yr, rent/m² ${r.rent_m2 ?? '-'} vs market ${r.market_rent_m2 ?? '-'}`,
        ...r.flags.map((f: string) => `  ⚠ ${f}`),
      ].join('\n')).join('\n') || d.note || 'No properties.' };
    }
    case 'taxyear': {
      const d = await call(taxYearSummaryTool, { year: a ? Number(a) : undefined });
      const s = d.sales ?? {};
      return { text: [
        `Tax year ${d.year} (residence ${d.residence ?? 'not set'}, ${d.base_currency})`,
        ...Object.entries(d.investment_income_by_jurisdiction ?? {}).map(([c, v]: [string, any]) => `  income held in ${c}: gross ${v.gross}, foreign tax ${v.foreign_tax_withheld}, net ${v.net}`),
        `  share sales: +${s.shares_gain} / -${s.shares_loss}; other: +${s.other_gain} / -${s.other_loss}`,
        ...(d.private_sales ? [`  crypto/commodity/private: within a year ${d.private_sales.short_term_net}, over a year ${d.private_sales.long_term_net}`] : []),
        ...(d.rentals ?? []).map((r: any) => `  ${r.name}: rental result ${r.result} ${r.currency}`),
        ...(d.planning?.ideas ?? []).map((i: string) => `  • ${i}`),
        ...(d.notes ?? []).map((n: string) => `  note: ${n}`),
      ].join('\n') };
    }
    case 'export': {
      const parts = a.split(/\s+/).filter(Boolean);
      const format = parts.includes('csv') ? 'csv' : 'xlsx';
      const names = parts.filter((p) => p !== 'csv' && p !== 'xlsx' && p !== 'all');
      const unknown = names.filter((n) => !DATASETS.some((d) => d.name === n));
      if (unknown.length) return { text: `Unknown: ${unknown.join(', ')}. Datasets: ${DATASETS.map((d) => d.name).join(', ')}` };
      const files = await exportData(names, format);
      return { text: `Exported ${names.length ? names.join(', ') : 'everything'} as ${format}:\n${files.join('\n')}`, files };
    }
    case 'importsheet': {
      if (a.startsWith('confirm')) return { text: applyImport(a.includes('replace') ? 'replace' : 'merge') };
      if (a === 'cancel') { pendingImport.write({ plan: null, file: '' }); return { text: 'Import cancelled.' }; }
      if (!a) return { text: 'Usage: /importsheet <file.xlsx|file.csv>, or send the file to the Telegram bot. Then /importsheet confirm.' };
      const path = a.replace(/^["']|["']$/g, '');
      try {
        return { text: await importSheetFromBytes(new Uint8Array(await readFile(path)), basename(path)) };
      } catch {
        return { text: `Cannot read "${path}".` };
      }
    }
  }
  return { text: `Unknown command ${name}` };
}

/** Preview a RUBEN workbook or dataset CSV; nothing changes until /importsheet confirm. */
export async function importSheetFromBytes(bytes: Uint8Array, file: string): Promise<string> {
  const plan = /\.xlsx$/i.test(file) ? await planWorkbook(bytes) : planCsv(new TextDecoder().decode(bytes), file);
  if (!plan) return `${file} is not a RUBEN dataset (expected a RUBEN export, or a CSV named ruben-<dataset>.csv).`;
  pendingImport.write({ plan, file });
  return describePlan(plan, file);
}

/** A CSV that is one of RUBEN's own datasets, by name or header. */
export const isRubenDatasetCsv = (text: string, file: string) => planCsv(text, file) != null;
