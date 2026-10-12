/**
 * Everything RUBEN knows, out to a workbook (or one CSV per dataset) and back
 * in. A sheet edited in Excel and sent back is merged by key: new rows are
 * added, changed rows updated, nothing is deleted unless the owner asks for
 * `replace`. Nested values (a property's mortgages, a payslip's social
 * contributions) travel as JSON in their cell.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { rubenPath } from '../utils/paths.js';
import { jsonFile } from '../utils/json-store.js';
import { parseCsv } from '../importer/parse.js';
import { toCsv } from '../personal/export.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { accountStore, transferStore } from '../wealth/accounts.js';
import { commitmentStore } from '../wealth/tools.js';
import { realEstateStore } from '../realestate/tools.js';
import { budgetStore, salaryStore, spendingStore, subscriptionStore } from '../personal/store.js';
import { taxKnowledge } from '../tax/knowledge.js';
import { incomeStore } from '../income/store.js';

type Row = Record<string, unknown>;

interface Dataset {
  name: string;
  /** Fields that identify a row, for merging. */
  key: string[];
  /** Fields a new row must have. */
  required: string[];
  read(): Row[];
  write(rows: Row[]): void;
}

const portfolio = new PortfolioStore();

export const DATASETS: Dataset[] = [
  { name: 'accounts', key: ['id'], required: ['id', 'name', 'institution', 'country', 'type', 'currency'],
    read: () => accountStore.read().accounts as unknown as Row[], write: (rows) => accountStore.write({ accounts: rows as never }) },
  { name: 'holdings', key: ['ticker', 'account'], required: ['ticker', 'shares', 'avg_cost', 'currency', 'opened'],
    read: () => portfolio.read().positions as unknown as Row[],
    write: (rows) => portfolio.update((p) => ({ ...p, positions: rows.map((r) => ({ thesis: '', conviction: 'med', ...r })) as never })) },
  { name: 'closed', key: ['ticker', 'account', 'closed'], required: ['ticker', 'shares', 'avg_cost', 'currency', 'closed', 'exit_price'],
    read: () => portfolio.read().closed as unknown as Row[], write: (rows) => portfolio.update((p) => ({ ...p, closed: rows as never })) },
  { name: 'journal', key: ['date', 'text'], required: ['date', 'text'],
    read: () => portfolio.read().journal as unknown as Row[], write: (rows) => portfolio.update((p) => ({ ...p, journal: rows as never })) },
  { name: 'properties', key: ['id'], required: ['id', 'name', 'country', 'city', 'currency'],
    read: () => realEstateStore.read().properties as unknown as Row[],
    write: (rows) => realEstateStore.write({ properties: rows.map((r) => ({ mortgages: [], use: 'rented', type: 'apartment', ...r })) as never }) },
  { name: 'commitments', key: ['id'], required: ['id', 'name', 'kind', 'amount', 'currency', 'frequency'],
    read: () => commitmentStore.read().commitments as unknown as Row[], write: (rows) => commitmentStore.write({ commitments: rows as never }) },
  { name: 'subscriptions', key: ['id'], required: ['id', 'name', 'provider', 'amount', 'currency', 'cycle', 'start_date'],
    read: () => subscriptionStore.read().subscriptions as unknown as Row[],
    write: (rows) => subscriptionStore.write({ subscriptions: rows.map((r) => ({ status: 'active', category: 'other', next_renewal: r.start_date, ...r })) as never }) },
  { name: 'purchases', key: ['id'], required: ['id', 'date', 'amount', 'currency', 'merchant'],
    read: () => spendingStore.read().purchases as unknown as Row[],
    write: (rows) => spendingStore.write({ ...spendingStore.read(), purchases: rows.map((r) => ({ category: 'other', description: '', ...r })) as never }) },
  { name: 'employers', key: ['id'], required: ['id', 'name', 'currency'],
    read: () => salaryStore.read().employers as unknown as Row[], write: (rows) => salaryStore.write({ ...salaryStore.read(), employers: rows as never }) },
  { name: 'payslips', key: ['id'], required: ['id', 'employer', 'period', 'pay_date', 'currency', 'gross', 'net'],
    read: () => salaryStore.read().payslips as unknown as Row[], write: (rows) => salaryStore.write({ ...salaryStore.read(), payslips: rows as never }) },
  { name: 'budgets', key: ['category'], required: ['category', 'monthly_limit', 'currency'],
    read: () => budgetStore.read().budgets as unknown as Row[], write: (rows) => budgetStore.write({ budgets: rows as never }) },
  { name: 'transfers', key: ['id'], required: ['id', 'date', 'from', 'to', 'amount', 'currency'],
    read: () => transferStore.read().transfers as unknown as Row[], write: (rows) => transferStore.write({ transfers: rows as never }) },
  { name: 'tax_notes', key: ['id'], required: ['id', 'jurisdiction', 'topic', 'rule', 'source'],
    read: () => taxKnowledge.read().notes as unknown as Row[], write: (rows) => taxKnowledge.write({ notes: rows as never }) },
  { name: 'income_received', key: ['eventId'], required: ['eventId', 'ticker', 'confirmedAt'],
    read: () => incomeStore.ledger().entries as unknown as Row[],
    write: (rows) => incomeStore.saveLedger({ ...incomeStore.ledger(), entries: rows as never }) },
];

