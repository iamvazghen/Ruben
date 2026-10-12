/** Calendar periods (month, quarter, year) and subscription billing dates. Pure. */
import type { Cycle, Subscription } from './store.js';

export interface Period {
  kind: 'month' | 'quarter' | 'year';
  id: string;
  /** Inclusive start and exclusive end, YYYY-MM-DD. */
  start: string;
  end: string;
  months: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number) => `${y + Math.floor((m - 1) / 12)}-${pad((((m - 1) % 12) + 12) % 12 + 1)}-01`;

function make(kind: Period['kind'], y: number, first: number): Period {
  const months = kind === 'month' ? 1 : kind === 'quarter' ? 3 : 12;
  const id = kind === 'month' ? `${y}-${pad(first)}` : kind === 'quarter' ? `${y}-Q${(first + 2) / 3}` : String(y);
  return { kind, id, start: ymd(y, first), end: ymd(y, first + months), months };
}

/** `2026-09`, `2026-Q3`, `2026`, or relative: this_/last_ month, quarter, year. */
export function parsePeriod(spec: string, now = new Date()): Period {
  const s = spec.trim().toLowerCase();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const q = Math.ceil(m / 3);
  const rel: Record<string, () => Period> = {
    this_month: () => make('month', y, m),
    last_month: () => (m === 1 ? make('month', y - 1, 12) : make('month', y, m - 1)),
    this_quarter: () => make('quarter', y, q * 3 - 2),
    last_quarter: () => (q === 1 ? make('quarter', y - 1, 10) : make('quarter', y, q * 3 - 5)),
    this_year: () => make('year', y, 1),
    last_year: () => make('year', y - 1, 1),
  };
  if (rel[s]) return rel[s]!();
  let r = /^(\d{4})-(\d{2})$/.exec(s);
  if (r) return make('month', Number(r[1]), Number(r[2]));
  r = /^(\d{4})-q([1-4])$/.exec(s);
  if (r) return make('quarter', Number(r[1]), Number(r[2]) * 3 - 2);
  r = /^(\d{4})$/.exec(s);
  if (r) return make('year', Number(r[1]), 1);
  throw new Error(`unknown period "${spec}": use 2026-09, 2026-Q3, 2026, last_month, last_quarter or last_year`);
}

/** The period just before, of the same length. */
export function previousPeriod(p: Period): Period {
  const [y, mm] = [Number(p.start.slice(0, 4)), Number(p.start.slice(5, 7))];
  const first = mm - p.months;
  return make(p.kind, first < 1 ? y - 1 : y, first < 1 ? first + 12 : first);
}

/** The same period a year earlier. */
export function lastYearPeriod(p: Period): Period {
  return make(p.kind, Number(p.start.slice(0, 4)) - 1, Number(p.start.slice(5, 7)));
}

export const inPeriod = (date: string, p: Period) => date >= p.start && date < p.end;

const STEP: Record<Cycle, { months?: number; days?: number }> = {
  weekly: { days: 7 }, monthly: { months: 1 }, quarterly: { months: 3 }, semiannual: { months: 6 }, yearly: { months: 12 },
};
export const PER_YEAR: Record<Cycle, number> = { weekly: 52, monthly: 12, quarterly: 4, semiannual: 2, yearly: 1 };

/** Date `n` billing cycles after `from`, keeping the day of month (clamped to the month's length). */
export function addCycles(from: string, cycle: Cycle, n: number): string {
  const step = STEP[cycle];
  const d = new Date(`${from}T00:00:00Z`);
  if (step.days) {
    d.setUTCDate(d.getUTCDate() + step.days * n);
    return d.toISOString().slice(0, 10);
  }
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step.months! * n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Price in force on a date: the latest price-history entry on or before it, else the current amount. */
export function priceOn(s: Subscription, date: string): number {
  const h = (s.price_history ?? []).filter((x) => x.date <= date);
  return h.length ? h[h.length - 1]!.amount : s.amount;
}

/** Each charge date and amount inside [from, to): billing from start_date, none during a trial or after cancellation. */
export function chargesBetween(s: Subscription, from: string, to: string): { date: string; amount: number }[] {
  if (s.status === 'paused') return [];
  const out: { date: string; amount: number }[] = [];
  const stop = s.status === 'cancelled' && s.cancelled_at ? (s.cancelled_at < to ? s.cancelled_at : to) : to;
  for (let i = 0; i < 2000; i++) {
    const d = addCycles(s.start_date, s.cycle, i);
    if (d >= stop) break;
    if (d < from) continue;
    if (s.trial_ends && d < s.trial_ends) continue;
    out.push({ date: d, amount: priceOn(s, d) });
  }
  return out;
}

/** Next billing date on or after `today`. */
export function nextRenewal(s: Subscription, today: string): string {
  let d = s.start_date;
  for (let i = 1; d < today && i < 5000; i++) d = addCycles(s.start_date, s.cycle, i);
  return d;
}
