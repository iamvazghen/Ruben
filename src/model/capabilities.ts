/**
 * What the currently selected model can do, so the UI can adapt instead of
 * guessing.
 *
 * The immediate need is reasoning: a thinking model produces a visible chain of
 * thought that the user should see labelled as *thinking*, not mistaken for the
 * answer. A non-thinking model produces none, and the UI must not show an empty
 * or fake block for it.
 *
 * Two ways reasoning reaches us:
 *
 *   inline-tags  The model writes <think>...</think> into the message content.
 *                MiniMax M2.x, DeepSeek R1 and QwQ do this. We can capture and
 *                display it verbatim.
 *   api-field    The provider returns reasoning in a separate field, and
 *                usually only a summary or nothing at all (o-series, Claude
 *                extended thinking, Gemini thinking). We can say the model is
 *                reasoning, but we cannot always show the text.
 *
 * The static table below drives what the UI announces up front. Actual display
 * is driven by what arrives at runtime — see markReasoningObserved — so a model
 * that reasons without being listed still gets its blocks.
 */
export type ReasoningStyle = 'inline-tags' | 'api-field' | 'none';

export interface ModelCapabilities {
  /** True when the model performs an explicit reasoning pass. */
  reasoning: boolean;
  reasoningStyle: ReasoningStyle;
  /** Short label for the status bar, e.g. "thinking". */
  label: string;
}

interface Rule {
  match: RegExp;
  style: ReasoningStyle;
}

/** Ordered; first match wins. Patterns test the full model id, case-insensitive. */
const RULES: Rule[] = [
  // Reasoning written inline as <think> tags — we can show the real text.
  { match: /minimax[-/]?m[12]/i, style: 'inline-tags' },
  { match: /deepseek[-_]?(r1|reasoner)/i, style: 'inline-tags' },
  { match: /qwq|qwen.*thinking/i, style: 'inline-tags' },
  { match: /kimi.*thinking/i, style: 'inline-tags' },
  { match: /magistral/i, style: 'inline-tags' },

  // Reasoning kept behind an API field — announce it, but the text may be hidden.
  // MiniMax M3.x returns `reasoning_content` beside a clean `content` (probed 2026-10-12).
  { match: /minimax[-/]?m3/i, style: 'api-field' },
  { match: /^(o1|o3|o4)(-|$)/i, style: 'api-field' },
  { match: /gpt-5/i, style: 'api-field' },
  { match: /claude.*(thinking|reasoning)/i, style: 'api-field' },
  { match: /gemini.*thinking/i, style: 'api-field' },
  { match: /grok.*reasoning/i, style: 'api-field' },
  { match: /glm.*thinking/i, style: 'api-field' },
];

/** Models observed emitting reasoning at runtime, keyed by model id. */
const observed = new Set<string>();

/**
 * Record that a model actually produced reasoning. The static table cannot keep
 * up with every new release, and the runtime signal is the ground truth — once
 * a model has shown us a thinking block, treat it as a thinking model.
 */
export function markReasoningObserved(model: string): void {
  if (model) observed.add(model.toLowerCase());
}

export function getModelCapabilities(model: string): ModelCapabilities {
  const id = (model ?? '').toLowerCase();

  const rule = RULES.find((r) => r.match.test(id));
  if (rule) {
    return { reasoning: true, reasoningStyle: rule.style, label: 'thinking' };
  }

  if (observed.has(id)) {
    return { reasoning: true, reasoningStyle: 'inline-tags', label: 'thinking' };
  }

  return { reasoning: false, reasoningStyle: 'none', label: 'direct' };
}

export function isReasoningModel(model: string): boolean {
  return getModelCapabilities(model).reasoning;
}

/** Reset observed state. Tests only. */
export function _resetObservedForTest(): void {
  observed.clear();
}
