/**
 * Pure numbers behind the forecast, look-through and alert tools, kept apart
 * so they can be tested without a network.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const Z90 = 1.2815515655446004; // standard normal 90th percentile

export interface Forecast {
  years_of_data: number;
  cagr_pct: number;
  volatility_pct: number;
  max_drawdown_pct: number;
  /** Uncertainty of the historical drift itself: one standard error, in percent a year. */
  drift_std_error_pct: number;
  horizons: { years: number; p10: number; p50: number; p90: number }[];
}

/**
 * A statistical range, not a prediction: daily log returns give a drift and a
 * volatility, and the price after T years is taken as lognormal around them.
 * The drift's own standard error is reported because over a few years it is
 * usually as large as the drift — the honest headline is the spread.
 */
export function forecastFromCloses(closes: number[], horizons = [1, 3, 5]): Forecast | null {
  if (closes.length < 250) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const n = rets.length;
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const years = n / 252;
  const mu = mean * 252;
  const sigma = sd * Math.sqrt(252);
  let peak = closes[0]!, maxDd = 0;
  for (const c of closes) { peak = Math.max(peak, c); maxDd = Math.max(maxDd, 1 - c / peak); }
  const last = closes[closes.length - 1]!;
  return {
    years_of_data: r2(years),
    cagr_pct: r2((Math.exp(mu) - 1) * 100),
    volatility_pct: r2(sigma * 100),
    max_drawdown_pct: r2(maxDd * 100),
    drift_std_error_pct: r2((sigma / Math.sqrt(years)) * 100),
    horizons: horizons.map((t) => ({
      years: t,
      p10: r2(last * Math.exp(mu * t - Z90 * sigma * Math.sqrt(t))),
      p50: r2(last * Math.exp(mu * t)),
      p90: r2(last * Math.exp(mu * t + Z90 * sigma * Math.sqrt(t))),
    })),
  };
}

export interface FundInput {
  ticker: string;
  value: number;
  expenseRatio?: number;
  holdings: { symbol: string; name: string; weight: number }[];
  sectors: Record<string, number>;
}

/** What the owner really holds once funds are opened up: underlying names, sectors, overlap and cost. */
export function lookThrough(funds: FundInput[], direct: { ticker: string; value: number }[]) {
  const exposure = new Map<string, { name: string; value: number; via: Set<string> }>();
  const add = (symbol: string, name: string, value: number, via: string) => {
    const key = symbol.toUpperCase().split('.')[0]!;
    const e = exposure.get(key) ?? { name, value: 0, via: new Set<string>() };
    e.value += value; e.via.add(via);
    exposure.set(key, e);
  };
  for (const d of direct) add(d.ticker, d.ticker, d.value, 'direct');
  const sectors: Record<string, number> = {};
  let fundValue = 0, cost = 0, covered = 0;
  for (const f of funds) {
    fundValue += f.value;
    if (f.expenseRatio != null) cost += f.value * f.expenseRatio;
    for (const h of f.holdings) { add(h.symbol || h.name, h.name, f.value * h.weight, f.ticker); covered += f.value * h.weight; }
    for (const [s, w] of Object.entries(f.sectors)) sectors[s] = (sectors[s] ?? 0) + f.value * w;
  }
  const total = fundValue + direct.reduce((s, d) => s + d.value, 0);
  const top = [...exposure].sort((a, b) => b[1].value - a[1].value).slice(0, 15).map(([symbol, e]) => ({
    symbol, name: e.name, value: r2(e.value), weight_pct: total ? r2((e.value / total) * 100) : 0, via: [...e.via],
  }));
  return {
    total_value: r2(total),
    top_underlying: top,
    overlap: top.filter((t) => t.via.length > 1).map((t) => ({ symbol: t.symbol, via: t.via, weight_pct: t.weight_pct })),
    fund_sectors_pct: Object.fromEntries(Object.entries(sectors).map(([s, v]) => [s, fundValue ? r2((v / fundValue) * 100) : 0]).sort((a, b) => Number(b[1]) - Number(a[1]))),
    annual_fund_cost: r2(cost),
    weighted_expense_ratio_pct: fundValue ? r2((cost / fundValue) * 100) : 0,
    look_through_coverage_pct: fundValue ? r2((covered / fundValue) * 100) : 0,
  };
}

export interface AlertThresholds { day_pct: number; week_pct: number; from_high_pct: number; loss_from_cost_pct: number }
export const DEFAULT_THRESHOLDS: AlertThresholds = { day_pct: 5, week_pct: 10, from_high_pct: 25, loss_from_cost_pct: 20 };

/** Price-based warnings for one holding from a year of daily closes (oldest first). */
export function priceAlerts(
  closes: number[],
  t: AlertThresholds,
  opts: { avgCost?: number; stopLoss?: number; target?: number } = {},
): string[] {
  const out: string[] = [];
  if (closes.length < 6) return out;
  const last = closes[closes.length - 1]!;
  const day = (last / closes[closes.length - 2]! - 1) * 100;
  const week = (last / closes[closes.length - 6]! - 1) * 100;
  const high = Math.max(...closes);
  const fromHigh = (1 - last / high) * 100;
  if (day <= -t.day_pct) out.push(`fell ${r2(-day)}% in a day`);
  if (week <= -t.week_pct) out.push(`fell ${r2(-week)}% in a week`);
  if (fromHigh >= t.from_high_pct) out.push(`${r2(fromHigh)}% below its 52-week high`);
  if (opts.avgCost && (1 - last / opts.avgCost) * 100 >= t.loss_from_cost_pct) out.push(`${r2((1 - last / opts.avgCost) * 100)}% below the owner's cost`);
  if (opts.stopLoss && last <= opts.stopLoss) out.push(`at or below the stop-loss ${opts.stopLoss}`);
  if (opts.target && last >= opts.target) out.push(`reached the target price ${opts.target}: review whether to take profit`);
  return out;
}
