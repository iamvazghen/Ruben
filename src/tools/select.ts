/**
 * Per-question tool selection. Binding all ~126 tool schemas costs ~24k tokens on EVERY step;
 * a question about a mortgage needs the property and macro tools, not 20 stock-data vendors.
 *
 * ponytail: keyword routing (en/de/ru/hy/fr). Ceiling: a question phrased with none of the
 * trigger words binds everything (the old cost, never a missing tool), and a wrong guess is
 * recovered by `load_tools`. Upgrade to an embedding router only if logs show load_tools is
 * called often.
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

interface Group { tools: RegExp; asks: RegExp }

export const GROUPS: Record<string, Group> = {
  markets: {
    tools: /^(grade_ticker|investment_report|screen_universe|score_history|get_financials|get_market_data|read_filings|stock_screener|get_global_stock|yahoo_|alphavantage_stock|polygon_stock|finnhub_|fmp_|twelvedata_(time|quote)|tiingo_|eodhd_|sec_|benzinga_|dividend_safety|thesis_check|fund_look_through|asset_forecast|run_debate|get_catalyst_calendar|news_materiality|get_news)/,
    asks: /stock|share|ticker|etf|fund|equit|invest|market|price|dividend|earning|valuat|analyst|ipo|s&p|msci|nasdaq|dax|aktie|börse|fonds|anlage|акци|бирж|инвест|фонд|բաժնետոմս|ներդր|բորսա|ֆոնդ|bourse|action/i,
  },
  crypto: {
    tools: /^(coingecko_|cmc_|btc_|alphavantage_crypto|onchain_report)/,
    asks: /crypto|bitcoin|btc|ether|eth\b|coin|token|wallet|onchain|on-chain|blockchain|stablecoin|krypto|крипт|биткоин|կրիպտո|բիթքոյն/i,
  },
  macro: {
    tools: /^(get_economic_indicators|get_fred|fred_search|ecb_|bis_|get_commodity|alphavantage_(fx|commodity)|polygon_forex|twelvedata_fx)/,
    asks: /inflation|rate|gdp|ecb|fed\b|central bank|econom|recession|yield|bond|commodit|gold|oil|currency|exchange|eur|usd|zins|inflat|währung|anleihe|инфляц|ставк|курс|валют|облигац|տոկոս|գնաճ|փոխարժեք|արժույթ|taux/i,
  },
  portfolio: {
    tools: /^(portfolio_|income_|yield_plan|reserve_balance|rebalance_|commitments|accounts|cash_transfer|onchain_report|fund_look_through|wealth_overview)/,
    asks: /portfolio|holding|position|net worth|wealth|rebalanc|allocat|income|my (assets|investments|money|savings)|depot|vermögen|портфел|капитал|актив|պորտֆել|ակտիվ|կապիտալ|patrimoine/i,
  },
  tax: {
    tools: /^(tax_|salary)/,
    asks: /tax|steuer|налог|հարկ|vat|w-8|treaty|allowance|freibetrag|deduct|abgeltung|impôt/i,
  },
  property: {
    tools: /^(property_|mortgage_rates|housing_market|rentcast_|realtor_|ecb_policy_rate)/,
    asks: /mortgage|flat|apartment|house|home|property|real estate|rent|hypothek|wohnung|immobil|haus|miete|kredit|кварт|ипотек|дом|недвиж|аренд|բնակարան|տուն|հիփոթեք|վարձ|անշարժ|maison|loyer/i,
  },
  budget: {
    tools: /^(spending|subscriptions|salary|commitments|accounts|cash_transfer|income_)/,
    asks: /spend|spent|budget|expense|subscription|salary|paycheck|bill|saving|cost|afford|ausgab|gehalt|abo|spar|kosten|расход|зарплат|подписк|бюджет|трат|ծախս|աշխատավարձ|բյուջե|խնայ|dépense/i,
  },
  research: {
    tools: /^(x_search|browser|newsapi_|marketaux_|benzinga_news|get_news|spawn_subagent|run_debate|Exa|Perplexity|Tavily|LangSearch)/,
    asks: /research|news|latest|today|recent|search|look up|find out|deep|thorough|compare|nachricht|recherch|новост|исслед|сравн|լուր|հետազոտ|համեմատ/i,
  },
  ops: {
    tools: /^(read_file|write_file|edit_file|heartbeat|cron|portfolio_import)/,
    asks: /file|remind|schedule|every (day|week|month|morning)|cron|heartbeat|import|export|csv|datei|erinner|файл|напомн|ֆայլ|հիշեցր/i,
  },
};

/** Which groups the owner's words (this message plus the session's earlier ones) touch. */
export function groupsFor(texts: string[]): string[] {
  const text = texts.join('\n');
  return Object.keys(GROUPS).filter(g => GROUPS[g].asks.test(text));
}

/**
 * The tools to bind for this question. A tool no group claims is always bound (memory, web
 * search, skills: the cheap generalists), and no group matching binds everything.
 */
export function selectTools(all: StructuredToolInterface[], texts: string[]): StructuredToolInterface[] {
  const groups = groupsFor(texts);
  if (groups.length === 0) return all;
  const grouped = (n: string) => Object.values(GROUPS).some(g => g.tools.test(n));
  return all.filter(t => !grouped(t.name) || groups.some(g => GROUPS[g].tools.test(t.name)));
}

/** The escape hatch: the model asks for groups it was not given, and they are bound next step. */
export function loadToolsTool(onLoad: (groups: string[]) => string): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: 'load_tools',
    description: `Bind more tools when the ones you have cannot answer. Groups: ${Object.keys(GROUPS).join(', ')}, or "all".`,
    schema: z.object({ groups: z.array(z.string()).describe('Group names, or ["all"]') }),
    func: async ({ groups }) => onLoad(groups),
  });
}
