import { expect, test } from 'bun:test';
import { selectTools, groupsFor } from './select.js';

const t = (name: string) => ({ name }) as never;
const ALL = ['memory_search', 'web_search', 'mortgage_rates', 'property_review', 'ecb_policy_rate',
  'finnhub_quote', 'yahoo_quote', 'coingecko_markets', 'tax_knowledge', 'spending', 'cron'].map(t);
const names = (q: string[]) => selectTools(ALL, q).map(x => (x as { name: string }).name);

test('a mortgage question binds property tools and the generalists, not stock vendors', () => {
  const got = names(['Should I pay off my mortgage early?']);
  expect(got).toContain('mortgage_rates');
  expect(got).toContain('memory_search');
  expect(got).toContain('web_search');
  expect(got).not.toContain('finnhub_quote');
  expect(got).not.toContain('coingecko_markets');
});

test('a follow-up keeps the groups of the earlier questions in the session', () => {
  expect(names(['Should I pay off my mortgage early?', 'And at 5%?'])).toContain('mortgage_rates');
});

test('no trigger word binds everything — never a missing tool', () => {
  expect(names(['Hello, how are you?']).length).toBe(ALL.length);
});

test('German, Russian and Armenian questions route too', () => {
  expect(groupsFor(['Wie hoch ist meine Steuer?'])).toContain('tax');
  expect(groupsFor(['Сколько я потратил в этом месяце?'])).toContain('budget');
  expect(groupsFor(['Ինչ արժե բիթքոյնը'])).toContain('crypto');
});
