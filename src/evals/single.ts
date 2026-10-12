// Single-query smoke test.
export {};
import 'dotenv/config';
import { Agent } from '../agent/agent.js';

const query = process.argv[2] ?? "What is the current price of Apple stock?";
const model = 'minimax:MiniMax-M3.1-Flash-Preview';

console.log('Model:', model);
console.log('Query:', query);
console.log('');

const agent = await Agent.create({ model, maxIterations: 6, channel: 'cli' });
const toolCalls: string[] = [];
let answer = '';
let totalTokens = 0;
const t0 = Date.now();
for await (const ev of agent.run(query)) {
  if (ev.type === 'tool_start') {
    toolCalls.push(ev.tool);
    console.log(`[tool] ${ev.tool}`);
  }
  if (ev.type === 'tool_error') {
    console.log(`[tool-error] ${ev.tool}: ${ev.error}`);
  }
  if (ev.type === 'done') {
    answer = ev.answer;
    totalTokens = ev.tokenUsage?.totalTokens ?? 0;
  }
}
console.log('');
console.log('Answer:');
console.log(answer);
console.log('');
console.log(`Tools (${toolCalls.length}): ${toolCalls.join(', ')}`);
console.log(`Tokens: ${totalTokens}, Duration: ${Date.now() - t0}ms`);