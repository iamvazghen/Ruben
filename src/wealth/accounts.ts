/**
 * Where everything is held: each account belongs to an institution in a
 * country, and that country is the jurisdiction its holdings sit in. Cash moves
 * between accounts through recorded transfers, across currencies and borders.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { jsonFile } from '../utils/json-store.js';
import { baseCurrency } from '../utils/locale.js';
import { yahoo } from '../market/yahoo.js';
import { valueHoldings } from '../rebalance/check.js';
import { incomeStore } from '../income/store.js';
import { PortfolioStore, type Position } from '../tools/portfolio/store.js';
import { realEstateStore } from '../realestate/tools.js';
import { reviewProperty } from '../realestate/analysis.js';

export type AccountType = 'broker' | 'bank' | 'exchange' | 'wallet' | 'custodian' | 'pension' | 'insurance' | 'other';

export interface Account {
  id: string;
  name: string;
  institution: string;
  /** ISO 3166 alpha-2 of the institution: the jurisdiction of what it holds. For a self-custody wallet, the owner's residence. */
  country: string;
  type: AccountType;
  currency: string;
  opened?: string;
  notes?: string;
}

export interface Transfer {
  id: string;
  date: string;
  /** Account id, or "external" for money from or to the outside world. */
  from: string;
  to: string;
  amount: number;
  currency: string;
  /** What arrived, when the currency changed on the way. */
  received_amount?: number;
  received_currency?: string;
  fee?: number;
  purpose: string;
  reference?: string;
}

export const accountStore = jsonFile<{ accounts: Account[] }>('accounts.json', { accounts: [] });
export const transferStore = jsonFile<{ transfers: Transfer[] }>('transfers.json', { transfers: [] });

const r2 = (n: number) => Math.round(n * 100) / 100;
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

/** Keep the tax profile's view of an account in step: an account in the residence country is domestic. */
function syncTaxAccount(a: Account): void {
  const profile = incomeStore.tax();
  const existing = profile.accounts[a.id];
  profile.accounts[a.id] = {
    broker: existing?.broker, w8ben: existing?.w8ben ?? false, allowance_assigned: existing?.allowance_assigned ?? 0,
    domestic: profile.residence ? a.country === profile.residence : existing?.domestic ?? false,
  };
  incomeStore.saveTax(profile);
}

export const accountsTool = new DynamicStructuredTool({
  name: 'accounts',
  description:
    "Every place the owner keeps money or assets — brokers, banks, crypto exchanges, wallets, custodians, pension and insurance accounts — each with its institution and country (the jurisdiction its holdings fall under). show: value per account and per jurisdiction (properties count in their own country), holdings not yet tied to an account, and jurisdictions with no researched tax notes. add/update/remove are durable: confirm first. Holdings point at an account through their `account` field.",
  schema: z.object({
    action: z.enum(['show', 'add', 'update', 'remove']),
    id: z.string().optional(),
    account: z.object({
      name: z.string(), institution: z.string(), country: z.string().describe('ISO alpha-2'),
      type: z.enum(['broker', 'bank', 'exchange', 'wallet', 'custodian', 'pension', 'insurance', 'other']),
      currency: z.string(), opened: z.string().optional(), notes: z.string().optional(),
      id: z.string().optional().describe('Short id; default from the name'),
    }).partial().optional(),
  }),
  func: async ({ action, id, account }) => {
    const store = accountStore.read();
    if (action === 'add') {
      if (!account?.name || !account.institution || !account.country || !account.type || !account.currency) {
        return formatToolResult({ error: 'name, institution, country, type and currency are required' });
      }
      const a: Account = { ...account, id: account.id ?? slug(account.name), country: account.country.toUpperCase(), currency: account.currency.toUpperCase() } as Account;
      if (store.accounts.some((x) => x.id === a.id)) return formatToolResult({ error: `account ${a.id} exists` });
      store.accounts.push(a);
      accountStore.write(store);
      syncTaxAccount(a);
      return formatToolResult({ added: a });
    }
    if (action === 'update' || action === 'remove') {
      const i = store.accounts.findIndex((a) => a.id === id);
      if (i < 0) return formatToolResult({ error: `no account ${id}`, ids: store.accounts.map((a) => a.id) });
      if (action === 'remove') {
        const used = new PortfolioStore().read().positions.filter((p) => p.account === id).length;
        if (used) return formatToolResult({ error: `${used} holdings are in ${id}: move or close them first` });
        store.accounts.splice(i, 1);
      } else {
        store.accounts[i] = { ...store.accounts[i]!, ...account, id: store.accounts[i]!.id } as Account;
        if (account?.country) store.accounts[i]!.country = account.country.toUpperCase();
        syncTaxAccount(store.accounts[i]!);
      }
      accountStore.write(store);
      return formatToolResult({ ok: true, account: store.accounts[i] ?? null });
    }

    const { holdings, missing } = await valueHoldings(yahoo);
    const byAccount = new Map<string, number>();
    for (const h of holdings) byAccount.set(h.position.account ?? '', (byAccount.get(h.position.account ?? '') ?? 0) + h.value);
    const countryOf = new Map(store.accounts.map((a) => [a.id, a.country]));
    const byJurisdiction: Record<string, { value: number; accounts: string[]; properties: string[] }> = {};
    const add = (c: string, v: number, acct?: string, prop?: string) => {
      const j = (byJurisdiction[c] ??= { value: 0, accounts: [], properties: [] });
      j.value += v;
      if (acct && !j.accounts.includes(acct)) j.accounts.push(acct);
      if (prop) j.properties.push(prop);
    };
    for (const [acct, v] of byAccount) add(countryOf.get(acct) ?? 'unassigned', v, acct || undefined);
    for (const p of realEstateStore.read().properties) {
      const r = reviewProperty(p, new Date().toISOString().slice(0, 10));
      const fx = p.currency === baseCurrency() ? 1 : (await yahoo.rate(p.currency, baseCurrency())) ?? NaN;
      add(p.country, (r.equity ?? 0) * fx, undefined, p.name);
    }
    const { taxKnowledge } = await import('../tax/knowledge.js');
    const researched = new Set(taxKnowledge.read().notes.map((n) => n.jurisdiction));
    const residence = incomeStore.tax().residence;
    return formatToolResult({
      base_currency: baseCurrency(), residence,
      accounts: store.accounts.map((a) => ({ ...a, value_base: r2(byAccount.get(a.id) ?? 0), foreign: residence ? a.country !== residence : null })),
      by_jurisdiction: Object.fromEntries(Object.entries(byJurisdiction).map(([k, v]) => [k, { ...v, value: r2(v.value) }])),
      unassigned_holdings: new PortfolioStore().read().positions.filter((p) => !p.account || !countryOf.has(p.account)).map((p) => `${p.ticker}${p.account ? ` (${p.account}?)` : ''}`),
      jurisdictions_without_tax_notes: Object.keys(byJurisdiction).filter((c) => c !== 'unassigned' && !researched.has(c)),
      missing_prices: missing,
    });
  },
});

