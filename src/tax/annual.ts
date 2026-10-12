/**
 * The figures an owner needs for a tax return, and what can still be done
 * before the year ends. RUBEN prepares; it does not file. Figures come from
 * RUBEN's own records (confirmed payments, closed positions, properties), so
 * the broker's annual tax statement stays the authority and the output says
 * where the two may differ.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { baseCurrency } from '../utils/locale.js';
import { yahoo } from '../market/yahoo.js';
import { incomeStore, allowanceLeft } from '../income/store.js';
import { jurisdictionFor } from '../income/jurisdictions.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { valueHoldings } from '../rebalance/check.js';
import { rentalResult } from '../realestate/analysis.js';
import { realEstateStore } from '../realestate/tools.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

async function fx(currency: string): Promise<number | null> {
  return currency.toUpperCase() === baseCurrency().toUpperCase() ? 1 : yahoo.rate(currency, baseCurrency());
}

/** Where each figure goes on a German return (field names, not line numbers: those move every year). */
const DE_FORMS = {
  foreign_broker_income: 'Anlage KAP: capital income not subject to German withholding (ausländische Kapitalerträge), with share-sale gains and losses in their own fields',
  foreign_funds: 'Anlage KAP-INV: fund distributions and sale gains from foreign custody, by fund type (equity funds get the 30 % Teilfreistellung)',
  foreign_tax: 'Anlage KAP: creditable foreign tax not yet credited (anrechenbare ausländische Steuern)',
  domestic_broker: "Domestic broker: tax already withheld; file Anlage KAP only to claim unused allowance, a lower personal rate (Günstigerprüfung) or to offset losses across brokers (needs the broker's loss certificate, requested by 15 December)",
  rental: 'Anlage V per property: rent received, mortgage interest (Schuldzinsen), depreciation (AfA), running and maintenance costs',
};

