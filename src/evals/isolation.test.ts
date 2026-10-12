import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRubenDir, rubenPath } from '../utils/paths.js';

/**
 * State-writing modules must follow RUBEN_HOME, not a copy of it taken at
 * import time.
 *
 * The behavioural suite wrote a real position into the real portfolio twice
 * before this was pinned down. The first cause was a path frozen at module load;
 * the second was subtler — ES `import` statements are hoisted and evaluated
 * before any top-level code, so setting RUBEN_HOME at the top of a file still
 * runs *after* every module it imports has already chosen a directory.
 *
 * A test that only checks its own scratch directory cannot catch either, because
 * the damage lands somewhere else entirely.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), 'ruben-isolation-'));

afterAll(() => {
  delete process.env.RUBEN_HOME;
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS reaps the temp directory anyway.
  }
});

describe('state directory isolation', () => {
  test('rubenPath follows a change to RUBEN_HOME', () => {
    const before = getRubenDir();
    process.env.RUBEN_HOME = SCRATCH;
    expect(getRubenDir()).toBe(SCRATCH);
    expect(rubenPath('cache')).toBe(join(SCRATCH, 'cache'));
    expect(getRubenDir()).not.toBe(before);
  });

  test('the portfolio store writes wherever RUBEN_HOME points now', async () => {
    process.env.RUBEN_HOME = SCRATCH;
    const { PortfolioStore } = await import('../tools/portfolio/store.js');

    // A store built before the change must still honour the change: the tools
    // module constructs exactly one at import time.
    const store = new PortfolioStore();
    store.update((p) => ({ ...p, total_capital_usd: 1_234 }));

    const written = join(SCRATCH, 'portfolio.json');
    expect(existsSync(written)).toBe(true);
    expect(JSON.parse(readFileSync(written, 'utf-8')).total_capital_usd).toBe(1_234);
  });

  test('an explicit base directory still wins', async () => {
    const explicit = mkdtempSync(join(tmpdir(), 'ruben-explicit-'));
    const { PortfolioStore } = await import('../tools/portfolio/store.js');
    new PortfolioStore(explicit).update((p) => ({ ...p, total_capital_usd: 99 }));
    expect(existsSync(join(explicit, 'portfolio.json'))).toBe(true);
    rmSync(explicit, { recursive: true, force: true });
  });
});
