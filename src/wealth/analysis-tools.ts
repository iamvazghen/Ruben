import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { baseCurrency } from '../utils/locale.js';
import { yahoo } from '../market/yahoo.js';
import { valueHoldings } from '../rebalance/check.js';
import { incomeStore } from '../income/store.js';
import { DEFAULT_THRESHOLDS, forecastFromCloses, lookThrough, priceAlerts, type FundInput } from './analysis.js';

export const assetForecastTool = new DynamicStructuredTool({
  name: 'asset_forecast',
  description:
    "Statistical price range for any listed asset (stock, ETF, fund, index, crypto, commodity future) 1, 3 and 5 years out — 10th, 50th and 90th percentile — from up to 10 years of its own price history, with CAGR, volatility, worst drawdown, and the uncertainty of the drift itself. A range from history, not a prediction: combine it with fundamentals (grade_ticker, fmp_dcf_valuation, analyst targets) and say so when presenting.",
  schema: z.object({ symbol: z.string().describe('Yahoo symbol, e.g. AAPL, VWCE.DE, BTC-USD, GC=F') }),
  func: async ({ symbol }) => {
    const h = await yahoo.history!(symbol, '10y');
    const f = h && forecastFromCloses(h.closes.map((c) => c.close));
    if (!h || !f) return formatToolResult({ symbol, error: 'not enough price history (needs about a year)' });
    return formatToolResult({ symbol, currency: h.currency, last_close: h.closes.at(-1), ...f });
  },
});

export const fundLookThroughTool = new DynamicStructuredTool({
  name: 'fund_look_through',
  description:
    "Opens up the owner's ETFs and funds: what they really own underneath (largest underlying companies across all funds plus direct holdings), where funds overlap, sector mix, each fund's expense ratio and the total annual fund cost in the base currency. Coverage is the funds' top-10 holdings, reported as a percentage.",
  schema: z.object({}),
  func: async () => {
    const { holdings, missing } = await valueHoldings(yahoo);
    const funds: FundInput[] = [];
    const direct: { ticker: string; value: number }[] = [];
    const noData: string[] = [];
    for (const h of holdings) {
      const t = h.position.asset_type;
      if (t === 'cash') continue;
      if (t !== 'etf') { direct.push({ ticker: h.position.ticker, value: h.value }); continue; }
      const f = await yahoo.fund!(h.position.data_symbol ?? h.position.ticker);
      if (!f) { noData.push(h.position.ticker); continue; }
      funds.push({ ticker: h.position.ticker, value: h.value, expenseRatio: f.expenseRatio, holdings: f.holdings, sectors: f.sectors });
    }
    if (!funds.length) return formatToolResult({ note: 'No ETF or fund positions with holdings data.', no_data: noData, missing_prices: missing });
    return formatToolResult({
      base_currency: baseCurrency(),
      ...lookThrough(funds, direct),
      funds: funds.map((f) => ({ ticker: f.ticker, value: Math.round(f.value * 100) / 100, expense_ratio_pct: f.expenseRatio == null ? null : Math.round(f.expenseRatio * 10000) / 100 })),
      no_holdings_data: noData,
      missing_prices: missing,
    });
  },
});

export const portfolioAlertsTool = new DynamicStructuredTool({
  name: 'portfolio_alerts',
  description:
    "Deterministic health check of every holding: sharp daily or weekly falls, distance from the 52-week high, loss against the owner's cost, stop-loss or target reached, and dividend cuts or high cut risk from the income calendar. Returns only holdings with a warning. It does not read news: follow up on each flagged holding with get_company_news (and news_materiality when available) before recommending a change.",
  schema: z.object({
    day_pct: z.number().optional(), week_pct: z.number().optional(),
    from_high_pct: z.number().optional(), loss_from_cost_pct: z.number().optional(),
  }),
  func: async (overrides) => {
    const t = { ...DEFAULT_THRESHOLDS, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)) };
    const { holdings } = await valueHoldings(yahoo);
    const total = holdings.reduce((s, h) => s + h.value, 0);
    const events = incomeStore.calendar().events;
    const alerts = [];
    for (const h of holdings) {
      const p = h.position;
      if (p.asset_type === 'cash') continue;
      const hist = await yahoo.history!(p.data_symbol ?? p.ticker, '1y');
      const closes = hist?.closes.map((c) => c.close) ?? [];
      // The owner's cost is only comparable when it is in the quote's currency.
      const sameCcy = hist && hist.currency === p.currency;
      const warnings = priceAlerts(closes, t, {
        avgCost: sameCcy ? p.avg_cost : undefined, stopLoss: sameCcy ? p.stop_loss : undefined, target: sameCcy ? p.target_price : undefined,
      });
      for (const e of events.filter((e) => e.ticker === p.ticker)) {
        if (e.previousPerShare && e.perShare < e.previousPerShare * 0.95) warnings.push(`dividend cut: ${e.perShare} after ${e.previousPerShare} per share (${e.exDate})`);
        if (e.cutRisk != null && e.cutRisk >= 0.35) warnings.push(`dividend cut probability ${Math.round(e.cutRisk * 100)}% (Jev)`);
      }
      if (warnings.length) alerts.push({ ticker: p.ticker, weight_pct: total ? Math.round((h.value / total) * 10000) / 100 : 0, thesis: p.thesis, warnings: [...new Set(warnings)] });
    }
    return formatToolResult({ thresholds: t, checked: holdings.length, alerts: alerts.sort((a, b) => b.weight_pct - a.weight_pct) });
  },
});