export const taxYearSummaryTool = new DynamicStructuredTool({
  name: 'tax_year_summary',
  description:
    "Prepare the investment and rental figures for a tax return for one calendar year: dividends and coupons (gross, foreign tax withheld, residence tax, allowance used) per account; realised gains and losses from sales (shares separate from other assets); rental result per property (rent less interest, costs and depreciation). For the current year it adds planning: allowance still unused, positions with unrealised losses that could offset gains, and gains that fit in the allowance. For a German resident it names the forms each figure goes on. Prepares only — it does not file. Cross-check with the brokers' annual tax statements.",
  schema: z.object({ year: z.number().int().optional().describe('Calendar year; default the current one') }),
  func: async ({ year }) => {
    const y = year ?? new Date().getFullYear();
    const profile = incomeStore.tax();
    const j = jurisdictionFor(profile.residence, profile.options);
    const notes: string[] = [];
    if (!profile.residence) notes.push('Tax residence not set (tax_profile): residence tax is not modelled.');

    // 1. Investment income: payments the owner confirmed as received.
    const ledger = incomeStore.ledger();
    const byAccount: Record<string, { domestic: boolean; payments: number; gross: number; foreign_tax_withheld: number; residence_tax: number; allowance_used: number; net: number }> = {};
    for (const e of ledger.entries.filter((e) => e.confirmedAt.startsWith(String(y)))) {
      const event = incomeStore.calendar().events.find((x) => x.id === e.eventId);
      const account = event?.account ?? 'default';
      const a = (byAccount[account] ??= { domestic: profile.accounts[account]?.domestic ?? false, payments: 0, gross: 0, foreign_tax_withheld: 0, residence_tax: 0, allowance_used: 0, net: 0 });
      a.payments += 1; a.gross += e.tax.gross; a.foreign_tax_withheld += e.tax.withholding; a.residence_tax += e.tax.residence_tax;
      a.allowance_used += e.tax.allowance_used; a.net += e.net;
    }
    const unconfirmed = incomeStore.calendar().events.filter(
      (e) => e.payDate.startsWith(String(y)) && Date.parse(e.payDate) < Date.now() && e.status !== 'paid' && e.status !== 'skipped',
    );
    if (unconfirmed.length) notes.push(`${unconfirmed.length} payment(s) dated ${y} not confirmed as received (${unconfirmed.map((e) => e.id).slice(0, 8).join(', ')}): check them against the broker statement.`);

    // 2. Realised gains and losses from closed positions.
    const sales = { shares_gain: 0, shares_loss: 0, other_gain: 0, other_loss: 0, count: 0 };
    for (const c of new PortfolioStore().read().closed.filter((c) => c.closed.startsWith(String(y)))) {
      const rate = await fx(c.currency);
      if (rate == null) { notes.push(`no ${c.currency} rate: sale of ${c.ticker} left out`); continue; }
      const pnl = c.realized_pnl * rate;
      const shares = (c.asset_type ?? 'stock') === 'stock';
      if (pnl >= 0) sales[shares ? 'shares_gain' : 'other_gain'] += pnl; else sales[shares ? 'shares_loss' : 'other_loss'] += -pnl;
      sales.count += 1;
    }
    if (sales.count) notes.push("Sale results use today's exchange rate; the law uses the rate on each trade date. The broker statement is authoritative.");

    // 3. Rental results.
    const rentals = [];
    for (const p of realEstateStore.read().properties) {
      const r = rentalResult(p, y);
      const rate = await fx(p.currency);
      rentals.push({ ...r, result_base: rate == null ? null : r2(r.result * rate) });
      if (!p.depreciation_rate_pct && p.use === 'rented') notes.push(`${p.name}: no depreciation rate set, so none is deducted`);
    }
    if (rentals.length) notes.push('Interest is computed from the recorded loan terms; use the bank\'s annual interest certificate for the return.');

    // 4. Planning, current year only.
    let planning: unknown = null;
    if (y === new Date().getFullYear()) {
      const { holdings } = await valueHoldings(yahoo);
      const unrealised = holdings.filter((h) => h.position.asset_type !== 'cash').map((h) => {
        const cost = h.position.shares * h.position.avg_cost * h.base_per_cost;
        return { ticker: h.position.ticker, account: h.position.account ?? 'default', type: h.position.asset_type ?? 'stock', gain: r2(h.value - cost) };
      });
      const allowance = Object.fromEntries(Object.keys(profile.accounts).map((a) => [a, r2(allowanceLeft(profile, ledger, a, y))]));
      const realisedNet = sales.shares_gain + sales.other_gain - sales.shares_loss - sales.other_loss;
      planning = {
        allowance_left_by_account: allowance,
        allowance_currency: j?.currency ?? null,
        realised_net_so_far: r2(realisedNet),
        loss_candidates: unrealised.filter((u) => u.gain < 0).sort((a, b) => a.gain - b.gain).slice(0, 10),
        gain_candidates_for_allowance: unrealised.filter((u) => u.gain > 0).sort((a, b) => a.gain - b.gain).slice(0, 10),
        ideas: [
          realisedNet > 0 ? 'Realised gains this year: selling a position at a loss before 31 December offsets them (in Germany share losses offset only share gains).' : null,
          Object.values(allowance).some((v) => v > 0) ? 'Unused allowance expires on 31 December: realising a gain up to it and buying back raises the cost basis tax-free (check wash-sale rules where they apply).' : null,
          'Never sell only for tax: check the position still fits the plan first.',
        ].filter(Boolean),
      };
    }

    return formatToolResult({
      year: y, base_currency: baseCurrency(), residence: profile.residence, jurisdiction: j?.name ?? null,
      investment_income_by_account: Object.fromEntries(Object.entries(byAccount).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, n]) => [f, typeof n === 'number' ? r2(n) : n]))])),
      sales: Object.fromEntries(Object.entries(sales).map(([k, v]) => [k, r2(v)])),
      rentals,
      forms: profile.residence === 'DE' ? DE_FORMS : 'Form mapping is built in for Germany only; the figures above are the inputs every system asks for.',
      planning,
      notes,
    });
  },
});
