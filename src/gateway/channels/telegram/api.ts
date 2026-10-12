import {
  markdownToTelegramHtml,
  chunkHtml,
  stripHtml,
  renderThinkingBlock,
} from './format.js';
import { logger } from '../../../utils/logger.js';

const API_ROOT = 'https://api.telegram.org';

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Minimal Telegram Bot API client. Each call posts JSON to
 * https://api.telegram.org/bot<token>/<method> and unwraps the `result` field.
 */
export async function callTelegram<T = unknown>(
  botToken: string,
  method: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const url = `${API_ROOT}/bot${botToken}/${method}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TelegramApiError(`[Telegram API] network error on ${method}: ${message}`);
  }

  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };

  if (!response.ok || !data.ok) {
    const detail = data.description ?? `${response.status} ${response.statusText}`;
    throw new TelegramApiError(`[Telegram API] ${method} failed: ${detail}`, data.error_code);
  }

  return data.result as T;
}

export type TelegramBotInfo = {
  id: number;
  username?: string;
  first_name?: string;
};

export async function getBotInfo(botToken: string, signal?: AbortSignal): Promise<TelegramBotInfo> {
  return callTelegram<TelegramBotInfo>(botToken, 'getMe', {}, signal);
}

/** Telegram caps text messages at 4096 characters; split on boundaries to be safe. */

export async function sendMessageTelegram(params: {
  botToken: string;
  chatId: string | number;
  text: string;
  /** Thinking-model reasoning, shown collapsed above the answer. */
  reasoning?: string;
  signal?: AbortSignal;
}): Promise<void> {
  // The agent writes markdown. Without parse_mode Telegram renders none of it,
  // so `**MSFT**` arrived as literal asterisks and tables as walls of pipes.
  // Convert to Telegram HTML and declare it.
  const thinking = renderThinkingBlock(params.reasoning ?? '');
  const body = markdownToTelegramHtml(params.text);
  const chunks = chunkHtml(thinking ? `${thinking}

${body}` : body);
  for (const chunk of chunks) {
    try {
      await callTelegram(
        params.botToken,
        'sendMessage',
        {
          chat_id: params.chatId,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        params.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Telegram rejects an entire message over one malformed tag. Losing the
      // answer is far worse than losing the styling, so retry as plain text.
      logger.warn(
        `[Telegram] HTML send failed for chat ${params.chatId}, retrying as plain text: ${message}`,
      );
      try {
        await callTelegram(
          params.botToken,
          'sendMessage',
          {
            chat_id: params.chatId,
            text: stripHtml(chunk),
            disable_web_page_preview: true,
          },
          params.signal,
        );
      } catch (fallbackError) {
        const detail =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        logger.error(`[Telegram] sendMessage failed for chat ${params.chatId}: ${detail}`);
        throw fallbackError;
      }
    }
  }
}

/** Send a file (report, export) as a Telegram document, multipart because the Bot API needs the bytes. */
export async function sendDocumentTelegram(params: {
  botToken: string;
  chatId: string | number;
  fileName: string;
  data: Uint8Array;
  caption?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(params.chatId));
  if (params.caption) form.append('caption', params.caption.slice(0, 1024));
  form.append('document', new Blob([new Uint8Array(params.data)]), params.fileName);
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/bot${params.botToken}/sendDocument`, { method: 'POST', body: form, signal: params.signal ?? AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new TelegramApiError(`[Telegram API] network error on sendDocument: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string; error_code?: number };
  if (!response.ok || !data.ok) {
    throw new TelegramApiError(`[Telegram API] sendDocument failed: ${data.description ?? response.status}`, data.error_code);
  }
}

export async function sendTypingTelegram(params: {
  botToken: string;
  chatId: string | number;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    await callTelegram(
      params.botToken,
      'sendChatAction',
      { chat_id: params.chatId, action: 'typing' },
      params.signal,
    );
  } catch {
    // Typing indicators are best-effort; never fail the turn over one.
  }
}
