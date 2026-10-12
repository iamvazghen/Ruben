import { randomBytes } from 'node:crypto';
import { computeNextRunAtMs } from '../cron/schedule.js';
import { loadCronStore, saveCronStore } from '../cron/store.js';
import { timeZone } from '../utils/locale.js';

export const WATCH_JOB = 'portfolio:watch';

/**
 * Every weekday evening: check every holding for bad news or bad numbers and
 * tell the owner only when an allocation deserves a second look. The price and
 * dividend checks are code (portfolio_alerts); reading the news and judging it
 * is the model's part. Silent when nothing is wrong.
 */
export const WATCH_JOB_MESSAGE = [
  'Daily portfolio watch.',
  '1. Run portfolio_alerts.',
  '2. Read portfolio_view. For every holding flagged in step 1, and for the ten largest holdings, look for news, filings and analyst actions from the last 48 hours (get_company_news, get_news, sec_filings for US issuers). If news_materiality is available, run it on each item that could matter.',
  '3. Keep only what is bad for the owner: a profit warning, a guidance cut, a dividend cut or suspension, a downgrade with a lowered target, a fraud or accounting issue, litigation or regulation that threatens the business, a credit downgrade, a financing that dilutes holders, or a sharp fall without an explanation.',
  '4. On Mondays also run property_review and report any property flag that is new or worse.',
  '5. For each item kept: the holding and its weight, what happened (date, numbers, source), why it matters for the thesis, and a recommendation: hold, review the thesis, trim, or exit. When a change would move a weight, say what rebalance_proposal suggests. Never trade; recommend.',
  'If nothing qualifies, reply exactly HEARTBEAT_OK.',
].join('\n');

export function ensurePortfolioWatchJob(): void {
  const store = loadCronStore();
  if (store.jobs.some((j) => j.name === WATCH_JOB)) return;
  const now = Date.now();
  const schedule = { kind: 'cron' as const, expr: '30 18 * * 1-5', tz: timeZone() };
  store.jobs.push({
    id: randomBytes(8).toString('hex'), name: WATCH_JOB, description: 'Weekdays: bad news or bad numbers on any holding',
    enabled: true, createdAtMs: now, updatedAtMs: now, schedule,
    payload: { message: WATCH_JOB_MESSAGE }, fulfillment: 'keep',
    state: { nextRunAtMs: computeNextRunAtMs(schedule, now), consecutiveErrors: 0, scheduleErrorCount: 0 },
  });
  saveCronStore(store);
}
