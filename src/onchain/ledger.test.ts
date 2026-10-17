import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invalid, latest, readAll, renderReport, report, store, window, type OnchainRecord } from './ledger.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ruben-onchain-'));
  process.env.RUBEN_HOME = home;
});
afterEach(() => {
  delete process.env.RUBEN_HOME;
  rmSync(home, { recursive: true, force: true });
});

const base = (o: Partial<OnchainRecord>): OnchainRecord => ({
  id: 'tx_1', status: 'planned', at: '2026-10-05T10:00:00Z', created_at: '2026-10-05T10:00:00Z',
  chain: 'base', kind: 'transfer', purpose: 'friend_transfer', purpose_detail: 'Aram, dinner on Friday',
  asset: 'USDC', amount: '40', to: '0xabc', counterparty: 'Aram (friend)', amount_eur: 36.9,
  fee_native: '0.00002', fee_asset: 'ETH', fee_eur: 0.05, ...o,
});

describe('on-chain ledger', () => {
  test('a record that cannot be explained later is refused now', () => {
    expect(invalid({ ...base({}), purpose_detail: '' })).toContain('purpose_detail');
    expect(invalid(base({ status: 'broadcast' }))).toContain('tx_hash');
    const res = store([{ ...base({}), purpose: '' }]);
    expect(res.stored).toBe(0);
    expect(res.errors.length).toBe(1);
  });

  test('state changes are appended, duplicates are not, and the latest state wins', () => {
    store([base({}), base({ status: 'broadcast', at: '2026-10-05T10:01:00Z', tx_hash: '0xh', approver: 'edith' })]);
    const again = store([base({})]);
    expect(again.skipped).toBe(1);
    expect(readAll().length).toBe(2);
    expect(latest()[0].status).toBe('broadcast');
  });

  test('periods: month, quarter, year', () => {
    expect(window('month', '2026-10').from).toBe('2026-10-01T00:00:00.000Z');
    expect(window('quarter', '2026-Q4').label).toBe('2026-Q4');
    expect(window('quarter', '2026-11').from).toBe('2026-10-01T00:00:00.000Z');
    expect(window('year', '2026').to).toBe('2027-01-01T00:00:00.000Z');
  });

  test('the report totals what was sent, says what was refused, and explains each one', () => {
    store([
      base({ status: 'broadcast', tx_hash: '0xa', approver: 'edith' }),
      base({ id: 'tx_2', kind: 'swap', purpose: 'exchange', purpose_detail: 'ETH to USDC for rent',
        asset: 'ETH', amount: '0.1', amount_eur: 250, status: 'broadcast', tx_hash: '0xb', approver: 'owner',
        details: { to_asset: 'USDC', expected_rate: '2500' } }),
      base({ id: 'tx_3', status: 'refused', decision_reasons: ['security scan flagged it'] }),
      base({ id: 'tx_4', created_at: '2026-09-01T00:00:00Z', status: 'broadcast', tx_hash: '0xc' }),
    ]);
    const r = report('month', '2026-10');
    expect(r.sent).toBe(2);
    expect(r.refused).toBe(1);
    expect(r.volume_eur).toBeCloseTo(286.9);
    expect(r.by_purpose.exchange.count).toBe(1);
    const text = renderReport(r);
    expect(text).toContain('expected_rate=2500');
    expect(text).toContain('security scan flagged it');
    expect(report('quarter', '2026-Q3').sent).toBe(1);
  });
});
