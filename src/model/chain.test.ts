import { expect, test } from 'bun:test';
import { modelChain } from './llm.js';
import { resolveProvider } from '../providers.js';

test('the requested model goes first, then RUBEN_MODEL_CHAIN without repeating it', () => {
  process.env.RUBEN_MODEL_CHAIN = 'nvidia:a/b, experiential:c ,minimax:d';
  expect(modelChain('experiential:c')).toEqual(['experiential:c', 'nvidia:a/b', 'minimax:d']);
  delete process.env.RUBEN_MODEL_CHAIN;
  expect(modelChain('minimax:d')).toEqual(['minimax:d']);
});

test('each free endpoint routes by its own prefix', () => {
  expect(resolveProvider('nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b').id).toBe('nvidia');
  expect(resolveProvider('experiential:deepseek-v4.1-flash').id).toBe('experiential');
  expect(resolveProvider('groq:openai/gpt-oss-120b').id).toBe('groq');
});
