#!/usr/bin/env -S node --import tsx
// Non-interactive access for another process (Mushegh, D-97: every money question goes to RUBEN).
//   ruben ask --file <path>             question read from a file (safe through a .cmd shim)
//   ruben ask --file <request>.json     {"question", "session"?, "attach"?: [paths]} — follow-ups
//                                       and data intake without a single risky argv character
//   ruben ask [--json] "<question>"
//   ruben transcript <session> [--telegram]   the whole session; --telegram sends it to the owner
//   ruben sessions [--json]                   the newest sessions Mushegh started
// Every ask is a saved session (origin `mushegh`), so the owner can /resume it on Telegram and
// Mushegh can follow up on it. --json (implied by a .json request) answers with
// {session, answer, failed, tools:[{tool, ok, ms?, error?}]} so the caller can review the run.
// Tools that need approval are denied: there is nobody here to approve them.
import { readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from 'dotenv';
import { runAgentForMessage, seedSession } from './gateway/agent-runner.js';
import { getSetting } from './utils/config.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from './model/llm.js';
import { sendFilesToOwner } from './personal/deliver.js';
import { SessionStore, listSessions, loadSession, normalizeSessionId, type SessionFile } from './utils/session-store.js';

config({ quiet: true });

type Request = { question: string; session?: string; attach?: string[]; json: boolean };
type ToolRun = { tool: string; ok: boolean; ms?: number; error?: string };

const INLINE_LIMIT = 100_000; // bytes; bigger or binary files are passed by path for RUBEN's importers

function fail(message: string, code = 1): never {
  console.error(`[ruben] ${message}`);
  process.exit(code);
}

function parseAsk(args: string[]): Request {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const fileAt = rest.indexOf('--file');
  if (fileAt < 0) return { question: rest.join(' ').trim(), json };
  const path = rest[fileAt + 1] ?? '';
  const text = readFileSync(path, 'utf8');
  if (!path.toLowerCase().endsWith('.json')) return { question: text.trim(), json };
  const req = JSON.parse(text) as Partial<Request>;
  return { question: String(req.question ?? '').trim(), session: req.session, attach: req.attach ?? [], json: true };
}

/** Attached data, inlined when it is small text, otherwise named by path for RUBEN's own import tools. */
function withAttachments(question: string, paths: string[]): string {
  const parts = paths.map((p) => {
    const size = statSync(p).size;
    const raw = size <= INLINE_LIMIT ? readFileSync(p) : null;
    const text = raw && !raw.includes(0) ? raw.toString('utf8') : null;
    return text !== null
      ? `--- attached file ${basename(p)} ---\n${text}\n--- end of ${basename(p)} ---`
      : `--- attached file ${basename(p)} (${size} bytes, not inlined) is at: ${p} — read or import it with your tools ---`;
  });
  return parts.length ? `${question}\n\n${parts.join('\n\n')}` : question;
}

function renderTranscript(s: SessionFile): string {
  const turns = s.turns.map((t, i) => `## ${i + 1}. ${t.at}\n\n**Asked:**\n\n${t.query}\n\n**RUBEN:**\n\n${t.answer}`);
  return `# ${s.title}\n\nSession ${s.id} · started ${s.createdAt} · ${s.turns.length} turn(s)\n\n${turns.join('\n\n---\n\n')}\n`;
}

async function ask(args: string[]): Promise<void> {
  const req = parseAsk(args);
  if (!req.question) fail('usage: ruben ask [--json] --file <path> | ruben ask [--json] "<question>"', 2);
  const model = getSetting('modelId', DEFAULT_MODEL) as string;

  let store: SessionStore;
  if (req.session) {
    const saved = await loadSession(normalizeSessionId(req.session));
    if (!saved) fail(`no session "${req.session}" — omit "session" to start a new one`);
    store = SessionStore.fromExisting(saved);
  } else {
    store = SessionStore.create(model, 'mushegh');
  }
  const sessionKey = `ask:${store.id}`;
  seedSession(sessionKey, model, store.turns);

  const query = withAttachments(req.question, req.attach ?? []);
  const tools: ToolRun[] = [];
  let failure = '';
  const { answer } = await runAgentForMessage({
    sessionKey,
    query,
    model,
    modelProvider: getSetting('provider', DEFAULT_PROVIDER) as string,
    channel: 'cli',
    onEvent: (e) => {
      if (e.type === 'tool_end') tools.push({ tool: e.tool, ok: true, ms: e.duration });
      if (e.type === 'tool_error') tools.push({ tool: e.tool, ok: false, error: e.error.slice(0, 300) });
      if (e.type === 'done' && e.failed) failure = e.answer;
    },
  });
  const failed = Boolean(failure || !answer.trim());
  if (!failed) await store.appendTurn(req.question, answer.trim());

  if (req.json) {
    process.stdout.write(`${JSON.stringify({ session: store.id, answer: failed ? '' : answer.trim(), failed, error: failed ? failure || 'the agent finished without an answer' : undefined, tools })}\n`);
    process.exit(failed ? 1 : 0);
  }
  if (failed) fail(failure || 'the agent finished without an answer');
  process.stdout.write(`${answer.trim()}\n`);
  process.exit(0);
}

async function transcript(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) fail('usage: ruben transcript <session> [--telegram]', 2);
  const saved = await loadSession(normalizeSessionId(id));
  if (!saved) fail(`no session "${id}"`);
  const text = renderTranscript(saved);
  if (!args.includes('--telegram')) {
    process.stdout.write(text);
    process.exit(0);
  }
  // RUBEN's own bot sends it, so Mushegh never holds this token (D-97).
  const path = join(mkdtempSync(join(tmpdir(), 'ruben-transcript-')), `${saved.id.replaceAll(':', '_')}.md`);
  writeFileSync(path, text, 'utf8');
  const { sent, error } = await sendFilesToOwner([path], `RUBEN session: ${saved.title}`);
  if (error || sent.length === 0) fail(error ?? 'nothing was sent');
  process.stdout.write(`sent ${sent[0]} to the owner's Telegram\n`);
  process.exit(0);
}

async function sessions(args: string[]): Promise<void> {
  const list = (await listSessions('mushegh')).slice(0, 10);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(list.map((s) => ({ id: s.id, title: s.title, turns: s.turnCount })))}\n`);
  } else {
    process.stdout.write(list.map((s) => `${s.id}  ${s.title} (${s.turnCount})`).join('\n') + '\n');
  }
  process.exit(0);
}

const [first, ...rest] = process.argv.slice(2);
const run = first === 'transcript' ? transcript(rest) : first === 'sessions' ? sessions(rest) : ask(process.argv.slice(2));
run.catch((err) => fail(err instanceof Error ? err.message : String(err)));
