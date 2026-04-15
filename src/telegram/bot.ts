import { config } from '../config/index.js';
import { handleCommand } from './commands.js';
import { approvalService } from '../services/approvalService.js';
import { ApprovalKeyboard } from './keyboards.js';

// ─── State ───────────────────────────────────────────────────────────────────

let token = '';
let offset = 0;
let running = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastSentTime = 0;
let lastSentMessage: TelegramMessage | null = null;
const MESSAGE_RATE_LIMIT = 1000;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

// Map chatId -> requestId pending custom input
const pendingCustomInputChat: Map<number, string> = new Map();
// Map chatId -> message ID of the force_reply prompt
const customInputMessageId: Map<number, number> = new Map();

// Simple message queue — each entry is { chatId, text, replyMarkup? }
interface QueuedMessage {
  chatId: number;
  text: string;
  replyMarkup?: ApprovalKeyboard;
}
const messageQueue: QueuedMessage[] = [];

// ─── Types ───────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message_id?: number;
  };
  callback_query?: {
    id: string;
    message?: {
      message_id: number;
      chat: { id: number };
    };
    data?: string;
  };
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

interface TelegramSendResponse {
  ok: boolean;
  result?: TelegramMessage;
  description?: string;
}

interface EditMessageResult {
  ok: boolean;
  result?: TelegramMessage;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

// ─── Core Bot Functions ───────────────────────────────────────────────────────

async function startBot(): Promise<void> {
  token = config.telegramBotToken;
  if (!token || token === 'placeholder_token') {
    console.log('[Telegram] Bot token not configured, skipping bot start');
    return;
  }

  await setMyCommands();
  running = true;
  console.log('[Telegram] Bot started');
  poll();
}

function stopBot(): void {
  running = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  console.log('[Telegram] Bot stopped');
}

async function poll(): Promise<void> {
  while (running) {
    try {
      await fetchUpdates();
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Telegram] Poll error (${consecutiveErrors}): ${errorMsg}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
        console.error(`[Telegram] Too many consecutive errors, backing off for ${backoffMs}ms...`);
        await sleep(backoffMs);
      } else {
        await sleep(5000);
      }
    }
  }
}

