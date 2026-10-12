import { describe, expect, test } from 'bun:test';
import { DEFAULT_THRESHOLDS, forecastFromCloses, lookThrough, priceAlerts } from './analysis.js';
import { nextTwelveMonths, type Commitment } from './tools.js';

describe('asset forecast', () => {
  test('a steady 10 % a year with no noise gives a point, not a range', () => {
    const closes = Array.from({ length: 253 * 3 }, (_, i) => 100 * Math.exp((Math.log(1.1) / 252) * i));
    const f = forecastFromCloses(closes)!;
    expect(f.cagr_pct).toBeCloseTo(10, 1);
    expect(f.volatility_pct).toBeCloseTo(0, 6);
    const one = f.horizons[0]!;
    expect(one.p10).toBeCloseTo(one.p90, 2);
    expect(one.p50).toBeCloseTo(closes.at(-1)! * 1.1, 0);
  });

  test('volatility widens the range and the drawdown is measured', () => {
    const closes = Array.from({ length: 600 }, (_, i) => 100 * (1 + 0.2 * Math.sin(i / 20)));
    const f = forecastFromCloses(closes)!;
    expect(f.horizons[2]!.p90 - f.horizons[2]!.p10).toBeGreaterThan(f.horizons[0]!.p90 - f.horizons[0]!.p10);
    expect(f.max_drawdown_pct).toBeCloseTo(33.33, 0);
  });

  test('under a year of data is refused', () => {
    expect(forecastFromCloses([1, 2, 3])).toBeNull();
  });
});

describe('fund look-through', () => {
  test('the same company through two funds and directly adds up, and is shown as overlap', () => {
    const r = lookThrough(
      [
        { ticker: 'WORLD', value: 10_000, expenseRatio: 0.002, holdings: [{ symbol: 'AAPL', name: 'Apple', weight: 0.05 }], sectors: { technology: 0.3 } },
        { ticker: 'US', value: 10_000, expenseRatio: 0.0007, holdings: [{ symbol: 'AAPL', name: 'Apple', weight: 0.07 }], sectors: { technology: 0.4 } },
      ],
      [{ ticker: 'AAPL', value: 1000 }],
    );
    const apple = r.top_underlying.find((t) => t.symbol === 'AAPL')!;
    expect(apple.value).toBe(2200);
    expect(apple.via.sort()).toEqual(['US', 'WORLD', 'direct']);
    expect(r.overlap.length).toBe(1);
    expect(r.annual_fund_cost).toBe(27);
    expect(r.fund_sectors_pct.technology).toBe(35);
  });
});

describe('price alerts', () => {
  test('a quiet holding raises nothing', () => {
    expect(priceAlerts(Array(260).fill(100), DEFAULT_THRESHOLDS, { avgCost: 100 })).toEqual([]);
  });

  test('a crash trips the day, week, high and cost checks and the stop', () => {
    const closes = [...Array(250).fill(100), 95, 92, 90, 85, 70];
    const w = priceAlerts(closes, DEFAULT_THRESHOLDS, { avgCost: 100, stopLoss: 75 }).join(' | ');
    expect(w).toContain('in a day');
    expect(w).toContain('in a week');
    expect(w).toContain('52-week high');
    expect(w).toContain("owner's cost");
    expect(w).toContain('stop-loss');
  });
});

describe('commitments', () => {
  const base: Commitment = { id: 'x', name: 'ETF plan', kind: 'savings_plan', amount: 200, currency: 'EUR', frequency: 'monthly' };
  test('monthly is twelve payments', () => expect(nextTwelveMonths(base, '2026-10-12')).toBe(2400));
  test('ended plans cost nothing', () => expect(nextTwelveMonths({ ...base, end: '2026-01-01' }, '2026-10-12')).toBe(0));
  test('a one-off counts only when due inside the year', () => {
    expect(nextTwelveMonths({ ...base, frequency: 'once', due: '2027-03-01' }, '2026-10-12')).toBe(200);
    expect(nextTwelveMonths({ ...base, frequency: 'once', due: '2028-03-01' }, '2026-10-12')).toBe(0);
  });
});
