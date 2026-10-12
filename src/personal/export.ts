/**
 * Report files: an Excel workbook laid out for reading (summary first, money
 * formatted, changes coloured, filters on every table) and plain CSV for
 * anything else.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { rubenPath } from '../utils/paths.js';
import type { Report } from './report.js';

const NAVY = 'FF1F3A5F';
const GREEN = 'FF1E7B34';
const RED = 'FFB3261E';
const BAND = 'FFF3F6FA';

type Col = { header: string; key: string; width: number; money?: boolean; pct?: boolean; good?: 'up' | 'down' };

function table(wb: ExcelJS.Workbook, name: string, title: string, cols: Col[], rows: Record<string, unknown>[], currency: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  ws.mergeCells(1, 1, 1, cols.length);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getRow(2).height = 4;
  const head = ws.getRow(3);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  head.height = 30;
  const moneyFmt = `#,##0.00 "${currency}";[Red]-#,##0.00 "${currency}"`;
  rows.forEach((r, n) => {
    const row = ws.addRow(cols.map((c) => r[c.key] ?? null));
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.money) cell.numFmt = moneyFmt;
      if (c.pct) cell.numFmt = '+0.0"%";-0.0"%";0"%"';
      if (c.good && typeof cell.value === 'number' && cell.value !== 0) {
        const better = c.good === 'up' ? cell.value > 0 : cell.value < 0;
        cell.font = { color: { argb: better ? GREEN : RED } };
      }
      if (n % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
    });
  });
  if (rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + rows.length, column: cols.length } };
  return ws;
}

/** Metrics where a rise is bad (so a positive change is shown red). */
const COSTS = new Set(['Salary tax and social contributions', 'Purchases', 'Subscriptions', 'Mortgage payments', 'Other commitments', 'Total expenses']);

