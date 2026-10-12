import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let home = '';
const saved = { home: process.env.RUBEN_HOME, ccy: process.env.RUBEN_BASE_CURRENCY };
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ruben-data-'));
  process.env.RUBEN_HOME = home;
  process.env.RUBEN_BASE_CURRENCY = 'EUR';
});
afterAll(() => {
  // Other test files run in this process: leave the environment as found.
  if (saved.home === undefined) delete process.env.RUBEN_HOME; else process.env.RUBEN_HOME = saved.home;
  if (saved.ccy === undefined) process.env.RUBEN_BASE_CURRENCY = ''; else process.env.RUBEN_BASE_CURRENCY = saved.ccy;
  rmSync(home, { recursive: true, force: true });
});

const data = (raw: unknown) => JSON.parse(String(raw)).data;

describe('accounts, holdings and transfers across jurisdictions', () => {
  test('an account in the residence country is domestic, a foreign one is not', async () => {
    const { taxJurisdictionTool } = await import('../tax/knowledge.js');
    const { accountsTool } = await import('../wealth/accounts.js');
    const { incomeStore } = await import('../income/store.js');
    await taxJurisdictionTool.invoke({ action: 'set', residence: 'DE' });
    await accountsTool.invoke({ action: 'add', account: { id: 'tr', name: 'Trade Republic', institution: 'Trade Republic Bank', country: 'DE', type: 'broker', currency: 'EUR' } });
    await accountsTool.invoke({ action: 'add', account: { id: 'ibkr', name: 'IBKR', institution: 'Interactive Brokers', country: 'IE', type: 'broker', currency: 'USD' } });
    await accountsTool.invoke({ action: 'add', account: { id: 'kraken', name: 'Kraken', institution: 'Payward', country: 'US', type: 'exchange', currency: 'EUR' } });
    await accountsTool.invoke({ action: 'add', account: { id: 'ameria', name: 'Ameriabank', institution: 'Ameriabank', country: 'AM', type: 'bank', currency: 'AMD' } });
    const tax = incomeStore.tax();
    expect(tax.accounts.tr!.domestic).toBe(true);
    expect(tax.accounts.ibkr!.domestic).toBe(false);
  });

  test('the same ETF in two accounts is two positions; partial sale and update work per account', async () => {
    const { portfolioAdd, portfolioRemove, portfolioUpdate } = await import('../tools/portfolio/portfolio-tools.js');
    const { PortfolioStore } = await import('../tools/portfolio/store.js');
    const base = { avg_cost: 100, currency: 'EUR', opened: '2024-01-02', thesis: 'core', conviction: 'high' as const };
    expect(data(await portfolioAdd.invoke({ ...base, ticker: 'VWCE', shares: 10, account: 'tr', asset_type: 'etf', data_symbol: 'VWCE.DE' })).ok).toBe(true);
    expect(data(await portfolioAdd.invoke({ ...base, ticker: 'VWCE', shares: 5, account: 'ibkr', asset_type: 'etf' })).ok).toBe(true);
    expect(data(await portfolioAdd.invoke({ ...base, ticker: 'VWCE', shares: 1, account: 'tr' })).ok).toBe(false);
    await portfolioAdd.invoke({ ...base, ticker: 'BTC', shares: 0.5, avg_cost: 30000, account: 'kraken', asset_type: 'crypto', data_symbol: 'BTC-EUR', opened: '2024-03-01' });
    await portfolioAdd.invoke({ ...base, ticker: 'GOLD-BAR', shares: 1, avg_cost: 1800, unit: 'oz', asset_type: 'commodity', account: 'tr', manual_price: { amount: 2400, currency: 'EUR', as_of: '2026-10-01' } });

    // Ambiguous without an account; precise with one.
    expect(String(await portfolioRemove.invoke({ ticker: 'VWCE', exit_price: 120, closed: '2025-06-01' }))).toContain('several accounts');
    await portfolioRemove.invoke({ ticker: 'VWCE', account: 'tr', shares: 4, exit_price: 120, closed: '2025-06-01', lesson: '' });
    await portfolioRemove.invoke({ ticker: 'BTC', exit_price: 60000, closed: '2025-02-01', lesson: '' });
    await portfolioUpdate.invoke({ ticker: 'VWCE', account: 'ibkr', thesis: 'world core', new_account: 'tr-2' });

    const p = new PortfolioStore().read();
    expect(p.positions.find((x) => x.ticker === 'VWCE' && x.account === 'tr')!.shares).toBe(6);
    expect(p.positions.find((x) => x.ticker === 'VWCE' && x.account === 'tr-2')!.thesis).toBe('world core');
    expect(p.closed.find((c) => c.ticker === 'VWCE')!.realized_pnl).toBe(80);
    expect(p.positions.some((x) => x.ticker === 'BTC')).toBe(false);
  });

  test('a cross-currency transfer moves cash out of one account and into another', async () => {
    const { transferTool } = await import('../wealth/accounts.js');
    const { PortfolioStore } = await import('../tools/portfolio/store.js');
    await transferTool.invoke({ action: 'record', transfer: { date: '2026-10-01', from: 'external', to: 'tr', amount: 5000, currency: 'EUR', purpose: 'salary' } });
    await transferTool.invoke({ action: 'record', transfer: { date: '2026-10-02', from: 'tr', to: 'ameria', amount: 1000, currency: 'EUR', received_amount: 440000, received_currency: 'AMD', fee: 5, purpose: 'family' } });
    const cash = new PortfolioStore().read().positions.filter((x) => x.asset_type === 'cash');
    expect(cash.find((c) => c.account === 'tr')!.shares).toBe(3995);
    expect(cash.find((c) => c.account === 'ameria')).toMatchObject({ ticker: 'CASH-AMD', shares: 440000 });
    expect(String(await transferTool.invoke({ action: 'record', transfer: { date: '2026-10-03', from: 'nowhere', to: 'tr', amount: 1, currency: 'EUR', purpose: 'x' } }))).toContain('unknown account');
  });

  test('jurisdictions: what is held where, and what still needs research', async () => {
    const { taxJurisdictionTool, taxKnowledgeTool } = await import('../tax/knowledge.js');
    let d = data(await taxJurisdictionTool.invoke({ action: 'show' }));
    const am = d.jurisdictions.find((j: any) => j.jurisdiction === 'AM');
    expect(am.holds).toEqual(['cash']);
    expect(am.to_research).toEqual(expect.arrayContaining(['interest', 'treaty', 'reporting']));
    await taxKnowledgeTool.invoke({ action: 'save', note: { jurisdiction: 'DE', topic: 'treaty', counterpart: 'AM', rule: 'DE-AM treaty', source: 'https://example.org', official: true } });
    d = data(await taxJurisdictionTool.invoke({ action: 'show' }));
    expect(d.jurisdictions.find((j: any) => j.jurisdiction === 'AM').to_research).not.toContain('treaty');
    expect(d.jurisdictions.find((j: any) => j.jurisdiction === 'DE').residence).toBe(true);
  });

  test('crypto sold within a year is a short-term private sale', async () => {
    const { taxYearSummaryTool } = await import('../tax/annual.js');
    const d = data(await taxYearSummaryTool.invoke({ year: 2025 }));
    expect(d.private_sales.items[0]).toMatchObject({ ticker: 'BTC', over_one_year: false });
    expect(d.private_sales.short_term_net).toBe(15000);
    expect(d.private_sales.de_rule).toContain('Freigrenze');
    expect(d.sales.other_gain).toBe(80); // the ETF sale
  });
});

