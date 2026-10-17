import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rubenPath } from '../utils/paths.js';

/**
 * Every on-chain transaction the fleet touches, as Hugh (Mushegh's DUM-E) reported it: what it was
 * for, what it cost, who approved it and what happened. Append-only JSONL under `.ruben/onchain/`,
 * one line per state change, so the history of a transaction (planned → approved → broadcast, or
 * refused) is kept rather than overwritten. Reports read the LATEST state per id.
 */

export type OnchainStatus = 'planned' | 'awaiting_owner' | 'refused' | 'broadcast' | 'confirmed' | 'failed' | 'expired';

export interface OnchainRecord {
  id: string;
  status: OnchainStatus;
  at: string;
  created_at: string;
  chain: string;
  kind: string;
  purpose: string;
  purpose_detail: string;
  asset: string;
  amount: string;
  token_address?: string;
  from?: string;
  to?: string;
  counterparty?: string;
  details?: Record<string, unknown>;
  amount_eur?: number | null;
  fee_native?: string | null;
  fee_asset?: string | null;
  fee_eur?: number | null;
  gas?: number | null;
  route?: unknown;
  decision?: string;
  decision_reasons?: string[];
  approver?: string;
  tx_hash?: string;
  explorer?: string;
  error?: string;
  reported_by?: string;
  received_at?: string;
}

const STATUSES: OnchainStatus[] = ['planned', 'awaiting_owner', 'refused', 'broadcast', 'confirmed', 'failed', 'expired'];
const REQUIRED: (keyof OnchainRecord)[] = ['id', 'status', 'at', 'chain', 'kind', 'purpose', 'purpose_detail', 'asset', 'amount'];

const ledgerPath = () => rubenPath('onchain', 'ledger.jsonl');

/** Why a record cannot be stored, or null. A record RUBEN cannot explain later is refused now. */
export function invalid(r: Partial<OnchainRecord>): string | null {
  const gaps = REQUIRED.filter((k) => r[k] === undefined || r[k] === null || String(r[k]).trim() === '');
  if (gaps.length) return `missing ${gaps.join(', ')}`;
  if (!STATUSES.includes(r.status as OnchainStatus)) return `unknown status ${r.status}`;
  if (Number.isNaN(Number(r.amount))) return `amount is not a number: ${r.amount}`;
  if (r.status === 'broadcast' && !r.tx_hash) return 'a broadcast record needs its tx_hash';
  return null;
}

export function readAll(): OnchainRecord[] {
  if (!existsSync(ledgerPath())) return [];
  return readFileSync(ledgerPath(), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as OnchainRecord];
      } catch {
        return [];
      }
    });
}

