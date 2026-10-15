import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// D-97: Mushegh reads back the sessions it started. No model is called here; a real ask needs a key.
describe('ruben ask — sessions and transcript', () => {
  const home = mkdtempSync(join(tmpdir(), 'ruben-ask-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const id = 'mushegh:2026-10-15_18-00-00';
  writeFileSync(join(home, 'sessions', 'mushegh_2026-10-15_18-00-00.json'), JSON.stringify({
    id, origin: 'mushegh', title: 'What is my tax position?', createdAt: '2026-10-15T16:00:00Z',
    updatedAt: '2026-10-15T16:01:00Z', model: 'm',
    turns: [{ query: 'What is my tax position?', answer: 'Bottom line: nothing due.', at: '2026-10-15T16:01:00Z' }],
  }));
  const run = (...args: string[]) =>
    spawnSync('node', ['--import', 'tsx', 'src/ask.ts', ...args], { env: { ...process.env, RUBEN_HOME: home }, encoding: 'utf8' });

  test('sessions lists the Mushegh session', () => {
    const out = run('sessions', '--json');
    expect(JSON.parse(out.stdout)).toEqual([{ id, title: 'What is my tax position?', turns: 1 }]);
  }, 60_000);

  test('transcript renders every turn, by either id form', () => {
    for (const form of [id, 'mushegh_2026-10-15_18-00-00']) {
      const out = run('transcript', form);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('Bottom line: nothing due.');
    }
  }, 60_000);

  test('an unknown session is an error, not an empty transcript', () => {
    expect(run('transcript', 'mushegh:nope').status).toBe(1);
  }, 60_000);
});
