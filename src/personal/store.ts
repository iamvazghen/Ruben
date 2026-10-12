/**
 * The owner's day-to-day money: salary, purchases, subscriptions and budgets.
 * Person-agnostic and private: it lives under the RUBEN home, never in the repo.
 */
import { jsonFile } from '../utils/json-store.js';

export interface Employer {
  id: string;
  name: string;
  currency: string;
  country?: string;
  role?: string;
  start?: string;
  end?: string;
  /** Contracted gross per year, to compare payslips against. */
  gross_annual?: number;
  notes?: string;
}

export interface Payslip {
  id: string;
  employer: string;
  /** Month the pay is for, YYYY-MM. */
  period: string;
  pay_date: string;
  currency: string;
  gross: number;
  net: number;
  income_tax?: number;
  /** Social contributions by name, e.g. { pension: 186, health: 146, unemployment: 26, care: 34 }. */
  social?: Record<string, number>;
  other_deductions?: number;
  /** Part of `gross` that is bonus, overtime or a one-off. */
  bonus?: number;
  notes?: string;
}

export const CATEGORIES = [
  'housing', 'utilities', 'groceries', 'dining', 'transport', 'car', 'health', 'insurance', 'education',
  'childcare', 'clothing', 'electronics', 'home', 'entertainment', 'travel', 'gifts', 'personal_care',
  'sport', 'pets', 'fees', 'taxes', 'donations', 'business', 'other',
] as const;

export interface Purchase {
  id: string;
  date: string;
  amount: number;
  currency: string;
  /** Who was paid: shop, company, person. */
  merchant: string;
  /** What was bought. */
  description: string;
  items?: { name: string; qty?: number; price?: number }[];
  category: string;
  payment_method?: string;
  account?: string;
  location?: string;
  /** Where the receipt or invoice is kept. */
  receipt?: string;
  tags?: string[];
  /** Set when the line is a subscription charge, so it is not counted twice. */
  subscription_id?: string;
  notes?: string;
}

export type Cycle = 'weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

export interface Subscription {
  id: string;
  name: string;
  provider: string;
  category: string;
  plan?: string;
  amount: number;
  currency: string;
  cycle: Cycle;
  start_date: string;
  next_renewal: string;
  status: 'active' | 'trial' | 'paused' | 'cancelled';
  trial_ends?: string;
  cancelled_at?: string;
  /** Days before renewal the cancellation must arrive. */
  notice_days?: number;
  /** Minimum term end, before which it cannot be cancelled. */
  commitment_until?: string;
  payment_method?: string;
  account?: string;
  /** Login or account email used for it, so the owner can find it. */
  account_email?: string;
  cancel_url?: string;
  shared_with?: string[];
  usage?: 'daily' | 'weekly' | 'monthly' | 'rarely' | 'never';
  /** Every price the owner has paid, oldest first; the latest is `amount`. */
  price_history?: { date: string; amount: number }[];
  notes?: string;
}

export interface Budget {
  /** Spending category, or "subscriptions". */
  category: string;
  monthly_limit: number;
  currency: string;
}

export const salaryStore = jsonFile<{ employers: Employer[]; payslips: Payslip[] }>('personal/salary.json', { employers: [], payslips: [] });
export const spendingStore = jsonFile<{ purchases: Purchase[]; merchant_categories: Record<string, string> }>('personal/spending.json', { purchases: [], merchant_categories: {} });
export const subscriptionStore = jsonFile<{ subscriptions: Subscription[] }>('personal/subscriptions.json', { subscriptions: [] });
export const budgetStore = jsonFile<{ budgets: Budget[] }>('personal/budgets.json', { budgets: [] });

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
