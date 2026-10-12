import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { jsonFile } from '../utils/json-store.js';
import { reviewProperty, type Property } from './analysis.js';
import { housingMarket, mortgageRates } from './market.js';

export const realEstateStore = jsonFile<{ properties: Property[] }>('realestate.json', { properties: [] });

const today = () => new Date().toISOString().slice(0, 10);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const dated = z.object({ amount: z.number(), as_of: z.string().describe('YYYY-MM-DD'), source: z.string() });

const mortgage = z.object({
  lender: z.string().optional(),
  balance: z.number().describe('Outstanding principal on balance_date'),
  balance_date: z.string().describe('YYYY-MM-DD'),
  rate_pct: z.number().describe('Nominal annual rate, percent'),
  monthly_payment: z.number().describe('Monthly instalment, interest + repayment'),
  fixed_until: z.string().optional().describe('End of rate fixation, YYYY-MM-DD'),
  original_principal: z.number().optional(),
});

const fields = z.object({
  name: z.string().optional(),
  type: z.enum(['apartment', 'house', 'multi_family', 'commercial', 'land', 'parking', 'other']).optional(),
  country: z.string().optional().describe('ISO 3166 alpha-2, e.g. DE, AM, US'),
  city: z.string().optional(),
  postcode: z.string().optional(),
  size_m2: z.number().optional(),
  year_built: z.number().optional(),
  currency: z.string().optional(),
  purchase_date: z.string().optional(),
  purchase_price: z.number().optional(),
  purchase_costs: z.number().optional().describe('Transfer tax, notary, broker'),
  land_share_pct: z.number().optional().describe('Share of the price that is land (not depreciable)'),
  value: dated.optional().describe('Current valuation with its date and source'),
  use: z.enum(['rented', 'vacant', 'owner_occupied']).optional(),
  rent_monthly: z.number().optional().describe('Net cold rent per month'),
  lease_start: z.string().optional(),
  last_rent_increase: z.string().optional(),
  costs_monthly: z.number().optional().describe('Non-recoverable running costs per month'),
  property_tax_annual: z.number().optional(),
  insurance_annual: z.number().optional(),
  market_rent_m2: dated.optional().describe('Local comparable rent per m² with date and source'),
  depreciation_rate_pct: z.number().optional().describe('Tax depreciation of the building per year, percent'),
  mortgages: z.array(mortgage).optional().describe('Replaces the whole list'),
  notes: z.string().optional(),
});

export const propertyManage = new DynamicStructuredTool({
  name: 'property_manage',
  description:
    "Add, update or remove a property the owner holds (apartment, house, land…) with its mortgages. A durable change: confirm the figures with the owner first. Update merges the given fields; `mortgages` replaces the list.",
  schema: z.object({
    action: z.enum(['add', 'update', 'remove']),
    id: z.string().optional().describe('For update/remove; see property_review'),
    fields: fields.optional(),
  }),
  func: async ({ action, id, fields: f = {} }) => {
    const store = realEstateStore.read();
    if (action === 'add') {
      if (!f.name || !f.country || !f.city || !f.currency) return formatToolResult({ error: 'name, country, city and currency are required' });
      let newId = slug(`${f.name}-${f.city}`);
      while (store.properties.some((p) => p.id === newId)) newId += '-2';
      const property: Property = { type: 'apartment', use: 'rented', mortgages: [], ...f, id: newId } as Property;
      property.country = property.country.toUpperCase();
      store.properties.push(property);
      realEstateStore.write(store);
      return formatToolResult({ added: property });
    }
    const i = store.properties.findIndex((p) => p.id === id);
    if (i < 0) return formatToolResult({ error: `no property ${id}`, ids: store.properties.map((p) => p.id) });
    if (action === 'remove') {
      const [gone] = store.properties.splice(i, 1);
      realEstateStore.write(store);
      return formatToolResult({ removed: gone!.id });
    }
    store.properties[i] = { ...store.properties[i]!, ...f } as Property;
    realEstateStore.write(store);
    return formatToolResult({ updated: store.properties[i] });
  },
});

export const propertyReview = new DynamicStructuredTool({
  name: 'property_review',
  description:
    'Review the owner\'s real estate: equity, loan-to-value, rent and net yield, cash flow after debt service, rent per m² against the local market, refinancing risk when a rate fixation ends (priced at today\'s ECB mortgage rate where available), and flags that need attention. Totals per currency.',
  schema: z.object({ id: z.string().optional().describe('One property; omit for all') }),
  func: async ({ id }) => {
    const all = realEstateStore.read().properties.filter((p) => !id || p.id === id);
    if (!all.length) return formatToolResult({ properties: [], note: 'No properties recorded. Add one with property_manage.' });
    const rates = new Map<string, number | null>();
    for (const c of new Set(all.map((p) => p.country))) {
      const r = await mortgageRates(c);
      rates.set(c, r?.rates.all?.rate ?? null);
    }
    const reviews = all.map((p) => reviewProperty(p, today(), rates.get(p.country)));
    const totals: Record<string, { value: number; debt: number; equity: number; rent: number; cash_flow: number }> = {};
    for (const r of reviews) {
      const t = (totals[r.currency] ??= { value: 0, debt: 0, equity: 0, rent: 0, cash_flow: 0 });
      t.value += r.value ?? 0; t.debt += r.debt; t.equity += r.equity ?? 0; t.rent += r.rent_annual; t.cash_flow += r.cash_flow_annual;
    }
    return formatToolResult({
      as_of: today(), reviews, totals_by_currency: totals,
      market_mortgage_rate_pct: Object.fromEntries(rates),
      note: 'Valuations and market rents are only as good as their dates and sources; refresh stale ones with web_search before acting.',
    });
  },
});

export const mortgageRatesTool = new DynamicStructuredTool({
  name: 'mortgage_rates',
  description:
    'Current interest rates on new house-purchase loans in a euro-area country (ECB statistics), by length of rate fixation, with the rate a year ago. Use for refinancing and purchase decisions. Outside the euro area it returns nothing: use get_fred_series MORTGAGE30US for the US, otherwise web_search the national central bank.',
  schema: z.object({ country: z.string().describe('ISO alpha-2, or EA for the euro area') }),
  func: async ({ country }) => formatToolResult((await mortgageRates(country)) ?? { country, error: 'not covered by ECB MIR statistics' }),
});

export const housingMarketTool = new DynamicStructuredTool({
  name: 'housing_market',
  description:
    'National house-price and rent trends for an EU/EEA country (Eurostat): house prices year on year for 8 quarters (existing vs new dwellings) and rent inflation. For a city or per-m² rent level, follow up with web_search (municipal rent index, listing portals) and record it on the property as market_rent_m2 with date and source.',
  schema: z.object({ country: z.string().describe('ISO alpha-2') }),
  func: async ({ country }) => formatToolResult((await housingMarket(country)) ?? { country, error: 'no Eurostat coverage' }),
});
