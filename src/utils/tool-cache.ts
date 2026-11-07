/**
 * Process-global tool result cache.
 *
 * When the agent calls `tool.invoke(args)` with the same tool name + args as a
 * recent call, return the cached result instead of re-hitting the network.
 * This is the "subagent N+1 reads parent agent's recent NVDA price" win.
 *
 * Design choices:
 *   - Process-global (module-level singleton). All AgentToolExecutor instances
 *     in the process share this cache, so subagents inherit the parent's
 *     recent tool results.
 *   - Per-tool TTL: news/freshness-sensitive tools get short TTL; statements
 *     and fundamentals get longer.
 *   - LRU eviction at 200 entries. Bounded memory.
 *   - ONLY tools listed in TOOL_TTL_MS are cached (an allowlist of reads). It was a denylist of
 *     mutating tools until 2026-11-07, when the personal-finance tools added since (spending,
 *     salary, accounts, ...) were being served cached "added" results and nothing was saved.
 */

import { createHash } from 'crypto';

interface CacheEntry {
  result: string;
  ts: number;
  hitCount: number;
}

const MAX_ENTRIES = 200;

// Tools that must NEVER be cached (mutating side effects or non-deterministic).
const MUTATING_TOOLS = new Set<string>([
  'write_file',
  'edit_file',
  'cron',
  'heartbeat',
  'memory_update',
  'portfolio_add',
  'portfolio_remove',
  'portfolio_journal',
  'portfolio_set_risk',
  'run_debate',
  'ask_user_question',
  'spawn_subagent',
  'skill',
]);

// Per-tool TTL in ms. Default 60s.
const TOOL_TTL_MS: Record<string, number> = {
  // News / sentiment — short
  get_company_news: 60_000,
  marketaux_news: 60_000,
  benzinga_news: 60_000,
  newsapi_everything: 60_000,
  get_news: 60_000,
  get_catalyst_calendar: 60_000,
  // Quotes — short
  get_stock_price: 30_000,
  get_crypto_price_snapshot: 30_000,
  polygon_stock_snapshot: 30_000,
  finnhub_quote: 30_000,
  twelvedata_quote: 30_000,
  alphavantage_stock_quote: 30_000,
  coingecko_simple_price: 30_000,
  cmc_quotes: 30_000,
  btc_supply: 30_000,
  btc_network_stats: 30_000,
  // Statements — long
  get_income_statements: 24 * 60 * 60 * 1000,
  get_balance_sheets: 24 * 60 * 60 * 1000,
  get_cash_flow_statements: 24 * 60 * 60 * 1000,
  fmp_income_statement: 24 * 60 * 60 * 1000,
  fmp_balance_sheet: 24 * 60 * 60 * 1000,
  fmp_ratios: 24 * 60 * 60 * 1000,
  get_key_ratios: 24 * 60 * 60 * 1000,
  eodhd_fundamentals: 24 * 60 * 60 * 1000,
  tiingo_fundamentals: 24 * 60 * 60 * 1000,
  // Macro
  get_fred_series: 60 * 60 * 1000,
  get_fred_series_multi: 60 * 60 * 1000,
  get_economic_indicators: 24 * 60 * 60 * 1000,
  ecb_policy_rate: 60 * 60 * 1000,
  ecb_hicp: 60 * 60 * 1000,
  boe_bank_rate: 60 * 60 * 1000,
  // Reads seen in a typical answer (2026-11-07 review)
  yahoo_quote: 30_000,
  yahoo_history: 60 * 60 * 1000,
  coingecko_markets: 30_000,
  get_market_data: 30_000,
  get_fx_rates: 60 * 60 * 1000,
  get_financials: 24 * 60 * 60 * 1000,
  grade_ticker: 60 * 60 * 1000,
  web_search: 10 * 60 * 1000,
  web_fetch: 10 * 60 * 1000,
};

const DEFAULT_TTL_MS = 60_000;

/** A read with a known TTL, and never a mutating tool. */
function cacheable(toolName: string): boolean {
  return toolName in TOOL_TTL_MS && !MUTATING_TOOLS.has(toolName);
}

const cache = new Map<string, CacheEntry>();

/** Canonical JSON: keys sorted at EVERY level. (A replacer array is an allowlist applied to nested
 *  objects too, so the old `JSON.stringify(args, sortedTopKeys)` dropped every nested field and
 *  gave e.g. every `{action:'add', purchase:{...}}` the same key.) */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function hashKey(toolName: string, args: Record<string, unknown>): string {
  const payload = canonical(args);
  const h = createHash('sha1').update(`${toolName}|${payload}`).digest('hex').slice(0, 16);
  return `${toolName}:${h}`;
}

/** Look up a cached tool result. Returns null on miss, on TTL expiry, or for mutating tools. */
export function getToolCacheEntry(toolName: string, args: Record<string, unknown>): { result: string; cached: true; ageMs: number } | null {
  if (!cacheable(toolName)) return null;
  const key = hashKey(toolName, args);
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = TOOL_TTL_MS[toolName] ?? DEFAULT_TTL_MS;
  if (Date.now() - entry.ts > ttl) {
    cache.delete(key);
    return null;
  }
  entry.hitCount++;
  return { result: entry.result, cached: true, ageMs: Date.now() - entry.ts };
}

/** Store a tool result in the cache. Silently no-ops for mutating tools. */
export function setToolCacheEntry(toolName: string, args: Record<string, unknown>, result: string): void {
  if (!cacheable(toolName)) return;
  const key = hashKey(toolName, args);
  // LRU eviction: if at capacity, drop the oldest entry.
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { result, ts: Date.now(), hitCount: 0 });
}

/** Clear the cache. Used by tests + when the user resets session state. */
export function clearToolCache(): void {
  cache.clear();
}

/** Read-only stats for /debug. */
export function getToolCacheStats(): { size: number; maxEntries: number; totalHits: number } {
  let totalHits = 0;
  for (const entry of cache.values()) totalHits += entry.hitCount;
  return { size: cache.size, maxEntries: MAX_ENTRIES, totalHits };
}