const byName = new Map(DATASETS.map((d) => [d.name, d]));

/** Flat cell values: nested objects and arrays become JSON text. */
const flat = (r: Row): Row => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v != null && typeof v === 'object' ? JSON.stringify(v) : v]));

/** Back from a cell: JSON text to objects, numeric text to numbers, empty to undefined. */
function unflat(r: Row, numeric: Set<string>): Row {
  const out: Row = {};
  for (const [k, raw] of Object.entries(r)) {
    let v: unknown = raw;
    if (v && typeof v === 'object' && 'text' in (v as object)) v = (v as { text: string }).text; // exceljs rich text / hyperlinks
    if (v instanceof Date) v = v.toISOString().slice(0, 10);
    if (v === '' || v == null) continue;
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { v = JSON.parse(t); } catch { /* keep text */ }
      } else if (t === 'true' || t === 'false') v = t === 'true';
      else if (numeric.has(k) && /^-?\d+(\.\d+)?$/.test(t)) v = Number(t);
    }
    out[k] = v;
  }
  return out;
}

const NUMERIC = new Set(['shares', 'avg_cost', 'amount', 'gross', 'net', 'income_tax', 'bonus', 'monthly_limit', 'exit_price', 'realized_pnl',
  'realized_pnl_pct', 'size_m2', 'purchase_price', 'purchase_costs', 'land_share_pct', 'rent_monthly', 'costs_monthly', 'property_tax_annual',
  'insurance_annual', 'depreciation_rate_pct', 'received_amount', 'fee', 'notice_days', 'target_price', 'stop_loss', 'face_value',
  'coupon_rate_pct', 'coupon_frequency', 'partial_exemption_pct', 'year_built', 'gross_annual', 'other_deductions']);

const columnsOf = (rows: Row[], d: Dataset) => [...new Set([...d.required, ...rows.flatMap((r) => Object.keys(r))])];
const keyOf = (r: Row, d: Dataset) => d.key.map((k) => String(r[k] ?? '').toUpperCase()).join('|');

export async function exportData(names: string[], format: 'xlsx' | 'csv'): Promise<string[]> {
  const chosen = names.length ? names.map((n) => byName.get(n)).filter((d): d is Dataset => Boolean(d)) : DATASETS;
  const dir = rubenPath('exports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    return chosen.map((d) => {
      const rows = d.read().map(flat);
      const path = `${dir}/ruben-${d.name}-${stamp}.csv`;
      writeFileSync(path, '﻿' + toCsv(rows, columnsOf(rows, d)), 'utf8');
      return path;
    });
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'R.U.B.E.N.';
  for (const d of chosen) {
    const rows = d.read().map(flat);
    const cols = columnsOf(rows, d);
    const ws = wb.addWorksheet(d.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(10, c.length + 2)) }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    for (const r of rows) ws.addRow(r);
    if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: cols.length } };
  }
  const path = `${dir}/ruben-data-${stamp}.xlsx`;
  writeFileSync(path, Buffer.from(await wb.xlsx.writeBuffer()));
  return [path];
}

export interface ImportPlan {
  sheets: { name: string; rows: Row[]; added: number; updated: number; unchanged: number; errors: string[] }[];
  unknown: string[];
}

