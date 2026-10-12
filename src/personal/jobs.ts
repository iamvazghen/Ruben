import { randomBytes } from 'node:crypto';
import { computeNextRunAtMs } from '../cron/schedule.js';
import { loadCronStore, saveCronStore } from '../cron/store.js';
import { timeZone } from '../utils/locale.js';

/**
 * Scheduled personal-finance work: the period reports delivered to Telegram,
 * and a morning check of subscription renewals, trials and cancel deadlines.
 */
const JOBS: { name: string; description: string; expr: string; message: string }[] = [
  {
    name: 'personal:report:monthly', description: 'Monthly results workbook to Telegram', expr: '0 9 1 * *',
    message: 'Monthly results. Call finance_report with period last_month, format xlsx, send_telegram true. Then reply with three lines: the biggest change against the previous month, the biggest against the same month last year, and the single most valuable cost cut from the report. If there is no data for the month, reply exactly HEARTBEAT_OK.',
  },
  {
    name: 'personal:report:quarterly', description: 'Quarterly results workbook to Telegram', expr: '30 9 1 1,4,7,10 *',
    message: 'Quarterly results. Call finance_report with period last_quarter, format both, send_telegram true. Summarise the quarter: savings rate and its trend, the categories that grew most, subscriptions worth cancelling, and whether net salary moved. If there is no data, reply exactly HEARTBEAT_OK.',
  },
  {
    name: 'personal:report:annual', description: 'Annual results workbook to Telegram', expr: '0 10 2 1 *',
    message: 'Annual results. Call finance_report with period last_year, format both, send_telegram true. Then a short year review: income, expenses, savings rate and net worth change (wealth_overview), the three largest cost categories with their change on the year before, and three concrete actions for this year. If there is no data, reply exactly HEARTBEAT_OK.',
  },
  {
    name: 'personal:subscriptions', description: 'Renewals, trials and cancel deadlines', expr: '0 9 * * *',
    message: 'Subscription check. Call subscriptions with action show. Tell the owner only about: renewals in the next 3 days (name, date, amount), trials ending in the next 3 days, and cancel-by deadlines in the next 7 days for subscriptions used rarely or never. Otherwise reply exactly HEARTBEAT_OK.',
  },
];

export function ensurePersonalFinanceJobs(): void {
  const store = loadCronStore();
  const now = Date.now();
  let changed = false;
  for (const j of JOBS) {
    if (store.jobs.some((x) => x.name === j.name)) continue;
    const schedule = { kind: 'cron' as const, expr: j.expr, tz: timeZone() };
    store.jobs.push({
      id: randomBytes(8).toString('hex'), name: j.name, description: j.description,
      enabled: true, createdAtMs: now, updatedAtMs: now, schedule,
      payload: { message: j.message }, fulfillment: 'keep',
      state: { nextRunAtMs: computeNextRunAtMs(schedule, now), consecutiveErrors: 0, scheduleErrorCount: 0 },
    });
    changed = true;
  }
  if (changed) saveCronStore(store);
}