describe('export and import', () => {
  test('everything out to a workbook, wiped, and back in unchanged', async () => {
    const { exportData, planWorkbook, pendingImport, applyImport, DATASETS } = await import('./backup.js');
    const { commitmentStore } = await import('../wealth/tools.js');
    const { subscriptionStore } = await import('../personal/store.js');
    commitmentStore.write({ commitments: [{ id: 'c1', name: 'ETF plan', kind: 'savings_plan', amount: 200, currency: 'EUR', frequency: 'monthly', target: 'VWCE' }] });
    subscriptionStore.write({ subscriptions: [{ id: 's1', name: 'Music', provider: 'Spotify', category: 'entertainment', amount: 10.99, currency: 'EUR', cycle: 'monthly', start_date: '2025-01-05', next_renewal: '2026-11-05', status: 'active', price_history: [{ date: '2025-01-05', amount: 9.99 }, { date: '2026-01-05', amount: 10.99 }] }] });

    const before = Object.fromEntries(DATASETS.map((d) => [d.name, d.read()]));
    const [file] = await exportData([], 'xlsx');
    for (const d of DATASETS) d.write([]);
    expect(DATASETS.every((d) => d.read().length === 0)).toBe(true);

    const plan = await planWorkbook(new Uint8Array(readFileSync(file!)));
    expect(plan.unknown).toEqual([]);
    expect(plan.sheets.flatMap((s) => s.errors)).toEqual([]);
    pendingImport.write({ plan, file: 'backup.xlsx' });
    expect(applyImport('replace')).toContain('Imported backup.xlsx');
    // An empty cell cannot tell "" from absent; both mean nothing was entered.
    const clean = (rows: unknown) => JSON.parse(JSON.stringify(rows, (_k, v) => (v === '' ? undefined : v)));
    for (const d of DATASETS) expect(clean(d.read())).toEqual(clean(before[d.name]));
  });

  test('a dataset CSV merges: new rows added, edited rows updated, others kept', async () => {
    const { exportData, planCsv, pendingImport, applyImport } = await import('./backup.js');
    const { PortfolioStore } = await import('../tools/portfolio/store.js');
    const [path] = await exportData(['holdings'], 'csv');
    let csv = readFileSync(path!, 'utf8').replace(/^﻿/, '');
    const header = csv.split('\n')[0]!.split(',');
    const col = (k: string) => header.indexOf(k);
    const rows = csv.trim().split('\n');
    const gold = rows.findIndex((r) => r.startsWith('GOLD-BAR'));
    const cells = rows[gold]!.split(',');
    cells[col('shares')] = '2';
    rows[gold] = cells.join(',');
    const extra = header.map((k) => ({ ticker: 'ETH', shares: '3', avg_cost: '2000', currency: 'EUR', opened: '2026-01-01', asset_type: 'crypto', account: 'kraken', data_symbol: 'ETH-EUR' } as Record<string, string>)[k] ?? '');
    csv = [...rows, extra.join(',')].join('\n');
    const plan = planCsv(csv, 'ruben-holdings-edited.csv')!;
    expect(plan.sheets[0]).toMatchObject({ name: 'holdings', added: 1, updated: 1 });
    pendingImport.write({ plan, file: 'edited.csv' });
    applyImport('merge');
    const p = new PortfolioStore().read().positions;
    expect(p.find((x) => x.ticker === 'GOLD-BAR')!.shares).toBe(2);
    expect(p.find((x) => x.ticker === 'ETH')).toMatchObject({ shares: 3, asset_type: 'crypto', conviction: 'med' });
    expect(p.find((x) => x.ticker === 'VWCE' && x.account === 'tr')!.shares).toBe(6);
  });

  test('rows missing required fields are rejected, not imported', async () => {
    const { planCsv } = await import('./backup.js');
    const plan = planCsv('id,name,provider,amount,currency,cycle,start_date\ns9,Gym,,30,EUR,monthly,2026-01-01\n', 'ruben-subscriptions.csv')!;
    expect(plan.sheets[0]!.rows.length).toBe(0);
    expect(plan.sheets[0]!.errors[0]).toContain('provider');
  });

  test('commands: export lists files, importsheet previews then confirms', async () => {
    const { runMoneyCommand, importSheetFromBytes } = await import('../commands/money.js');
    const out = await runMoneyCommand('export', 'subscriptions purchases xlsx');
    expect(out.files!.length).toBe(1);
    expect((await runMoneyCommand('export', 'nonsense')).text).toContain('Unknown');
    const preview = await importSheetFromBytes(new Uint8Array(readFileSync(out.files![0]!)), 'mine.xlsx');
    expect(preview).toContain('subscriptions');
    expect((await runMoneyCommand('importsheet', 'confirm')).text).toContain('merge');
    expect((await runMoneyCommand('importsheet', 'confirm')).text).toContain('No sheet waiting');
    expect((await runMoneyCommand('jurisdiction', 'set XYZ')).text).toContain('Usage');
  });
});
