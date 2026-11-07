import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ruben-sess-')); process.env.RUBEN_HOME = home; });
afterEach(() => { delete process.env.RUBEN_HOME; rmSync(home, { recursive: true, force: true }); });

test('a session continued on both surfaces keeps every turn, in order', async () => {
  const { SessionStore, loadSession } = await import('./session-store.js');
  const telegram = SessionStore.create('m', 'telegram');
  await telegram.appendTurn('how is KO?', 'fine');

  // The CLI resumes it (a synced copy) and adds a turn; Telegram, still holding
  // its in-memory copy, adds another. Neither may erase the other's turn.
  const cli = SessionStore.fromExisting((await loadSession(telegram.id))!);
  await Bun.sleep(5);
  await cli.appendTurn('and PEP?', 'also fine');
  await Bun.sleep(5);
  await telegram.appendTurn('thanks', 'welcome');

  const saved = (await loadSession(telegram.id))!;
  expect(saved.turns.map((t) => t.query)).toEqual(['how is KO?', 'and PEP?', 'thanks']);
  expect(saved.title).toBe('how is KO?');
});

test('two sessions started in the same second never share an id (2026-11-07)', async () => {
  const { SessionStore, loadSession, listSessions } = await import('./session-store.js');
  const at = new Date('2026-11-07T10:40:41Z');
  const { makeSessionId } = await import('./session-store.js');
  const a = makeSessionId('mushegh', at), b = makeSessionId('mushegh', at);
  expect(a).not.toBe(b);
  expect(await loadSession(a)).toBeNull();          // reserved, no turn yet
  const s = SessionStore.create('m', 'mushegh');
  await s.appendTurn('q', 'a');
  expect((await listSessions('mushegh')).map((x) => x.id)).toEqual([s.id]);
});
