#!/usr/bin/env -S node --import tsx
// One-shot, non-interactive query: how another process (Mushegh) asks RUBEN something.
//   ruben ask --file <path>    question read from a file (safe through a .cmd shim)
//   ruben ask "<question>"
// The answer goes to stdout; exit 1 with the reason on stderr when there is none.
// Tools that need approval are denied: there is nobody here to approve them.
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { runAgentForMessage } from './gateway/agent-runner.js';
import { getSetting } from './utils/config.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from './model/llm.js';

config({ quiet: true });

const args = process.argv.slice(2);
const fileAt = args.indexOf('--file');
const query = (fileAt >= 0 ? readFileSync(args[fileAt + 1] ?? '', 'utf8') : args.join(' ')).trim();

if (!query) {
  console.error('[ruben] usage: ruben ask --file <path> | ruben ask "<question>"');
  process.exit(2);
}

let failure = '';
try {
  const { answer } = await runAgentForMessage({
    sessionKey: 'ask:oneshot',
    query,
    model: getSetting('modelId', DEFAULT_MODEL) as string,
    modelProvider: getSetting('provider', DEFAULT_PROVIDER) as string,
    channel: 'cli',
    onEvent: (e) => {
      if (e.type === 'done' && e.failed) failure = e.answer;
    },
  });
  if (failure || !answer.trim()) {
    console.error(`[ruben] ${failure || 'the agent finished without an answer'}`);
    process.exit(1);
  }
  process.stdout.write(`${answer.trim()}\n`);
  process.exit(0);
} catch (err) {
  console.error(`[ruben] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