/** Store records. Idempotent: the same (id, status, at) twice is stored once. */
export function store(records: Partial<OnchainRecord>[]): { stored: number; skipped: number; errors: string[] } {
  const seen = new Set(readAll().map((r) => `${r.id}|${r.status}|${r.at}`));
  const errors: string[] = [];
  let stored = 0;
  let skipped = 0;
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  for (const r of records) {
    const why = invalid(r);
    if (why) {
      errors.push(`${r.id ?? '?'}: ${why}`);
      continue;
    }
    const key = `${r.id}|${r.status}|${r.at}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    appendFileSync(ledgerPath(), `${JSON.stringify({ ...r, received_at: new Date().toISOString() })}\n`, 'utf8');
    stored++;
  }
  return { stored, skipped, errors };
}

/** The latest state of each transaction. */
export function latest(records = readAll()): OnchainRecord[] {
  const by = new Map<string, OnchainRecord>();
  for (const r of records) by.set(r.id, r);
  return [...by.values()];
}

export type Period = 'month' | 'quarter' | 'year';

/** [start, end) in UTC for a period containing `at` (YYYY, YYYY-MM, YYYY-Qn, or a date). */
export function window(period: Period, at = new Date().toISOString().slice(0, 7)): { from: string; to: string; label: string } {
  const y = Number(at.slice(0, 4));
  let m0 = 0;
  let span = 12;
  if (period === 'month') {
    m0 = Number(at.slice(5, 7) || '1') - 1;
    span = 1;
  } else if (period === 'quarter') {
    const q = /Q(\d)/i.exec(at)?.[1];
    m0 = q ? (Number(q) - 1) * 3 : Math.floor((Number(at.slice(5, 7) || '1') - 1) / 3) * 3;
    span = 3;
  }
  const from = new Date(Date.UTC(y, m0, 1));
  const to = new Date(Date.UTC(y, m0 + span, 1));
  const label = period === 'year' ? `${y}` : period === 'quarter' ? `${y}-Q${m0 / 3 + 1}` : `${y}-${String(m0 + 1).padStart(2, '0')}`;
  return { from: from.toISOString(), to: to.toISOString(), label };
}

export interface Report {
  period: string;
  sent: number;
  refused: number;
  awaiting: number;
  failed: number;
  volume_eur: number;
  fees_eur: number;
  by_purpose: Record<string, { count: number; eur: number }>;
  by_chain: Record<string, { count: number; eur: number; fees_eur: number }>;
  by_kind: Record<string, number>;
  unpriced: string[];
  transactions: OnchainRecord[];
}

export function report(period: Period, at?: string, records = readAll()): Report {
  const w = window(period, at);
  const rows = latest(records).filter((r) => (r.created_at || r.at) >= w.from && (r.created_at || r.at) < w.to);
  const done = rows.filter((r) => r.status === 'broadcast' || r.status === 'confirmed');
  const out: Report = {
    period: w.label,
    sent: done.length,
    refused: rows.filter((r) => r.status === 'refused').length,
    awaiting: rows.filter((r) => r.status === 'awaiting_owner').length,
    failed: rows.filter((r) => r.status === 'failed' || r.status === 'expired').length,
    volume_eur: 0,
    fees_eur: 0,
    by_purpose: {},
    by_chain: {},
    by_kind: {},
    unpriced: [],
    transactions: rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
  };
  for (const r of done) {
    const eur = r.amount_eur ?? 0;
    const fee = r.fee_eur ?? 0;
    if (r.amount_eur == null) out.unpriced.push(`${r.id} (${r.amount} ${r.asset})`);
    out.volume_eur += eur;
    out.fees_eur += fee;
    (out.by_purpose[r.purpose] ??= { count: 0, eur: 0 }).count++;
    out.by_purpose[r.purpose].eur += eur;
    const c = (out.by_chain[r.chain] ??= { count: 0, eur: 0, fees_eur: 0 });
    c.count++;
    c.eur += eur;
    c.fees_eur += fee;
    out.by_kind[r.kind] = (out.by_kind[r.kind] ?? 0) + 1;
  }
  return out;
}

const eur = (n: number) => `€${n.toFixed(2)}`;

export function renderReport(r: Report): string {
  const lines = [
    `On-chain activity ${r.period}: ${r.sent} sent, ${r.refused} refused, ${r.awaiting} awaiting approval, ${r.failed} failed or expired.`,
    `Volume ${eur(r.volume_eur)}, network fees ${eur(r.fees_eur)}.`,
  ];
  if (r.unpriced.length) lines.push(`Not in the totals (no EUR price at the time): ${r.unpriced.join(', ')}.`);
  for (const [p, v] of Object.entries(r.by_purpose)) lines.push(`- ${p}: ${v.count}, ${eur(v.eur)}`);
  for (const [c, v] of Object.entries(r.by_chain)) lines.push(`- on ${c}: ${v.count}, ${eur(v.eur)}, fees ${eur(v.fees_eur)}`);
  lines.push('', 'Transactions:');
  for (const t of r.transactions) {
    const extra = Object.entries(t.details ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
    lines.push(
      `${t.created_at.slice(0, 10)} ${t.status} ${t.kind} ${t.amount} ${t.asset} on ${t.chain}` +
        `${t.amount_eur != null ? ` (${eur(t.amount_eur)})` : ''} → ${t.counterparty || t.to || '?'}; ` +
        `${t.purpose}: ${t.purpose_detail}${extra ? `; ${extra}` : ''}` +
        `${t.fee_native ? `; fee ${t.fee_native} ${t.fee_asset ?? ''}` : ''}` +
        `${t.approver ? `; approved by ${t.approver}` : ''}${t.tx_hash ? `; ${t.explorer || t.tx_hash}` : ''}` +
        `${t.decision_reasons?.length && t.status !== 'broadcast' ? `; why: ${t.decision_reasons.join('; ')}` : ''}`,
    );
  }
  return lines.join('\n');
}
