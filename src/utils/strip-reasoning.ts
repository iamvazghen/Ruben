/**
 * Separate a model's inline reasoning from its answer.
 *
 * MiniMax M2.5 — the default until 2026-10-12 — emits its chain of thought inline as
 * `<think>...</think>` in the message content rather than as a separate
 * reasoning field. Nothing handled it, so a Telegram reply opened with
 * "The user wants me to report the MSFT grading results. Let me extract..."
 * before getting to the answer.
 *
 * The first fix simply deleted it. That is right for a non-thinking surface but
 * wrong in general: on a thinking model the reasoning is worth showing, clearly
 * labelled as thinking rather than as the answer. So this splits rather than
 * strips, and each surface decides what to do with the two halves.
 *
 * Other providers use the same convention with different tags, so the whole
 * family is handled.
 */
const REASONING_TAGS = ['think', 'thinking', 'reasoning', 'reflection'];

const CLOSED_BLOCK = new RegExp(`<(${REASONING_TAGS.join('|')})>([\\s\\S]*?)<\\/\\1>`, 'gi');
const UNCLOSED_BLOCK = new RegExp(`<(${REASONING_TAGS.join('|')})>([\\s\\S]*)$`, 'i');

export interface SplitResponse {
  /** The user-facing answer, with reasoning removed. */
  answer: string;
  /** The model's reasoning, empty when it produced none. */
  reasoning: string;
}

export function extractReasoning(text: string): SplitResponse {
  if (!text) return { answer: text ?? '', reasoning: '' };

  const thoughts: string[] = [];

  let answer = text.replace(CLOSED_BLOCK, (_m, _tag: string, body: string) => {
    if (body.trim()) thoughts.push(body.trim());
    return '';
  });

  // An unclosed opener means the model was cut off mid-thought. Everything from
  // there on is reasoning, never answer — but only drop it if some answer
  // survives, otherwise a truncated reply would come back completely empty and
  // the user would see nothing at all.
  const unclosed = UNCLOSED_BLOCK.exec(answer);
  if (unclosed) {
    const trimmed = answer.replace(UNCLOSED_BLOCK, '');
    if (trimmed.trim().length > 0) {
      if (unclosed[2]?.trim()) thoughts.push(unclosed[2].trim());
      answer = trimmed;
    }
  }

  // A stray closing tag with no opener — the opener was consumed upstream, which
  // is the exact shape MiniMax produces. Everything before it was reasoning.
  const lastClose = answer.lastIndexOf('</think>');
  if (lastClose !== -1) {
    const after = answer.slice(lastClose + '</think>'.length);
    if (after.trim().length > 0) {
      const before = answer.slice(0, lastClose).trim();
      if (before) thoughts.unshift(before);
      answer = after;
    }
  }

  return { answer: answer.trim(), reasoning: thoughts.join('\n\n').trim() };
}

/** Answer only. For surfaces that never display reasoning. */
export function stripReasoning(text: string): string {
  return extractReasoning(text).answer;
}
