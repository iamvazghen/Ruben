/**
 * Portfolio tools. Four actions: view, add, remove, journal.
 *
 * The agent sees one tool per action (not a single tool with action=).
 * Each tool has its own focused Zod schema, which LangChain tool-calling
 * handles better than a fat union.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { PortfolioStore, type Position, type Conviction } from './store.js';

const PORTFOLIO_VIEW_DESCRIPTION = `
Read the user's portfolio. Returns open positions, recent closed positions,
and journal entries.

Use this:
- ALWAYS before giving personalized financial advice
- Before sizing a new position (the position-sizing skill calls this)
- Before writing a trade-review or memo that references current holdings
- When the user asks "what do I own" or "what's my exposure to X"

The view is structured JSON; format a friendly summary in your response.
`.trim();

const PORTFOLIO_ADD_DESCRIPTION = `
Add a new open position to the portfolio. The agent should confirm with the
user before calling this — adding a position is a real, durable state change.

Any asset class in any country: stocks, ETFs, funds, bonds, crypto (data_symbol
BTC-USD), commodities (GC=F for gold per oz, or a physical bar with unit and
manual_price), cash at a bank (asset_type cash, ticker CASH-EUR, shares = the
balance, avg_cost 1), and private assets (asset_type other with manual_price).
Always set "account" so the holding is tied to its institution and country.

Required: ticker, shares, avg_cost, currency, opened (YYYY-MM-DD), thesis,
conviction. For cash and private assets a short purpose is enough as thesis.

Don't invent a target_price or stop_loss; zeros are not stops.
`.trim();

const PORTFOLIO_REMOVE_DESCRIPTION = `
Close an existing open position. Move it to the closed-history list with the
exit price, realized P&L, and (optionally) a lesson learned.

If the user does not supply a lesson, prompt them. Closing a trade without
recording what you learned is wasted alpha.
`.trim();

const PORTFOLIO_JOURNAL_DESCRIPTION = `
Append a free-form note to the journal. Use for observations, trade ideas,
post-mortems, sector notes — anything the user wants the agent to remember
across sessions.

The portfolio journal is separate from MEMORY.md (long-term memory) and the
daily memory log. Use it specifically for portfolio-related context.
`.trim();

const PORTFOLIO_SET_RISK_DESCRIPTION = `
Set the user's risk profile (total capital USD, max % per trade, max
drawdown tolerance). The position-sizing skill reads this.

If the user has not stated a risk profile, ask. Don't assume 1% / 20% drawdown
— that's a hedge fund default, not everyone.
`.trim();

const store = new PortfolioStore();

export const portfolioView = new DynamicStructuredTool({
  name: 'portfolio_view',
  description: PORTFOLIO_VIEW_DESCRIPTION,
  schema: z.object({}),
  func: async () => {
    const p = store.read();
    return formatToolResult({
      total_capital_usd: p.total_capital_usd,
      risk_budget_pct: p.risk_budget_pct,
      max_drawdown_pct: p.max_drawdown_pct,
      open_positions: p.positions,
      open_count: p.positions.length,
      closed_count: p.closed.length,
      recent_closed: p.closed.slice(0, 5),
      recent_journal: p.journal.slice(0, 5),
      notes: p.notes,
      updated: p.updated,
    });
  },
});

const ASSET_TYPES = ['stock', 'etf', 'fund', 'bond', 'cash', 'crypto', 'commodity', 'other'] as const;

const positionFields = {
  asset_type: z.enum(ASSET_TYPES).optional().describe('stock, etf, fund, bond, cash, crypto, commodity or other (private equity, art, unlisted)'),
  account: z.string().optional().describe('Account id where it is held (see accounts); this sets its jurisdiction'),
  data_symbol: z.string().optional().describe('Market-data symbol when it differs: VWCE.DE, BTC-USD, ETH-EUR, GC=F (gold, USD/oz), SI=F'),
  isin: z.string().optional(),
  name: z.string().optional(),
  unit: z.string().optional().describe('What one unit is when not a share: oz, g, coin, bar'),
  manual_price: z.object({ amount: z.number(), currency: z.string(), as_of: z.string() }).optional()
    .describe('Price per unit for anything without a quote, dated'),
  target_price: z.number().optional(),
  stop_loss: z.number().optional(),
  size_rationale: z.string().optional(),
};

export const portfolioAdd = new DynamicStructuredTool({
  name: 'portfolio_add',
  description: PORTFOLIO_ADD_DESCRIPTION,
  schema: z.object({
    ticker: z.string().describe('Ticker or identifier: AAPL, VWCE, BTC, GOLD-BAR, CASH-EUR'),
    shares: z.number().describe('Quantity: shares, coins, ounces, or the cash amount for cash'),
    avg_cost: z.number().describe('Average cost per unit in `currency` (1 for cash)'),
    currency: z.string().default('USD').describe('Currency of the cost (EUR, USD, GBp, AMD…)'),
    opened: z.string().describe('Date opened in YYYY-MM-DD.'),
    thesis: z.string().describe('One-sentence reason for the position.'),
    conviction: z.enum(['low', 'med', 'high'] as const).describe('Conviction in the thesis.'),
    ...positionFields,
  }),
  func: async (input) => {
    const pos: Position = {
      ...input,
      ticker: input.ticker.toUpperCase(),
      currency: input.currency.toUpperCase(),
      conviction: input.conviction as Conviction,
    };
    try {
      const p = store.addPosition(pos);
      return formatToolResult({ ok: true, position: pos, total_open: p.positions.length });
    } catch (error) {
      return formatToolResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

/** The one position a ticker (and account, when given) points at; an error naming the choices when ambiguous. */
function locate(positions: Position[], ticker: string, account?: string): number | string {
  const hits = positions.map((x, i) => ({ x, i })).filter(({ x }) =>
    x.ticker.toUpperCase() === ticker.toUpperCase() && (!account || (x.account ?? '') === account));
  if (hits.length === 1) return hits[0]!.i;
  if (!hits.length) return `No open position in ${ticker.toUpperCase()}${account ? ` at ${account}` : ''}.`;
  return `${ticker.toUpperCase()} is held in several accounts (${hits.map((h) => h.x.account ?? 'none').join(', ')}): name the account.`;
}

