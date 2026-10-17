import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { renderReport, report } from './ledger.js';

/** RUBEN's view of the on-chain ledger Hugh feeds: the monthly, quarterly and annual reports. */
export const onchainReportTool = new DynamicStructuredTool({
  name: 'onchain_report',
  description:
    "Report on the owner's on-chain activity for a month, quarter or year: every transaction Mushegh's agent Hugh planned, sent or had refused, with its purpose, counterparty, EUR value, network fees, route, approver and explorer link, plus totals by purpose and chain. Use for 'what did we do on chain in Q3', fee totals, tax preparation of crypto disposals.",
  schema: z.object({
    period: z.enum(['month', 'quarter', 'year']),
    at: z.string().optional().describe('YYYY-MM, YYYY-Qn or YYYY; default: the current period'),
  }),
  func: async ({ period, at }) => {
    const r = report(period, at);
    return formatToolResult({ ...r, text: renderReport(r) }, []);
  },
});