async function fetchUpdates(): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1`;

  const response = await fetch(url);
  const data = (await response.json()) as TelegramGetUpdatesResponse;

  if (!data.ok) {
    handleTelegramAPIError(data.description);
    return;
  }

  if (!data.result || data.result.length === 0) {
    return;
  }

  for (const update of data.result) {
    await processUpdate(update);
    offset = update.update_id + 1;
  }
}

async function handleTelegramAPIError(description?: string): Promise<void> {
  if (!description) return;

  if (
    description.includes('bot was blocked by user') ||
    description.includes('Forbidden: bot was blocked by the user')
  ) {
    console.warn('[Telegram] Bot was blocked by user. Consider /start to re-enable.');
    return;
  }

  if (description.includes('Too many requests') || description.includes('rate limit')) {
    console.warn('[Telegram] Rate limited by Telegram API. Backing off...');
    sleep(60000);
    return;
  }

  if (description.includes('Unauthorized') || description.includes('invalid token')) {
    console.error('[Telegram] Invalid bot token. Please check TELEGRAM_BOT_TOKEN.');
    stopBot();
    return;
  }

  console.error(`[Telegram] API error: ${description}`);
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  try {
    // Handle callback queries (button presses)
    if (update.callback_query) {
      const { id, data, message } = update.callback_query;
      if (data && message) {
        console.log(`[Telegram] Callback query: ${data}`);
        await answerCallback(id);

        const callbackParts = data.split(':');
        const action = callbackParts[0];
        const requestId = callbackParts.slice(1).join(':');

        if (action === 'custom') {
          pendingCustomInputChat.set(message.chat.id, requestId);
        }

        await handleCommand(`/callback ${data}`, message.chat.id, message.message_id);
      }
    }

    // Handle messages (text commands and force_reply responses)
    if (update.message) {
      const { chat, text, reply_to_message_id, message_id } = update.message;

      // Debug: log ALL messages with reply_to_message_id
      if (reply_to_message_id !== undefined) {
        const forceReplyMsgId = customInputMessageId.get(chat.id);
        console.log(`[Telegram] Message with reply_to_message_id=${reply_to_message_id}, forceReplyMsgId=${forceReplyMsgId}, pendingRequestId=${pendingCustomInputChat.get(chat.id)}, text="${text?.substring(0, 50)}"`);
      }

      // Handle force_reply responses (custom input)
      if (text && reply_to_message_id !== undefined) {
        const forceReplyMsgId = customInputMessageId.get(chat.id);
        console.log(`[Telegram] Checking force_reply: reply_to_message_id=${reply_to_message_id}, forceReplyMsgId=${forceReplyMsgId}, match=${forceReplyMsgId === reply_to_message_id}`);
        if (forceReplyMsgId && reply_to_message_id === forceReplyMsgId) {
          const requestId = pendingCustomInputChat.get(chat.id);
          console.log(`[Telegram] Force reply MATCH! requestId=${requestId}`);
          if (requestId) {
            console.log(`[Telegram] Custom input received for ${requestId}: ${text}`);
            // Delete the force_reply prompt message first
            await deleteMessage(chat.id, reply_to_message_id);
            await approvalService.handleCustomInput(requestId, text);
            pendingCustomInputChat.delete(chat.id);
            customInputMessageId.delete(chat.id);
            return;
          }
        } else {
          console.log(`[Telegram] Force reply NO MATCH: stored=${forceReplyMsgId}, received=${reply_to_message_id}`);
        }
      }

      // Fallback: if user sends a message without reply_to_message_id but we have a pending custom input,
      // treat it as the custom input (in case Telegram didn't set the reply context properly)
      if (text && pendingCustomInputChat.has(chat.id)) {
        const requestId = pendingCustomInputChat.get(chat.id);
        if (requestId) {
          console.log(`[Telegram] No reply_to_message_id but has pending custom input: ${requestId}, treating as custom input`);
          // Delete the force_reply prompt message if we have it stored
          const forceReplyMsgId = customInputMessageId.get(chat.id);
          if (forceReplyMsgId) {
            await deleteMessage(chat.id, forceReplyMsgId);
          }
          console.log(`[Telegram] Custom input received for ${requestId}: ${text}`);
          await approvalService.handleCustomInput(requestId, text);
          pendingCustomInputChat.delete(chat.id);
          customInputMessageId.delete(chat.id);
          return;
        }
      }

      // Debug: log ALL incoming messages to see what's arriving
      console.log(`[Telegram] Incoming message: msgId=${message_id}, chatId=${chat.id}, text="${text?.substring(0, 30)}", reply_to=${reply_to_message_id}, hasPendingCustom=${pendingCustomInputChat.has(chat.id)}, pendingMsgId=${customInputMessageId.get(chat.id)}`);

      // Handle text commands (e.g. /start, /status, etc.)
      if (text && text.startsWith('/')) {
        // If custom input is pending, cancel it first
        if (pendingCustomInputChat.has(chat.id)) {
          console.log(`[Telegram] Cancelling pending custom input due to command`);
          pendingCustomInputChat.delete(chat.id);
          customInputMessageId.delete(chat.id);
          // Also clear in approvalService
          approvalService.cancelCustomInput(chat.id);
        }
        console.log(`[Telegram] Command message: ${text}`);
        await handleCommand(text, chat.id, message_id);
        return;
      }
    }
  } catch (error) {
    console.error('[Telegram] Error processing update:', error);
  }
}

async function answerCallback(queryId: string): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${token}/answerCallbackQuery?callback_query_id=${queryId}`;
    const response = await fetch(url);
    const data = (await response.json()) as { ok: boolean; description?: string };

    if (!data.ok) {
      console.warn(`[Telegram] answerCallbackQuery failed: ${data.description}`);
    }
  } catch (error) {
    console.error('[Telegram] answerCallbackQuery error:', error);
  }
}

// ─── Send / Edit Functions ───────────────────────────────────────────────────

async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: ApprovalKeyboard
): Promise<boolean> {
  try {
    messageQueue.push({ chatId, text, replyMarkup });
    await processQueue();
    return true;
  } catch (error) {
    console.error('[Telegram] sendMessage error:', error);
    return false;
  }
}

async function sendMessageWithId(
  chatId: number,
  text: string,
  replyMarkup?: ApprovalKeyboard
): Promise<TelegramMessage | null> {
  console.log(`[Telegram] sendMessageWithId called for chat ${chatId}, text length: ${text.length}`);
  try {
    messageQueue.push({ chatId, text, replyMarkup });
    await processQueue();
    const sent = lastSentMessage;
    console.log(`[Telegram] sendMessageWithId got lastSentMessage:`, JSON.stringify(sent));
    lastSentMessage = null;
    return sent;
  } catch (error) {
    console.error('[Telegram] sendMessageWithId error:', error);
    return null;
  }
}

async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: ApprovalKeyboard
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  try {
    const bodyObj: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
    };
    if (replyMarkup) {
      bodyObj.reply_markup = replyMarkup;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });

    const data = (await response.json()) as EditMessageResult;

    if (!data.ok) {
      if (data.error_code === 429) {
        const retryAfter = data.parameters?.retry_after ?? 5;
        await sleep(retryAfter * 1000);
        return editMessage(chatId, messageId, text, replyMarkup);
      }
      console.warn(`[Telegram] editMessage failed: ${data.description}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram] editMessage error:', error);
    return false;
  }
}

async function editMessageReplyMarkup(
  chatId: number,
  messageId: number,
  replyMarkup?: ApprovalKeyboard
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });

    const data = (await response.json()) as EditMessageResult;

    if (!data.ok) {
      if (data.error_code === 429) {
        const retryAfter = data.parameters?.retry_after ?? 5;
        await sleep(retryAfter * 1000);
        return editMessageReplyMarkup(chatId, messageId, replyMarkup);
      }
      console.warn(`[Telegram] editMessageReplyMarkup failed: ${data.description}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram] editMessageReplyMarkup error:', error);
    return false;
  }
}