export async function reportWorkbook(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'R.U.B.E.N.';
  wb.created = new Date();
  const ccy = r.base_currency;
  const label = `${r.period.id} vs ${r.previous.id} and ${r.last_year.id}`;

  const sum = table(wb, 'Summary', `Financial results ${label} (${ccy})`, [
    { header: 'Metric', key: 'metric', width: 38 },
    { header: r.period.id, key: 'current', width: 16, money: true },
    { header: r.previous.id, key: 'previous', width: 16, money: true },
    { header: 'Change', key: 'change', width: 15, money: true },
    { header: 'Change %', key: 'change_pct', width: 11, pct: true },
    { header: r.last_year.id, key: 'last_year', width: 16, money: true },
    { header: 'vs last year %', key: 'yoy_pct', width: 13, pct: true },
  ], r.summary, ccy);
  // Colour changes by whether they help: more income is good, more cost is bad.
  r.summary.forEach((m, i) => {
    const row = sum.getRow(4 + i);
    const isRate = m.metric.endsWith('%');
    if (isRate) for (const c of [2, 3, 4, 6]) row.getCell(c).numFmt = '0.0"%"';
    for (const c of [4, 5, 7]) {
      const v = row.getCell(c).value;
      if (typeof v !== 'number' || v === 0) continue;
      const good = COSTS.has(m.metric) ? v < 0 : v > 0;
      row.getCell(c).font = { color: { argb: good ? GREEN : RED } };
    }
    if (['Total income (net)', 'Total expenses', 'Net cash flow'].includes(m.metric)) row.font = { bold: true };
  });

  table(wb, 'Spending', `Spending by category ${label}`, [
    { header: 'Category', key: 'category', width: 20 },
    { header: r.period.id, key: 'current', width: 15, money: true },
    { header: r.previous.id, key: 'previous', width: 15, money: true },
    { header: 'Change %', key: 'change_pct', width: 11, pct: true, good: 'down' },
    { header: r.last_year.id, key: 'last_year', width: 15, money: true },
    { header: 'vs last year %', key: 'yoy_pct', width: 13, pct: true, good: 'down' },
    { header: 'Budget', key: 'budget', width: 14, money: true },
    { header: 'Over budget', key: 'over_budget', width: 14, money: true },
  ], r.categories, ccy);

  table(wb, 'Merchants', `Where the money went, ${r.period.id}`, [
    { header: 'Merchant', key: 'merchant', width: 32 },
    { header: 'Amount', key: 'amount', width: 15, money: true },
    { header: 'Share of purchases %', key: 'share_pct', width: 18 },
  ], r.merchants, ccy);

  table(wb, 'Transactions', `Purchases ${r.period.id}`, [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Merchant', key: 'merchant', width: 26 },
    { header: 'What', key: 'description', width: 36 },
    { header: 'Category', key: 'category', width: 15 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Currency', key: 'currency', width: 9 },
    { header: `Amount ${ccy}`, key: 'amount_base', width: 14, money: true },
    { header: 'Paid with', key: 'payment_method', width: 14 },
    { header: 'Receipt', key: 'receipt', width: 20 },
    { header: 'Notes', key: 'notes', width: 24 },
  ], r.transactions as unknown as Record<string, unknown>[], ccy);

  table(wb, 'Subscriptions', 'Subscriptions', [
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Provider', key: 'provider', width: 18 },
    { header: 'Category', key: 'category', width: 15 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Cycle', key: 'cycle', width: 11 },
    { header: 'Price', key: 'amount', width: 10 },
    { header: 'Currency', key: 'currency', width: 9 },
    { header: `In ${r.period.id}`, key: 'in_period', width: 13, money: true },
    { header: 'Per month', key: 'monthly_equivalent', width: 13, money: true },
    { header: 'Per year', key: 'annual_equivalent', width: 13, money: true },
    { header: 'Next renewal', key: 'next_renewal', width: 13 },
    { header: 'Notice (days)', key: 'notice_days', width: 11 },
    { header: 'Usage', key: 'usage', width: 10 },
    { header: 'Price change', key: 'price_change', width: 22 },
  ], r.subscriptions, ccy);

  table(wb, 'Salary', `Payslips ${r.period.id}`, [
    { header: 'Paid', key: 'pay_date', width: 12 },
    { header: 'Employer', key: 'employer', width: 22 },
    { header: 'For', key: 'period', width: 10 },
    { header: 'Gross', key: 'gross', width: 13 },
    { header: 'Income tax', key: 'income_tax', width: 13 },
    { header: 'Social', key: 'social', width: 13 },
    { header: 'Net', key: 'net', width: 13 },
    { header: 'Of which bonus', key: 'bonus', width: 13 },
    { header: 'Currency', key: 'currency', width: 9 },
  ], r.payslips, ccy);

  table(wb, 'Optimisation', 'Where costs can be cut (largest first)', [
    { header: '#', key: 'n', width: 5 },
    { header: 'Finding', key: 'text', width: 110 },
  ], r.suggestions.map((text, i) => ({ n: i + 1, text })), ccy);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Record<string, unknown>[], keys: string[]) =>
  [keys.join(','), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))].join('\n') + '\n';

/** Write the requested files under reports/finance and return their paths. */
export async function writeReportFiles(r: Report, format: 'xlsx' | 'csv' | 'both'): Promise<string[]> {
  const dir = rubenPath('reports', 'finance');
  mkdirSync(dir, { recursive: true });
  const stem = `ruben-finance-${r.period.id}`;
  const files: string[] = [];
  if (format !== 'csv') {
    const path = `${dir}/${stem}.xlsx`;
    writeFileSync(path, await reportWorkbook(r));
    files.push(path);
  }
  if (format !== 'xlsx') {
    const write = (name: string, rows: Record<string, unknown>[], keys: string[]) => {
      const path = `${dir}/${stem}-${name}.csv`;
      writeFileSync(path, '﻿' + toCsv(rows, keys), 'utf8'); // BOM: Excel opens UTF-8 correctly
      files.push(path);
    };
    write('summary', r.summary, ['metric', 'current', 'previous', 'change', 'change_pct', 'last_year', 'yoy_pct']);
    write('spending', r.categories, ['category', 'current', 'previous', 'change_pct', 'last_year', 'yoy_pct', 'budget', 'over_budget']);
    write('transactions', r.transactions as unknown as Record<string, unknown>[], ['date', 'merchant', 'description', 'category', 'amount', 'currency', 'amount_base', 'payment_method', 'account', 'receipt', 'notes']);
    write('subscriptions', r.subscriptions, ['name', 'provider', 'category', 'status', 'cycle', 'amount', 'currency', 'in_period', 'monthly_equivalent', 'annual_equivalent', 'next_renewal', 'notice_days', 'usage', 'price_change']);
  }
  return files;
}
