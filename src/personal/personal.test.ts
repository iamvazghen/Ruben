import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { addCycles, chargesBetween, lastYearPeriod, nextRenewal, parsePeriod, previousPeriod } from './periods.js';
import type { Subscription } from './store.js';

let home = '';
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ruben-personal-'));
  process.env.RUBEN_HOME = home;
  process.env.RUBEN_BASE_CURRENCY = 'EUR';
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('periods', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  test('absolute and relative periods', () => {
    expect(parsePeriod('2026-09')).toMatchObject({ kind: 'month', start: '2026-09-01', end: '2026-10-01' });
    expect(parsePeriod('2026-Q4')).toMatchObject({ id: '2026-Q4', start: '2026-10-01', end: '2027-01-01' });
    expect(parsePeriod('last_month', now).id).toBe('2026-09');
    expect(parsePeriod('last_quarter', now).id).toBe('2026-Q3');
    expect(parsePeriod('last_year', now).id).toBe('2025');
    expect(() => parsePeriod('soon')).toThrow();
  });

  test('previous period and last year cross year boundaries', () => {
    expect(previousPeriod(parsePeriod('2026-01')).id).toBe('2025-12');
    expect(previousPeriod(parsePeriod('2026-Q1')).id).toBe('2025-Q4');
    expect(previousPeriod(parsePeriod('2026')).id).toBe('2025');
    expect(lastYearPeriod(parsePeriod('2026-Q3')).id).toBe('2025-Q3');
  });

  test('billing on the 31st clamps to short months', () => {
    expect(addCycles('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(addCycles('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(addCycles('2026-01-01', 'weekly', 2)).toBe('2026-01-15');
  });
});

describe('subscription charges', () => {
  const sub: Subscription = {
    id: 's', name: 'Stream', provider: 'StreamCo', category: 'entertainment', amount: 13.99, currency: 'EUR',
    cycle: 'monthly', start_date: '2026-01-15', next_renewal: '2026-01-15', status: 'active',
    price_history: [{ date: '2026-01-15', amount: 11.99 }, { date: '2026-06-01', amount: 13.99 }],
  };
  test('each charge at the price in force that day', () => {
    const q2 = chargesBetween(sub, '2026-04-01', '2026-07-01');
    expect(q2.map((c) => c.date)).toEqual(['2026-04-15', '2026-05-15', '2026-06-15']);
    expect(q2.map((c) => c.amount)).toEqual([11.99, 11.99, 13.99]);
  });
  test('no charge during the trial or after cancellation', () => {
    expect(chargesBetween({ ...sub, trial_ends: '2026-03-01' }, '2026-01-01', '2026-04-01').length).toBe(1);
    expect(chargesBetween({ ...sub, status: 'cancelled', cancelled_at: '2026-03-01' }, '2026-01-01', '2026-12-31').length).toBe(2);
    expect(chargesBetween({ ...sub, status: 'paused' }, '2026-01-01', '2026-12-31').length).toBe(0);
  });
  test('next renewal rolls forward past today', () => {
    expect(nextRenewal(sub, '2026-10-12')).toBe('2026-10-15');
  });
});

describe('bank statement import', () => {
  const csv = [
    'Kontonummer;DE00 1234',
    '',
    'Buchungstag;Valutadatum;Zahlungsempfänger;Verwendungszweck;Betrag;Währung',
    '01.09.2026;01.09.2026;REWE Markt;Einkauf;-54,20;EUR',
    '03.09.2026;03.09.2026;StreamCo;Abo September;-13,99;EUR',
    '05.09.2026;05.09.2026;ACME GmbH;Gehalt;3.100,00;EUR',
    '07.09.2026;07.09.2026;Kiosk Müller;Zeitung;-3,50;EUR',
  ].join('\n');

  test('reads a German export: outgoing only, categorised, subscription linked', async () => {
    const { subscriptionStore, spendingStore } = await import('./store.js');
    subscriptionStore.write({ subscriptions: [{ id: 'sub1', name: 'Stream', provider: 'StreamCo', category: 'entertainment', amount: 13.99, currency: 'EUR', cycle: 'monthly', start_date: '2026-01-03', next_renewal: '2026-10-03', status: 'active' }] });
    spendingStore.write({ purchases: [], merchant_categories: { 'kiosk müller': 'other' } });
    const { parseStatement } = await import('./import.js');
    const p = parseStatement(csv, { currency: 'EUR' });
    expect(p.purchases.length).toBe(3);
    expect(p.skipped_income).toBe(1);
    expect(p.purchases[0]).toMatchObject({ date: '2026-09-01', amount: 54.2, merchant: 'REWE Markt', category: 'groceries' });
    expect(p.purchases[1]!.subscription_id).toBe('sub1');
    expect(p.linked_to_subscriptions).toBe(1);
  });

  test('confirming saves once; the same file again is all duplicates', async () => {
    const { spendingFromText, runSpendingCommand, looksLikeBankStatement } = await import('./commands.js');
    expect(looksLikeBankStatement(csv)).toBe(true);
    expect(looksLikeBankStatement('Date,Symbol,Quantity,Price\n2026-01-01,AAPL,1,100')).toBe(false);
    spendingFromText(csv, 'sept.csv');
    expect(await runSpendingCommand('confirm')).toContain('Saved 3');
    const again = spendingFromText(csv, 'sept.csv');
    expect(again).toContain('Nothing to import');
  });
});

describe('report', () => {
  test('totals, comparison, suggestions and a readable workbook', async () => {
    const { salaryStore, spendingStore, subscriptionStore, budgetStore } = await import('./store.js');
    salaryStore.write({
      employers: [{ id: 'e1', name: 'ACME', currency: 'EUR' }],
      payslips: [
        { id: 'a', employer: 'e1', period: '2026-08', pay_date: '2026-08-28', currency: 'EUR', gross: 4500, net: 2900, income_tax: 700 },
        { id: 'b', employer: 'e1', period: '2026-09', pay_date: '2026-09-28', currency: 'EUR', gross: 4500, net: 2900, income_tax: 700 },
      ],
    });
    spendingStore.write({
      merchant_categories: {},
      purchases: [
        { id: '1', date: '2026-08-10', amount: 200, currency: 'EUR', merchant: 'Bistro', description: 'dinners', category: 'dining' },
        { id: '2', date: '2026-09-10', amount: 420, currency: 'EUR', merchant: 'Bistro', description: 'dinners', category: 'dining' },
        { id: '3', date: '2026-09-12', amount: 300, currency: 'EUR', merchant: 'REWE', description: 'food', category: 'groceries' },
      ],
    });
    subscriptionStore.write({ subscriptions: [{ id: 's', name: 'Gym', provider: 'FitCo', category: 'sport', amount: 40, currency: 'EUR', cycle: 'monthly', start_date: '2026-01-05', next_renewal: '2026-10-05', status: 'active', usage: 'never' }] });
    budgetStore.write({ budgets: [{ category: 'dining', monthly_limit: 250, currency: 'EUR' }] });

    const { buildReport } = await import('./report.js');
    const r = await buildReport('2026-09');
    const m = (k: string) => r.summary.find((x) => x.metric === k)!;
    expect(m('Salary, net').current).toBe(2900);
    expect(m('Purchases').current).toBe(720);
    expect(m('Purchases').previous).toBe(200);
    expect(m('Subscriptions').current).toBe(40);
    expect(m('Total expenses').current).toBe(760);
    expect(m('Net cash flow').current).toBe(2140);
    const dining = r.categories.find((c) => c.category === 'dining')!;
    expect(dining.change_pct).toBe(110);
    expect(dining.over_budget).toBe(170);
    expect(r.suggestions.join('\n')).toContain('Gym is used never');
    expect(r.suggestions.join('\n')).toContain('dining: 170 over budget');

    const { reportWorkbook, writeReportFiles } = await import('./export.js');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await reportWorkbook(r) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Spending', 'Merchants', 'Transactions', 'Subscriptions', 'Salary', 'Optimisation']);
    expect(wb.getWorksheet('Summary')!.getRow(3).getCell(2).value).toBe('2026-09');
    const files = await writeReportFiles(r, 'both');
    expect(files.some((f) => f.endsWith('.xlsx'))).toBe(true);
    expect(files.filter((f) => f.endsWith('.csv')).length).toBe(4);
  });
});