async function setMyCommands(): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Show welcome message and this help' },
          { command: 'away', description: 'Turn on approval mode — tool calls need your OK before running' },
          { command: 'desk', description: 'Turn off approval mode — all tool calls run automatically (transparent passthrough)' },
          { command: 'status', description: 'Show current bot status and mode' },
          { command: 'clear', description: 'Reset the status message and clear any pending state' },
        ],
      }),
    });
    const data = (await response.json()) as { ok: boolean };
    if (!data.ok) {
      console.warn('[Telegram] setMyCommands failed');
    }
  } catch (error) {
    console.warn('[Telegram] setMyCommands error:', error);
  }
}

async function sendMessageForceReply(chatId: number, text: string): Promise<number | null> {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true },
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = (await response.json()) as TelegramSendResponse;
    console.log(`[Telegram] sendMessageForceReply result: ok=${data.ok}, message_id=${data.result?.message_id}, description=${data.description}`);
    if (!data.ok) {
      handleTelegramAPIError(data.description);
      return null;
    }
    return data.result?.message_id ?? null;
  } catch (error) {
    console.error('[Telegram] sendMessageForceReply error:', error);
    return null;
  }
}

// ─── Queue Processing ────────────────────────────────────────────────────────

async function processQueue(): Promise<void> {
  while (messageQueue.length > 0) {
    const now = Date.now();
    const timeSinceLast = now - lastSentTime;

    if (timeSinceLast < MESSAGE_RATE_LIMIT) {
      await sleep(MESSAGE_RATE_LIMIT - timeSinceLast);
    }

    const message = messageQueue.shift();
    if (message) {
      const result = await doSendMessage(message.chatId, message.text, message.replyMarkup);
      if (result) {
        lastSentMessage = result;
        lastSentTime = Date.now();
      } else {
        messageQueue.unshift(message);
        await sleep(5000);
      }
    }
  }
}

async function doSendMessage(
  chatId: number,
  text: string,
  replyMarkup?: ApprovalKeyboard
): Promise<TelegramMessage | null> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  console.log(`[Telegram] doSendMessage sending to chat ${chatId}`);
  const bodyObj: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) {
    bodyObj.reply_markup = replyMarkup;
  }
  const body = JSON.stringify(bodyObj);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = (await response.json()) as TelegramSendResponse;

    if (!data.ok) {
      handleTelegramAPIError(data.description);
      console.warn(`[Telegram] doSendMessage failed: ${data.description}`);
      return null;
    }

    console.log(`[Telegram] doSendMessage succeeded, message_id: ${data.result?.message_id}`);
    return data.result ?? null;
  } catch (error) {
    console.error('[Telegram] Send error:', error);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deleteMessage(chatId: number, messageId: number): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/deleteMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });
    const data = (await response.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      console.warn(`[Telegram] deleteMessage failed: ${data.description}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[Telegram] deleteMessage error:', error);
    return false;
  }
}

async function clearBotMessages(chatId: number): Promise<void> {
  // Get the chat history to find messages sent by the bot
  const url = `https://api.telegram.org/bot${token}/getChatHistory?chat_id=${chatId}&limit=100`;
  try {
    const response = await fetch(url);
    const data = (await response.json()) as { ok: boolean; result?: { message_id: number; from?: { id: number } }[] };

    if (!data.ok || !data.result) {
      console.warn('[Telegram] getChatHistory failed');
      return;
    }

    // Delete all messages sent by this bot (our bot_id)
    const botId = parseInt(token.split(':')[0], 10);
    const messagesToDelete = data.result.filter(
      msg => msg.from && msg.from.id === botId
    );

    console.log(`[Telegram] Found ${messagesToDelete.length} bot messages to delete`);

    for (const msg of messagesToDelete) {
      await deleteMessage(chatId, msg.message_id);
      await sleep(100); // Rate limit protection
    }
  } catch (error) {
    console.error('[Telegram] clearBotMessages error:', error);
  }
}

// ─── Accessors ───────────────────────────────────────────────────────────────

function setCustomInputMessageId(chatId: number, messageId: number): void {
  customInputMessageId.set(chatId, messageId);
}

function clearCustomInputState(chatId: number): void {
  customInputMessageId.delete(chatId);
  pendingCustomInputChat.delete(chatId);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export function escapeMarkdown(text: string): string {
  // Only escape backticks and square brackets - these break Telegram's code blocks
  const specialChars = /([`\[\]])/g;
  return text.replace(specialChars, '\\$&');
}

export const telegramBot = {
  start: startBot,
  stop: stopBot,
  sendMessage,
  sendMessageWithId,
  editMessage,
  editMessageReplyMarkup,
  sendMessageForceReply,
  deleteMessage,
  clearBotMessages,
  setCustomInputMessageId,
  clearCustomInputState,
  escapeMarkdown,
};
