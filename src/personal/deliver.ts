import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assertCronOutboundAllowed, findTargetSession } from '../cron/executor.js';
import { loadGatewayConfig, resolveTelegramAccount } from '../gateway/config.js';
import { sendDocumentTelegram } from '../gateway/channels/telegram/index.js';

/**
 * Send files to the owner's Telegram chat: the chat the gateway last spoke in,
 * under the same allowFrom guard as scheduled messages. Returns why not when
 * there is no route, rather than failing silently.
 */
export async function sendFilesToOwner(paths: string[], caption: string): Promise<{ sent: string[]; error?: string }> {
  const session = findTargetSession();
  if (!session?.lastTo || !session.lastAccountId) {
    return { sent: [], error: 'No Telegram chat known yet: message the bot once so RUBEN knows where to send files.' };
  }
  try {
    assertCronOutboundAllowed(session);
  } catch (e) {
    return { sent: [], error: e instanceof Error ? e.message : String(e) };
  }
  const account = resolveTelegramAccount(loadGatewayConfig(), session.lastAccountId);
  if (!account?.botToken) return { sent: [], error: 'Telegram is not configured (no bot token).' };
  const sent: string[] = [];
  for (const [i, path] of paths.entries()) {
    await sendDocumentTelegram({
      botToken: account.botToken, chatId: session.lastTo, fileName: basename(path),
      data: readFileSync(path), caption: i === 0 ? caption : undefined,
    });
    sent.push(basename(path));
  }
  return { sent };
}
