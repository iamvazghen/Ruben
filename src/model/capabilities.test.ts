import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getModelCapabilities,
  isReasoningModel,
  markReasoningObserved,
  _resetObservedForTest,
} from './capabilities.js';

describe('model capabilities', () => {
  beforeEach(() => _resetObservedForTest());

  test('the configured default reasons behind an API field', () => {
    // MiniMax M3.1 Flash returns reasoning_content beside a clean content.
    const caps = getModelCapabilities('minimax:MiniMax-M3.1-Flash-Preview');
    expect(caps.reasoning).toBe(true);
    expect(caps.reasoningStyle).toBe('api-field');
  });

  test('MiniMax M2.x is recognised as an inline thinking model', () => {
    // MiniMax M2.5 emits <think> inline, which is why reasoning leaked into
    // replies before this existed.
    const caps = getModelCapabilities('minimax:MiniMax-M2.5');
    expect(caps.reasoning).toBe(true);
    expect(caps.reasoningStyle).toBe('inline-tags');
    expect(caps.label).toBe('thinking');
  });

  test('inline-tag reasoners are classified as such', () => {
    for (const m of ['deepseek-r1', 'deepseek-reasoner', 'qwq-32b', 'kimi-k2-thinking']) {
      expect(getModelCapabilities(m).reasoningStyle).toBe('inline-tags');
    }
  });

  test('api-field reasoners are recognised but not treated as inline', () => {
    for (const m of ['o3-mini', 'gpt-5.5', 'gemini-3-pro-thinking']) {
      const caps = getModelCapabilities(m);
      expect(caps.reasoning).toBe(true);
      expect(caps.reasoningStyle).toBe('api-field');
    }
  });

  test('plain models are not thinking models', () => {
    for (const m of ['gpt-4o', 'claude-haiku-4-5', 'llama-3.1-70b', '']) {
      expect(isReasoningModel(m)).toBe(false);
      expect(getModelCapabilities(m).label).toBe('direct');
    }
  });

  test('a model observed reasoning at runtime is promoted', () => {
    // The static table cannot keep up with every release, so what actually
    // arrives wins.
    expect(isReasoningModel('some-new-model-v9')).toBe(false);
    markReasoningObserved('some-new-model-v9');
    expect(isReasoningModel('some-new-model-v9')).toBe(true);
    expect(getModelCapabilities('SOME-NEW-MODEL-V9').reasoning).toBe(true);
  });

  test('classification is case-insensitive', () => {
    expect(isReasoningModel('MINIMAX:MINIMAX-M2.5')).toBe(true);
  });
});