function plan(sheets: { name: string; rows: Row[] }[]): ImportPlan {
  const out: ImportPlan = { sheets: [], unknown: [] };
  for (const s of sheets) {
    const d = byName.get(s.name);
    if (!d) { out.unknown.push(s.name); continue; }
    const current = new Map(d.read().map((r) => [keyOf(r, d), JSON.stringify(r)]));
    const errors: string[] = [];
    let added = 0, updated = 0, unchanged = 0;
    const rows = s.rows.filter((r, i) => {
      const missing = d.required.filter((k) => r[k] == null || r[k] === '');
      if (missing.length) { errors.push(`row ${i + 2}: missing ${missing.join(', ')}`); return false; }
      const prev = current.get(keyOf(r, d));
      if (prev == null) added++;
      else if (prev === JSON.stringify({ ...JSON.parse(prev), ...r })) unchanged++;
      else updated++;
      return true;
    });
    out.sheets.push({ name: s.name, rows, added, updated, unchanged, errors });
  }
  return out;
}

/** Datasets in a workbook: each sheet named after one. */
export async function planWorkbook(bytes: Uint8Array): Promise<ImportPlan> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as never);
  const sheets = wb.worksheets.map((ws) => {
    const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? '').trim());
    const rows: Row[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const vals = (row.values as unknown[]).slice(1);
      const r: Row = {};
      header.forEach((h, i) => { if (h) r[h] = vals[i]; });
      rows.push(unflat(r, NUMERIC));
    });
    return { name: ws.name.trim().toLowerCase(), rows };
  });
  return plan(sheets);
}

/** One dataset from a CSV whose file name says which (ruben-holdings-….csv) or whose header matches. */
export function planCsv(text: string, fileName: string): ImportPlan | null {
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const header = rows[0]!.map((h) => h.trim());
  const fromName = DATASETS.find((d) => new RegExp(`^ruben-${d.name}\\b`, 'i').test(fileName));
  const fromHeader = DATASETS.find((d) => d.required.every((k) => header.includes(k)));
  const d = fromName ?? fromHeader;
  if (!d) return null;
  const parsed = rows.slice(1).map((r) => unflat(Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])), NUMERIC));
  return plan([{ name: d.name, rows: parsed }]);
}

export const pendingImport = jsonFile<{ plan: ImportPlan | null; file: string }>('exports/pending-import.json', { plan: null, file: '' });

export function describePlan(p: ImportPlan, file: string): string {
  if (!p.sheets.length) return `${file}: no RUBEN datasets found${p.unknown.length ? ` (sheets ${p.unknown.join(', ')} are not ones RUBEN knows)` : ''}.`;
  return [
    `${file}:`,
    ...p.sheets.map((s) => `  ${s.name.padEnd(16)} ${s.added} new, ${s.updated} changed, ${s.unchanged} unchanged${s.errors.length ? `, ${s.errors.length} rejected (${s.errors.slice(0, 2).join('; ')})` : ''}`),
    ...(p.unknown.length ? [`  ignored sheets: ${p.unknown.join(', ')}`] : []),
    'Apply with /importsheet confirm (merge), or /importsheet confirm replace to make RUBEN match the file exactly; /importsheet cancel to drop it.',
  ].join('\n');
}

export function applyImport(mode: 'merge' | 'replace'): string {
  const { plan: p, file } = pendingImport.read();
  if (!p) return 'No sheet waiting. Send or name a RUBEN workbook or CSV first.';
  const lines: string[] = [];
  for (const s of p.sheets) {
    const d = byName.get(s.name)!;
    if (mode === 'replace') d.write(s.rows);
    else {
      const merged = new Map(d.read().map((r) => [keyOf(r, d), r]));
      for (const r of s.rows) merged.set(keyOf(r, d), { ...(merged.get(keyOf(r, d)) ?? {}), ...r });
      d.write([...merged.values()]);
    }
    lines.push(`${s.name}: ${mode === 'replace' ? `${s.rows.length} rows` : `${s.added} added, ${s.updated} updated`}`);
  }
  pendingImport.write({ plan: null, file: '' });
  return [`Imported ${file} (${mode}):`, ...lines].join('\n');
}