export const portfolioUpdate = new DynamicStructuredTool({
  name: 'portfolio_update',
  description:
    'Change an open position in place: quantity and average cost after a purchase or partial sale you are recording, a new manual price, the account, thesis, conviction, target or stop. A durable change: confirm with the owner first.',
  schema: z.object({
    ticker: z.string(),
    account: z.string().optional().describe('Needed when the ticker is held in several accounts'),
    shares: z.number().optional(),
    avg_cost: z.number().optional(),
    thesis: z.string().optional(),
    conviction: z.enum(['low', 'med', 'high'] as const).optional(),
    new_account: z.string().optional().describe('Move the position to another account (e.g. after a broker transfer)'),
    ...Object.fromEntries(Object.entries(positionFields).filter(([k]) => k !== 'account')) as Omit<typeof positionFields, 'account'>,
  }),
  func: async ({ ticker, account, new_account, ...changes }) => {
    try {
      let updated: Position | undefined;
      store.update((p) => {
        const i = locate(p.positions, ticker, account);
        if (typeof i === 'string') throw new Error(i);
        const clean = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
        updated = { ...p.positions[i]!, ...clean, ...(new_account ? { account: new_account } : {}) } as Position;
        const positions = [...p.positions];
        positions[i] = updated;
        return { ...p, positions };
      });
      return formatToolResult({ ok: true, position: updated });
    } catch (error) {
      return formatToolResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const portfolioRemove = new DynamicStructuredTool({
  name: 'portfolio_remove',
  description: PORTFOLIO_REMOVE_DESCRIPTION,
  schema: z.object({
    ticker: z.string().describe('Ticker of the position to close.'),
    account: z.string().optional().describe('Needed when the ticker is held in several accounts'),
    shares: z.number().optional().describe('Sell only this many (partial sale); default all'),
    exit_price: z.number().describe('Exit price per share.'),
    closed: z.string().describe('Closing date YYYY-MM-DD.'),
    lesson: z.string().default('').describe('What you learned (encouraged but optional).'),
  }),
  func: async (input) => {
    const upper = input.ticker.toUpperCase();
    try {
    return formatToolResult(
      store.update((p) => {
        const found = locate(p.positions, upper, input.account);
        if (typeof found === 'string') throw new Error(found);
        const idx = found;
        const held = p.positions[idx]!;
        const sold = input.shares && input.shares < held.shares ? input.shares : held.shares;
        const pos = { ...held, shares: sold };
        const realizedPnl = pos.shares * (input.exit_price - pos.avg_cost);
        const realizedPnlPct = pos.avg_cost === 0 ? 0 : ((input.exit_price - pos.avg_cost) / pos.avg_cost) * 100;
        const closed = {
          ...pos,
          closed: input.closed,
          exit_price: input.exit_price,
          realized_pnl: realizedPnl,
          realized_pnl_pct: realizedPnlPct,
          lesson: input.lesson,
        };
        return {
          ...p,
          // A partial sale keeps the rest open at the same average cost.
          positions: sold < held.shares
            ? p.positions.map((x, i) => (i === idx ? { ...x, shares: held.shares - sold } : x))
            : p.positions.filter((_, i) => i !== idx),
          closed: [closed, ...p.closed],
        };
      }),
    );
    } catch (error) {
      return formatToolResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const portfolioJournal = new DynamicStructuredTool({
  name: 'portfolio_journal',
  description: PORTFOLIO_JOURNAL_DESCRIPTION,
  schema: z.object({
    text: z.string().describe('Free-form journal entry.'),
    category: z.enum(['observation', 'trade', 'idea', 'lesson'] as const).optional(),
  }),
  func: async (input) => {
    return formatToolResult(
      store.update((p) => ({
        ...p,
        journal: [
          {
            date: new Date().toISOString().slice(0, 10),
            text: input.text,
            category: input.category,
          },
          ...p.journal,
        ],
      })),
    );
  },
});

export const portfolioSetRisk = new DynamicStructuredTool({
  name: 'portfolio_set_risk',
  description: PORTFOLIO_SET_RISK_DESCRIPTION,
  schema: z.object({
    total_capital_usd: z.number().optional().describe('Total capital under management in USD.'),
    risk_budget_pct: z.number().optional().describe('Max % of capital to risk on a single new position (e.g., 1.0 = 1%).'),
    max_drawdown_pct: z.number().optional().describe('Max portfolio drawdown before forced de-risk (e.g., 20.0 = 20%).'),
  }),
  func: async (input) => {
    return formatToolResult(
      store.update((p) => ({
        ...p,
        ...(input.total_capital_usd !== undefined ? { total_capital_usd: input.total_capital_usd } : {}),
        ...(input.risk_budget_pct !== undefined ? { risk_budget_pct: input.risk_budget_pct } : {}),
        ...(input.max_drawdown_pct !== undefined ? { max_drawdown_pct: input.max_drawdown_pct } : {}),
      })),
    );
  },
});