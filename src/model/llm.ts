import { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOllama } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { StructuredToolInterface } from '@langchain/core/tools';
import { Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT } from '@/agent/default-prompt';
import type { TokenUsage } from '@/agent/types';
import { logger } from '@/utils/logger';
import { classifyError, isNonRetryableError } from '@/utils/errors';
import { resolveProvider, getProviderById } from '@/providers';

// minimax is the default: the user provided a custom OpenAI-compatible key for a
// proxy that fronts minimax (M3.1 Flash Preview since 2026-10-12). Set MINIMAX_BASE_URL in .env to point at the
// proxy; if unset, the placeholder baseUrlDefault is used (which will fail until
// configured — model-selection.ts guides the user to set it).
export const DEFAULT_PROVIDER = 'minimax';
export const DEFAULT_MODEL = 'minimax:MiniMax-M3.1-Flash-Preview';

/**
 * Gets the fast model variant for the given provider.
 * Falls back to the provided model if no fast variant is configured (e.g., Ollama).
 */
export function getFastModel(modelProvider: string, fallbackModel: string): string {
  return getProviderById(modelProvider)?.fastModel ?? fallbackModel;
}

// Generic retry helper with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, provider: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorType = classifyError(message);
      logger.error(`[${provider} API] ${errorType} error (attempt ${attempt + 1}/${maxAttempts}): ${message}`);

      if (isNonRetryableError(message)) {
        throw new Error(`[${provider} API] ${message}`);
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(`[${provider} API] ${message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error('Unreachable');
}

// Model provider configuration
interface ModelOpts {
  streaming: boolean;
}

type ModelFactory = (name: string, opts: ModelOpts) => BaseChatModel;

function getApiKey(envVar: string): string {
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new Error(`[LLM] ${envVar} not found in environment variables`);
  }
  return apiKey;
}

// Factories keyed by provider id — prefix routing is handled by resolveProvider()
const MODEL_FACTORIES: Record<string, ModelFactory> = {
  anthropic: (name, opts) =>
    new ChatAnthropic({
      model: name,
      ...opts,
      apiKey: getApiKey('ANTHROPIC_API_KEY'),
    }),
  google: (name, opts) =>
    new ChatGoogleGenerativeAI({
      model: name,
      ...opts,
      apiKey: getApiKey('GOOGLE_API_KEY'),
    }),
  xai: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('XAI_API_KEY'),
      configuration: {
        baseURL: 'https://api.x.ai/v1',
      },
    }),
  openrouter: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^openrouter:/, ''),
      ...opts,
      apiKey: getApiKey('OPENROUTER_API_KEY'),
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
      },
    }),
  moonshot: (name, opts) =>
    new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('MOONSHOT_API_KEY'),
      configuration: {
        baseURL: 'https://api.moonshot.cn/v1',
      },
    }),
  deepseek: (name, opts) => {
    // Both deepseek-v4-pro and deepseek-v4-flash support thinking mode.
    // temperature/top_p/presence_penalty/frequency_penalty are ignored in thinking mode.
    const isThinkingModel = name === 'deepseek-v4-pro' || name === 'deepseek-v4-flash';
    return new ChatOpenAI({
      model: name,
      ...opts,
      apiKey: getApiKey('DEEPSEEK_API_KEY'),
      configuration: {
        baseURL: 'https://api.deepseek.com',
      },
      ...(isThinkingModel && {
        // reasoning_effort is a top-level param; thinking toggle goes in extra_body
        // per DeepSeek V4 API docs (OpenAI SDK compat layer)
        reasoning_effort: 'high',
        extraBody: {
          thinking: { type: 'enabled' },
        },
      }),
    });
  },
  freellmapi: (name, opts) =>
    new ChatOpenAI({
      model: name.replace(/^freellmapi:/, ''),
      ...opts,
      apiKey: getApiKey('FREELLMAPI_API_KEY'),
      configuration: {
        baseURL: process.env.FREELLMAPI_BASE_URL || 'http://localhost:3001/v1',
      },
    }),
  ollama: (name, opts) =>
    new ChatOllama({
      model: name.replace(/^ollama:/, ''),
      ...opts,
      ...(process.env.OLLAMA_BASE_URL ? { baseUrl: process.env.OLLAMA_BASE_URL } : {}),
    }),
  minimax: (name, opts) => {
    const baseURL = process.env.MINIMAX_BASE_URL || 'https://api.minimax.example/v1';
    return new ChatOpenAI({
      model: name.replace(/^minimax:/, ''),
      ...opts,
      apiKey: getApiKey('MINIMAX_API_KEY'),
      configuration: { baseURL },
    });
  },
};

const DEFAULT_FACTORY: ModelFactory = (name, opts) =>
  new ChatOpenAI({
    model: name,
    ...opts,
    apiKey: getApiKey('OPENAI_API_KEY'),
  });

export function getChatModel(
  modelName: string = DEFAULT_MODEL,
  streaming: boolean = false
): BaseChatModel {
  const opts: ModelOpts = { streaming };
  const provider = resolveProvider(modelName);
  const factory = MODEL_FACTORIES[provider.id] ?? DEFAULT_FACTORY;
  return factory(modelName, opts);
}

interface CallLlmOptions {
  model?: string;
  systemPrompt?: string;
  outputSchema?: z.ZodType<unknown>;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
  /**
   * Hard ceiling for the whole call. Internal "utility" LLM calls (e.g. the
   * stock screener translating natural language → filters) route through
   * whatever provider is default — including slow free proxies that can stall
   * for minutes. A timeout converts a multi-minute hang into a fast, recoverable
   * error so the agent can move on.
   *
   * Defaults to DEFAULT_LLM_TIMEOUT_MS. Leaving it unset used to mean no
   * ceiling at all, which is the opposite of what this comment promised.
   */
  timeoutMs?: number;
}

/**
 * Ceiling for a single callLlm, covering all of withRetry's attempts.
 *
 * withLlmTimeout treats an undefined budget as no budget, and nine of the ten
 * callers never passed one - so a provider that accepted the connection and then
 * went quiet hung the caller forever. In practice that meant read_filings and the
 * other planning meta-tools could stall a Telegram or CLI turn with no error and
 * no output, and it hung the health sweep hard enough to need killing twice.
 * A planning call that has not answered in two minutes is not going to.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

function withLlmTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`LLM call exceeded ${Math.round(ms / 1000)}s timeout`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface LlmResult {
  response: AIMessage | string;
  usage?: TokenUsage;
}

function extractUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const msg = result as Record<string, unknown>;

  const usageMetadata = msg.usage_metadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    const u = usageMetadata as Record<string, unknown>;
    const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    const total = typeof u.total_tokens === 'number' ? u.total_tokens : input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  const responseMetadata = msg.response_metadata;
  if (responseMetadata && typeof responseMetadata === 'object') {
    const rm = responseMetadata as Record<string, unknown>;
    if (rm.usage && typeof rm.usage === 'object') {
      const u = rm.usage as Record<string, unknown>;
      const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
      const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
      const total = typeof u.total_tokens === 'number' ? u.total_tokens : input + output;
      return { inputTokens: input, outputTokens: output, totalTokens: total };
    }
  }

  return undefined;
}

/**
 * Build messages with Anthropic cache_control on the system prompt.
 * Marks the system prompt as ephemeral so Anthropic caches the prefix,
 * reducing input token costs by ~90% on subsequent calls.
 */
function buildAnthropicMessages(systemPrompt: string, userPrompt: string) {
  return [
    new SystemMessage({
      content: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
    }),
    new HumanMessage(userPrompt),
  ];
}

export async function callLlm(prompt: string, options: CallLlmOptions = {}): Promise<LlmResult> {
  const {
    model = DEFAULT_MODEL,
    systemPrompt,
    outputSchema,
    tools,
    signal,
    timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  } = options;
  const finalSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const llm = getChatModel(model, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (outputSchema) {
    runnable = llm.withStructuredOutput(outputSchema, { strict: false });
  } else if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;
  const provider = resolveProvider(model);
  let result;

  if (provider.id === 'anthropic') {
    // Anthropic: use explicit messages with cache_control for prompt caching (~90% savings)
    const messages = buildAnthropicMessages(finalSystemPrompt, prompt);
    result = await withLlmTimeout(
      withRetry(() => runnable.invoke(messages, invokeOpts), provider.displayName),
      timeoutMs,
    );
  } else {
    // Other providers: use ChatPromptTemplate (OpenAI/Gemini have automatic caching)
    const promptTemplate = ChatPromptTemplate.fromMessages([
      ['system', finalSystemPrompt],
      ['user', '{prompt}'],
    ]);
    const chain = promptTemplate.pipe(runnable);
    result = await withLlmTimeout(
      withRetry(() => chain.invoke({ prompt }, invokeOpts), provider.displayName),
      timeoutMs,
    );
  }
  const usage = extractUsage(result);

  // If no outputSchema and no tools, extract content from AIMessage
  // When tools are provided, return the full AIMessage to preserve tool_calls
  if (!outputSchema && !tools && result && typeof result === 'object' && 'content' in result) {
    return { response: (result as { content: string }).content, usage };
  }
  return { response: result as AIMessage, usage };
}

// ---------------------------------------------------------------------------
// Multi-turn message array API
// ---------------------------------------------------------------------------

/**
 * Annotate the first SystemMessage with Anthropic's cache_control for prompt
 * caching (~90% input token savings on repeated calls).
 */
function annotateSystemMessageForCaching(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length === 0 || messages[0]._getType() !== 'system') {
    return messages;
  }

  const systemMsg = messages[0];
  const text = typeof systemMsg.content === 'string'
    ? systemMsg.content
    : JSON.stringify(systemMsg.content);

  const annotated = new SystemMessage({
    content: [
      {
        type: 'text' as const,
        text,
        cache_control: { type: 'ephemeral' },
      },
    ],
  });

  return [annotated, ...messages.slice(1)];
}

interface CallLlmWithMessagesOptions {
  model?: string;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

/**
 * Call an LLM with a full message array (multi-turn tool-calling).
 *
 * Unlike callLlm() which takes a single prompt string, this function accepts
 * a BaseMessage[] array containing SystemMessage, HumanMessage, AIMessage,
 * and ToolMessage objects. This enables the agent loop where
 * conversation history (including model reasoning and tool results) persists
 * across iterations.
 *
 * All LangChain providers support BaseMessage[] via BaseChatModel.invoke().
 */
export async function callLlmWithMessages(
  messages: BaseMessage[],
  options: CallLlmWithMessagesOptions = {},
): Promise<LlmResult> {
  const { model = DEFAULT_MODEL, tools, signal } = options;

  const llm = getChatModel(model, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;
  const provider = resolveProvider(model);

  // For Anthropic: annotate SystemMessage with cache_control for prompt caching
  const finalMessages = provider.id === 'anthropic'
    ? annotateSystemMessageForCaching(messages)
    : messages;

  const result = await withRetry(
    () => runnable.invoke(finalMessages, invokeOpts),
    provider.displayName,
  );

  const usage = extractUsage(result);
  return { response: result as AIMessage, usage };
}

// ---------------------------------------------------------------------------
// Streaming multi-turn API
// ---------------------------------------------------------------------------

/**
 * Stream an LLM response as AIMessageChunk objects.
 *
 * Uses LangChain's .stream() method. Chunks can be accumulated via .concat()
 * to progressively build complete tool_calls. Falls back to blocking invoke
 * if streaming is not supported by the provider.
 */
export async function* streamLlmWithMessages(
  messages: BaseMessage[],
  options: CallLlmWithMessagesOptions = {},
): AsyncGenerator<AIMessageChunk, void> {
  const { model = DEFAULT_MODEL, tools, signal } = options;
  const provider = resolveProvider(model);

  // Some OpenAI-compatible proxies (e.g. FreeLLMAPI) emit streaming tool-call
  // deltas WITHOUT the `index` field LangChain needs to accumulate them, which
  // silently drops every tool call (the agent then has nothing to act on and
  // returns an empty answer). For those providers, fall back to a single
  // non-streaming invoke — which parses tool calls correctly — and yield the
  // result as one chunk so the agent loop is unaffected.
  const useStreaming = provider.id !== 'freellmapi';

  const llm = getChatModel(model, useStreaming);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runnable: Runnable<any, any> = llm;

  if (tools && tools.length > 0 && llm.bindTools) {
    runnable = llm.bindTools(tools);
  }

  const invokeOpts = signal ? { signal } : undefined;

  const finalMessages = provider.id === 'anthropic'
    ? annotateSystemMessageForCaching(messages)
    : messages;

  if (!useStreaming) {
    const result = (await runnable.invoke(finalMessages, invokeOpts)) as AIMessage;
    yield new AIMessageChunk({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: result.content as any,
      tool_calls: result.tool_calls,
      additional_kwargs: result.additional_kwargs,
      response_metadata: result.response_metadata,
      usage_metadata: result.usage_metadata,
      id: result.id,
    });
    return;
  }

  const stream = await runnable.stream(finalMessages, invokeOpts);

  for await (const chunk of stream) {
    yield chunk as AIMessageChunk;
  }
}
