/**
 * /spending and /results, shared by the CLI and Telegram so both answer the same.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { jsonFile } from '../utils/json-store.js';
import { baseCurrency, money } from '../utils/locale.js';
import { parseCsv } from '../importer/parse.js';
import { parseStatement, type StatementPreview } from './import.js';
import { spendingStore } from './store.js';
import { buildReport } from './report.js';
import { writeReportFiles } from './export.js';

const pending = jsonFile<{ preview: StatementPreview | null; file: string }>('personal/pending-import.json', { preview: null, file: '' });

const norm = (h: string) => h.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** A bank or card statement rather than a broker export: payee or booking text, and no securities columns. */
export function looksLikeBankStatement(text: string, hint = ''): boolean {
  if (/bank|statement|spending|ausgaben|kontoauszug|umsatz|card|karte|purchases/i.test(hint)) return true;
  const header = parseCsv(text).slice(0, 15).map((r) => r.map(norm)).find((r) => r.some((c) => ['date', 'datum', 'buchungstag', 'bookingdate'].includes(c)));
  if (!header) return false;
  const securities = header.some((c) => ['isin', 'shares', 'quantity', 'stuck', 'stueck', 'anzahl', 'symbol', 'ticker'].includes(c));
  const payee = header.some((c) => /empf|payee|beneficiary|counterparty|verwendungszweck|buchungstext|merchant|auftraggeber/.test(c));
  return payee && !securities;
}

export function describeStatement(p: StatementPreview, file: string): string {
  if (!p.purchases.length) return [`Nothing to import from ${file}.`, ...p.warnings].join('\n');
  const total = p.purchases.reduce((s, x) => s + x.amount, 0);
  const byCat = new Map<string, number>();
  for (const x of p.purchases) byCat.set(x.category, (byCat.get(x.category) ?? 0) + x.amount);
  const dates = p.purchases.map((x) => x.date).sort();
  return [
    `${file}: ${p.purchases.length} purchases, ${dates[0]} to ${dates.at(-1)}, ${money(total, p.purchases[0]!.currency)}.`,
    ...[...byCat].sort((a, b) => b[1] - a[1]).map(([c, v]) => `  ${c.padEnd(14)} ${money(v, p.purchases[0]!.currency)}`),
    `Skipped: ${p.skipped_income} incoming, ${p.duplicates} already recorded. Linked to subscriptions: ${p.linked_to_subscriptions}.`,
    ...p.warnings,
    'Save them with /spending confirm, or /spending cancel. Categories can be corrected afterwards and RUBEN learns the merchant.',
  ].join('\n');
}

export function spendingFromText(text: string, file: string, hint = ''): string {
  const account = hint.match(/account[:= ](\S+)/i)?.[1];
  const preview = parseStatement(text, { currency: baseCurrency(), account });
  pending.write({ preview, file });
  return describeStatement(preview, file);
}

export async function runSpendingCommand(args: string): Promise<string> {
  const [first = '', ...rest] = args.trim().split(/\s+/);
  if (first === 'confirm') {
    const { preview, file } = pending.read();
    if (!preview?.purchases.length) return 'No statement waiting. Send a bank CSV first.';
    const store = spendingStore.read();
    store.purchases.push(...preview.purchases);
    spendingStore.write(store);
    pending.write({ preview: null, file: '' });
    return `Saved ${preview.purchases.length} purchases from ${file}.`;
  }
  if (first === 'cancel') {
    pending.write({ preview: null, file: '' });
    return 'Statement import cancelled.';
  }
  if (first) {
    const path = first.replace(/^["']|["']$/g, '');
    try {
      return spendingFromText(await readFile(path, 'utf8'), basename(path), rest.join(' '));
    } catch {
      return `Cannot read "${path}".`;
    }
  }
  const r = await buildReport('this_month');
  const line = (k: string) => r.summary.find((m) => m.metric === k);
  return [
    `This month so far (${r.base_currency}):`,
    `  purchases ${line('Purchases')?.current ?? 0} · subscriptions ${line('Subscriptions')?.current ?? 0} · income ${line('Total income (net)')?.current ?? 0}`,
    ...r.categories.filter((c) => c.current > 0 || c.budget).slice(0, 8).map((c) => `  ${c.category.padEnd(14)} ${c.current}${c.budget ? ` of ${c.budget}` : ''}`),
    'Import a statement: /spending <path to CSV>, or send the CSV to the Telegram bot.',
  ].join('\n');
}

/** /results [period] [xlsx|csv|both]: build the files; returns their paths and a short summary. */
export async function runReportCommand(args: string): Promise<{ text: string; files: string[] }> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const format = (parts.find((p) => ['xlsx', 'csv', 'both'].includes(p)) ?? 'xlsx') as 'xlsx' | 'csv' | 'both';
  const period = parts.find((p) => !['xlsx', 'csv', 'both'].includes(p)) ?? 'last_month';
  let r;
  try {
    r = await buildReport(period);
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), files: [] };
  }
  const files = await writeReportFiles(r, format);
  const m = (k: string) => r.summary.find((x) => x.metric === k);
  const fmt = (k: string) => { const x = m(k); return `${x?.current ?? 0}${x?.change_pct != null ? ` (${x.change_pct > 0 ? '+' : ''}${x.change_pct}% vs ${r.previous.id})` : ''}`; };
  return {
    files,
    text: [
      `Results ${r.period.id} (${r.base_currency})`,
      `Income ${fmt('Total income (net)')}`,
      `Expenses ${fmt('Total expenses')}`,
      `Net cash flow ${fmt('Net cash flow')} · savings rate ${m('Savings rate %')?.current ?? '-'}%`,
      ...(r.suggestions.length ? ['Top savings:', ...r.suggestions.slice(0, 3).map((s) => `• ${s}`)] : []),
    ].join('\n'),
  };
}
