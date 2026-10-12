/**
 * Tax rules RUBEN has researched, per jurisdiction, each with its source and
 * date, so advice rests on something checkable and stale rules are visible.
 * Plus the multi-jurisdiction picture: residence, where each asset sits, and
 * which rules still need researching for that particular mix.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../tools/types.js';
import { jsonFile } from '../utils/json-store.js';
import { incomeStore } from '../income/store.js';
import { jurisdictionFor, JURISDICTIONS } from '../income/jurisdictions.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { realEstateStore } from '../realestate/tools.js';

export const TOPICS = [
  'residence', 'dividends', 'interest', 'capital_gains', 'funds', 'crypto', 'commodities', 'real_estate', 'rental_income',
  'salary', 'deductions', 'allowances', 'pension', 'losses', 'treaty', 'withholding_reclaim', 'reporting',
  'wealth_tax', 'inheritance_gift', 'exit_tax', 'other',
] as const;

export interface TaxNote {
  id: string;
  jurisdiction: string;
  topic: (typeof TOPICS)[number];
  /** The rule, in plain words, with numbers. */
  rule: string;
  /** How the owner can use it, if it is a benefit. */
  benefit?: string;
  /** Other country, for a treaty or reclaim note. */
  counterpart?: string;
  source: string;
  as_of: string;
  official: boolean;
}

export const taxKnowledge = jsonFile<{ notes: TaxNote[] }>('tax/knowledge.json', { notes: [] });

const STALE_DAYS = 365;
const age = (d: string) => Math.floor((Date.now() - Date.parse(d)) / 86_400_000);

export const taxKnowledgeTool = new DynamicStructuredTool({
  name: 'tax_knowledge',
  description:
    'RUBEN\'s researched tax rules per jurisdiction. save: one rule with its topic, plain-words rule with numbers, how the owner benefits, the source URL (official sources preferred: tax authority, ministry, statute, treaty text) and the date checked. list: notes for a jurisdiction (or all), with stale ones (over a year old) flagged for re-checking. Save after every piece of tax research so the next answer starts from it.',
  schema: z.object({
    action: z.enum(['save', 'list', 'remove']),
    jurisdiction: z.string().optional(),
    id: z.string().optional(),
    note: z.object({
      jurisdiction: z.string(), topic: z.enum(TOPICS), rule: z.string(), benefit: z.string().optional(),
      counterpart: z.string().optional(), source: z.string(), as_of: z.string().optional(), official: z.boolean(),
    }).optional(),
  }),
  func: async ({ action, jurisdiction, id, note }) => {
    const store = taxKnowledge.read();
    if (action === 'save') {
      if (!note) return formatToolResult({ error: 'note is required' });
      const n: TaxNote = { ...note, jurisdiction: note.jurisdiction.toUpperCase(), counterpart: note.counterpart?.toUpperCase(), as_of: note.as_of ?? new Date().toISOString().slice(0, 10), id: `tx-${Date.now().toString(36)}` };
      store.notes.push(n);
      taxKnowledge.write(store);
      return formatToolResult({ saved: n });
    }
    if (action === 'remove') {
      store.notes = store.notes.filter((n) => n.id !== id);
      taxKnowledge.write(store);
      return formatToolResult({ removed: id });
    }
    const rows = store.notes.filter((n) => !jurisdiction || n.jurisdiction === jurisdiction.toUpperCase() || n.counterpart === jurisdiction.toUpperCase());
    return formatToolResult({ notes: rows.map((n) => ({ ...n, stale: age(n.as_of) > STALE_DAYS })), count: rows.length });
  },
});

/** Which topics matter for a jurisdiction, given what the owner actually holds there. */
export function neededTopics(p: { residence: boolean; assetTypes: Set<string>; property: boolean; foreignFor?: string }): string[] {
  const t = new Set<string>();
  if (p.residence) ['residence', 'salary', 'deductions', 'allowances', 'pension', 'losses', 'reporting'].forEach((x) => t.add(x));
  if ([...p.assetTypes].some((x) => x !== 'cash')) ['dividends', 'capital_gains'].forEach((x) => t.add(x));
  if (p.assetTypes.has('etf') || p.assetTypes.has('fund')) t.add('funds');
  if (p.assetTypes.has('crypto')) t.add('crypto');
  if (p.assetTypes.has('commodity')) t.add('commodities');
  if (p.assetTypes.has('cash') || p.assetTypes.has('bond')) t.add('interest');
  if (p.property) ['real_estate', 'rental_income'].forEach((x) => t.add(x));
  if (p.foreignFor) ['treaty', 'withholding_reclaim', 'reporting'].forEach((x) => t.add(x));
  return [...t];
}

