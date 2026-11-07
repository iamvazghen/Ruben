import { describe, test, expect, beforeEach } from 'bun:test';
import { getToolCacheEntry, setToolCacheEntry, clearToolCache, getToolCacheStats } from './tool-cache.js';

describe('tool-cache', () => {
  beforeEach(() => clearToolCache());

  test('returns null on miss', () => {
    expect(getToolCacheEntry('get_stock_price', { ticker: 'AAPL' })).toBeNull();
  });

  test('returns cached result on hit', () => {
    setToolCacheEntry('get_stock_price', { ticker: 'AAPL' }, '{"data":{"price":312.66}}');
    const hit = getToolCacheEntry('get_stock_price', { ticker: 'AAPL' });
    expect(hit?.result).toBe('{"data":{"price":312.66}}');
    expect(hit?.cached).toBe(true);
  });

  test('treats args as order-insensitive for canonical key', () => {
    setToolCacheEntry('fmp_ratios', { ticker: 'AAPL', period: 'annual' }, '{"a":1}');
    const hit = getToolCacheEntry('fmp_ratios', { period: 'annual', ticker: 'AAPL' });
    expect(hit?.result).toBe('{"a":1}');
  });

  test('bypasses cache for mutating tools', () => {
    setToolCacheEntry('write_file', { path: '/tmp/x' }, 'ok');
    expect(getToolCacheEntry('write_file', { path: '/tmp/x' })).toBeNull();
    setToolCacheEntry('memory_update', { content: 'x' }, 'ok');
    expect(getToolCacheEntry('memory_update', { content: 'x' })).toBeNull();
    setToolCacheEntry('portfolio_add', { ticker: 'AAPL' }, 'ok');
    expect(getToolCacheEntry('portfolio_add', { ticker: 'AAPL' })).toBeNull();
  });

  test('nested args are part of the key (2026-11-07: every spending add shared one key)', () => {
    setToolCacheEntry('web_search', { query: 'x', opts: { lang: 'de' } }, 'de');
    expect(getToolCacheEntry('web_search', { query: 'x', opts: { lang: 'en' } })).toBeNull();
    expect(getToolCacheEntry('web_search', { opts: { lang: 'de' }, query: 'x' })?.result).toBe('de');
  });

  test('a tool not listed as a read is never cached', () => {
    const add = { action: 'add', purchase: { merchant: 'REWE', amount: 84.2 } };
    setToolCacheEntry('spending', add, 'added REWE');
    expect(getToolCacheEntry('spending', add)).toBeNull();
  });

  test('different args miss the cache', () => {
    setToolCacheEntry('fmp_ratios', { ticker: 'AAPL' }, 'AAPL-data');
    expect(getToolCacheEntry('fmp_ratios', { ticker: 'MSFT' })).toBeNull();
  });

  test('evicts oldest entry when capacity exceeded', () => {
    // Bypass TTL by setting entries with non-TTL tools and rely on size cap.
    for (let i = 0; i < 250; i++) {
      setToolCacheEntry('fmp_ratios', { ticker: `T${i}` }, `data-${i}`);
    }
    const stats = getToolCacheStats();
    expect(stats.size).toBeLessThanOrEqual(200);
  });

  test('clearToolCache empties the cache', () => {
    setToolCacheEntry('get_stock_price', { ticker: 'AAPL' }, 'data');
    expect(getToolCacheStats().size).toBe(1);
    clearToolCache();
    expect(getToolCacheStats().size).toBe(0);
    expect(getToolCacheEntry('get_stock_price', { ticker: 'AAPL' })).toBeNull();
  });

  test('increments hit count on repeated reads', () => {
    setToolCacheEntry('get_stock_price', { ticker: 'AAPL' }, 'data');
    getToolCacheEntry('get_stock_price', { ticker: 'AAPL' });
    getToolCacheEntry('get_stock_price', { ticker: 'AAPL' });
    expect(getToolCacheStats().totalHits).toBe(2);
  });
});