/** Add `delta` units of cash in `currency` at `account`, creating the cash line if needed. */
function moveCash(positions: Position[], account: string, currency: string, delta: number, date: string): Position[] {
  const ticker = `CASH-${currency.toUpperCase()}`;
  const i = positions.findIndex((p) => p.ticker === ticker && p.account === account);
  if (i >= 0) return positions.map((p, k) => (k === i ? { ...p, shares: r2(p.shares + delta) } : p));
  return [...positions, {
    ticker, shares: r2(delta), avg_cost: 1, currency: currency.toUpperCase(), opened: date, thesis: 'Cash', conviction: 'med',
    asset_type: 'cash', account,
  }];
}

export const transferTool = new DynamicStructuredTool({
  name: 'cash_transfer',
  description:
    "Record money moving between the owner's accounts (also across borders and currencies), or in from / out to the outside world (`external`). Updates the cash balances of both accounts unless apply_to_cash is false. `list` shows transfers in a period and flags large cross-border ones, which some countries require to be reported. Recording is durable: confirm first.",
  schema: z.object({
    action: z.enum(['record', 'list', 'remove']),
    transfer: z.object({
      date: z.string(), from: z.string().describe('Account id or "external"'), to: z.string().describe('Account id or "external"'),
      amount: z.number().positive(), currency: z.string(),
      received_amount: z.number().optional(), received_currency: z.string().optional(),
      fee: z.number().optional().describe('In the sending currency, on top of amount'), purpose: z.string(), reference: z.string().optional(),
    }).optional(),
    apply_to_cash: z.boolean().optional(),
    from_date: z.string().optional(), to_date: z.string().optional(),
    id: z.string().optional(),
  }),
  func: async ({ action, transfer, apply_to_cash, from_date, to_date, id }) => {
    const store = transferStore.read();
    const accounts = accountStore.read().accounts;
    if (action === 'record') {
      if (!transfer) return formatToolResult({ error: 'transfer is required' });
      for (const end of [transfer.from, transfer.to]) {
        if (end !== 'external' && !accounts.some((a) => a.id === end)) return formatToolResult({ error: `unknown account ${end}: add it with accounts first` });
      }
      const t: Transfer = { ...transfer, id: `tr-${Date.now().toString(36)}`, currency: transfer.currency.toUpperCase(), received_currency: transfer.received_currency?.toUpperCase() };
      store.transfers.push(t);
      transferStore.write(store);
      if (apply_to_cash !== false) {
        new PortfolioStore().update((p) => {
          let positions = p.positions;
          if (t.from !== 'external') positions = moveCash(positions, t.from, t.currency, -(t.amount + (t.fee ?? 0)), t.date);
          if (t.to !== 'external') positions = moveCash(positions, t.to, t.received_currency ?? t.currency, t.received_amount ?? t.amount, t.date);
          return { ...p, positions };
        });
      }
      return formatToolResult({ recorded: t, cash_updated: apply_to_cash !== false });
    }
    if (action === 'remove') {
      store.transfers = store.transfers.filter((t) => t.id !== id);
      transferStore.write(store);
      return formatToolResult({ removed: id, note: 'Cash balances are not reversed: correct them with portfolio_update if needed.' });
    }
    const country = new Map(accounts.map((a) => [a.id, a.country]));
    const rows = store.transfers.filter((t) => (!from_date || t.date >= from_date) && (!to_date || t.date <= to_date)).sort((a, b) => b.date.localeCompare(a.date));
    const flagged = [];
    for (const t of rows) {
      const [a, b] = [country.get(t.from), country.get(t.to)];
      if (!a || !b || a === b) continue;
      const fx = t.currency === 'EUR' ? 1 : (await yahoo.rate(t.currency, 'EUR')) ?? NaN;
      if (t.amount * fx >= 12_500) flagged.push({ id: t.id, date: t.date, route: `${a} → ${b}`, eur: r2(t.amount * fx), note: 'large cross-border transfer: check the reporting duty in the residence country (e.g. Germany AWV §67, over EUR 12,500)' });
    }
    return formatToolResult({ transfers: rows, cross_border_flags: flagged });
  },
});
