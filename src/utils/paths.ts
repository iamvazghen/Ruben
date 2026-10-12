import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Absolute home for every piece of RUBEN state: memory, cron jobs, portfolio,
 * scores, reports.
 *
 * This used to be the bare relative string '.ruben', which meant the process
 * read a *different* brain depending on the directory it was launched from — a
 * scheduled run started anywhere but the repo root silently got empty memory,
 * no portfolio and no cron jobs. Resolved once, at module load, to an absolute
 * path.
 *
 * Order: $RUBEN_HOME > ./.ruben if it already exists (back-compat for an
 * existing checkout) > ~/.ruben.
 *
 * The project was called Antoine until 2026-09 and Rubo until 2026-10-12. Installs
 * that predate a rename keep working: the old variables and directory names are
 * honoured only when no RUBEN one exists, newest name first, so state is never
 * split between two directories.
 */
const LEGACY_ENVS = ['RUBO_HOME', 'ANTOINE_HOME'];
const LEGACY_DIRS = ['.rubo', '.antoine'];

function envHome(): string {
  const legacy = LEGACY_ENVS.map((name) => process.env[name]).find((v) => v?.trim());
  return (process.env.RUBEN_HOME ?? legacy ?? '').trim();
}

function resolveRubenDir(): string {
  const fromEnv = envHome();
  if (fromEnv) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  }

  for (const base of [process.cwd(), homedir()]) {
    if (existsSync(join(base, '.ruben'))) return join(base, '.ruben');
    for (const legacy of LEGACY_DIRS) {
      if (existsSync(join(base, legacy))) return join(base, legacy);
    }
  }

  return join(homedir(), '.ruben');
}

/**
 * Memoised against the value of $RUBEN_HOME rather than resolved once and
 * frozen.
 *
 * Freezing at module load meant a process that set RUBEN_HOME after the module
 * graph had loaded was silently ignored - so a test that pointed state at a
 * scratch directory still read and wrote the real portfolio, memory and score
 * ledger, depending purely on which file imported first. Three separate suites
 * hit that before it was traced here.
 *
 * Still resolved to an absolute path, which is what the original note was really
 * protecting: a relative '.ruben' meant a scheduled run started outside the
 * repo root read an empty brain.
 */
let cached: { key: string; dir: string } | null = null;

export function getRubenDir(): string {
  const key = envHome();
  if (!cached || cached.key !== key) {
    cached = { key, dir: resolveRubenDir() };
  }
  return cached.dir;
}

export function rubenPath(...segments: string[]): string {
  return join(getRubenDir(), ...segments);
}