export const taxJurisdictionTool = new DynamicStructuredTool({
  name: 'tax_jurisdiction',
  description:
    "The owner's tax position across countries. show: tax residence, every jurisdiction where assets sit (by account country and property country) with what is held there, which tax topics are already researched for each, and which still need research — including the treaty between residence and each foreign jurisdiction. set: change residence (any ISO country), filing status (single/joint) or a jurisdiction option such as church_tax_rate or the owner's own flat_rate/allowance for a country without built-in rules. Changing residence is durable: confirm first.",
  schema: z.object({
    action: z.enum(['show', 'set']),
    residence: z.string().optional(),
    filing: z.enum(['single', 'joint']).optional(),
    option: z.object({ name: z.string(), value: z.number() }).optional(),
  }),
  func: async ({ action, residence, filing, option }) => {
    const profile = incomeStore.tax();
    const { accountStore } = await import('../wealth/accounts.js');
    const accounts = accountStore.read().accounts;
    if (action === 'set') {
      if (residence) profile.residence = residence.toUpperCase();
      if (filing) profile.filing = filing;
      if (option) profile.options[option.name] = option.value;
      // Domestic or foreign follows residence.
      for (const a of accounts) {
        const t = profile.accounts[a.id] ?? { domestic: false, w8ben: false, allowance_assigned: 0 };
        profile.accounts[a.id] = { ...t, domestic: a.country === profile.residence };
      }
      profile.confirmed_at = new Date().toISOString();
      incomeStore.saveTax(profile);
    }
    const country = new Map(accounts.map((a) => [a.id, a.country]));
    const held = new Map<string, Set<string>>();
    for (const p of new PortfolioStore().read().positions) {
      const c = (p.account && country.get(p.account)) || 'unassigned';
      held.set(c, (held.get(c) ?? new Set()).add(p.asset_type ?? 'stock'));
    }
    const propertyIn = new Set(realEstateStore.read().properties.map((p) => p.country));
    const res = profile.residence;
    const all = new Set([...(res ? [res] : []), ...held.keys(), ...propertyIn]);
    all.delete('unassigned');
    const notes = taxKnowledge.read().notes;
    const jurisdictions = [...all].map((c) => {
      const mine = notes.filter((n) => n.jurisdiction === c);
      const covered = new Set(mine.filter((n) => age(n.as_of) <= STALE_DAYS).map((n) => n.topic));
      const treatyDone = res && c !== res ? notes.some((n) => n.topic === 'treaty' && ((n.jurisdiction === c && n.counterpart === res) || (n.jurisdiction === res && n.counterpart === c))) : true;
      const needed = neededTopics({ residence: c === res, assetTypes: held.get(c) ?? new Set(), property: propertyIn.has(c), foreignFor: c !== res ? res ?? undefined : undefined });
      return {
        jurisdiction: c, residence: c === res,
        built_in_rules: Boolean(JURISDICTIONS[c]),
        holds: [...(held.get(c) ?? [])], property: propertyIn.has(c),
        researched: [...covered], stale_notes: mine.filter((n) => age(n.as_of) > STALE_DAYS).length,
        to_research: needed.filter((t) => !covered.has(t as TaxNote['topic']) && !(t === 'treaty' && treatyDone)),
      };
    });
    const j = jurisdictionFor(res, profile.options);
    return formatToolResult({
      residence: res, filing: profile.filing, options: profile.options,
      residence_rules: j ? { name: j.name, allowance: j.allowance(profile.filing, profile.options), currency: j.currency, built_in: Boolean(res && JURISDICTIONS[res]) } : null,
      jurisdictions,
      unassigned_holdings: held.has('unassigned'),
      next: res ? 'Research each to_research topic with web_search on official sources, then save it with tax_knowledge.' : 'Set the tax residence first.',
    });
  },
});
