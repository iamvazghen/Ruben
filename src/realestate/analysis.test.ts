import { describe, expect, test } from 'bun:test';
import { amortize, monthsToPayoff, rentalResult, reviewProperty, type Property } from './analysis.js';

const flat: Property = {
  id: 'flat', name: 'Flat', type: 'apartment', country: 'DE', city: 'Leipzig', currency: 'EUR',
  size_m2: 60, purchase_date: '2024-07-01', purchase_price: 240_000, purchase_costs: 24_000, land_share_pct: 25,
  value: { amount: 250_000, as_of: '2026-06-01', source: 'test' },
  use: 'rented', rent_monthly: 780, costs_monthly: 60, property_tax_annual: 300, insurance_annual: 200,
  market_rent_m2: { amount: 15, as_of: '2026-06-01', source: 'test' }, depreciation_rate_pct: 2,
  mortgages: [{ lender: 'Bank', balance: 200_000, balance_date: '2026-10-01', rate_pct: 3.6, monthly_payment: 900, fixed_until: '2027-12-31', original_principal: 210_000 }],
};

describe('mortgage maths', () => {
  test('one annuity month: interest on the balance, the rest repays', () => {
    const m = amortize(200_000, 3.6, 900, 1);
    expect(m.interest).toBeCloseTo(600, 6);
    expect(m.principal).toBeCloseTo(300, 6);
    expect(m.balance).toBeCloseTo(199_700, 6);
  });

  test('payoff: closed form agrees with running the schedule', () => {
    const n = monthsToPayoff(200_000, 3.6, 900);
    expect(amortize(200_000, 3.6, 900, n).balance).toBe(0);
    expect(amortize(200_000, 3.6, 900, n - 1).balance).toBeGreaterThan(0);
  });

  test('an instalment below the interest never repays', () => {
    expect(monthsToPayoff(200_000, 6, 900)).toBe(Infinity);
  });
});

describe('property review', () => {
  const r = reviewProperty(flat, '2026-10-01', 4.0);

  test('yield, cash flow and leverage', () => {
    expect(r.rent_annual).toBe(9360);
    expect(r.noi_annual).toBe(9360 - 720 - 300 - 200);
    expect(r.cash_flow_annual).toBe(r.noi_annual - 10_800);
    expect(r.ltv_pct).toBe(80);
    expect(r.gross_yield_pct).toBeCloseTo(3.74, 2);
  });

  test('rent per m² against the market, and the gap flagged', () => {
    expect(r.rent_m2).toBe(13);
    expect(r.rent_gap_pct).toBeCloseTo(-13.33, 2);
    expect(r.flags.some((f) => f.includes('below the local market'))).toBe(true);
  });

  test('a fixation ending within two years is priced at the market rate', () => {
    const fix = r.refinancing[0]!;
    expect(fix.months_left).toBe(15);
    expect(fix.extra_interest_per_year_at_market).toBeCloseTo(fix.balance_then * 0.004, 1);
    expect(r.flags.some((f) => f.includes('fixation ends'))).toBe(true);
    expect(r.flags.some((f) => f.includes('negative cash flow'))).toBe(true);
  });
});

describe('rental tax result', () => {
  test('depreciation is on the building share, pro rata in the purchase year', () => {
    const basis = 264_000 * 0.75;
    expect(rentalResult(flat, 2025).depreciation).toBeCloseTo(basis * 0.02, 2);
    expect(rentalResult(flat, 2024).depreciation).toBeCloseTo(basis * 0.02 * 6 / 12, 2);
    expect(rentalResult(flat, 2023).depreciation).toBe(0);
  });

  test('result = rent - interest - costs - depreciation', () => {
    const y = rentalResult(flat, 2027);
    expect(y.result).toBeCloseTo(y.rent - y.interest - y.costs - y.depreciation, 1);
    expect(y.interest).toBeGreaterThan(6000);
    expect(y.interest).toBeLessThan(7300);
  });
});
