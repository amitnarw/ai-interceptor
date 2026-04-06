import { config } from '../config/index.js';
import { handleCommand } from './commands.js';
import { approvalService } from '../services/approvalService.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
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

interface TelegramResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

class TelegramBot {
  private token: string;
  private offset = 0;
  private running = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private messageQueue: Array<{ chatId: number; text: string }> = [];
  private lastSentTime = 0;
  private readonly MESSAGE_RATE_LIMIT = 1000;
  private consecutiveErrors = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 5;

  // Map chatId -> requestId pending custom input
  private pendingCustomInputChat: Map<number, string> = new Map();

  constructor() {
    this.token = config.telegramBotToken;
  }

  async start(): Promise<void> {
    if (!this.token || this.token === 'placeholder_token') {
      console.log('[Telegram] Bot token not configured, skipping bot start');
      return;
    }

    this.running = true;
    console.log('[Telegram] Bot started');
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('[Telegram] Bot stopped');
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        await this.fetchUpdates();
        this.consecutiveErrors = 0; // Reset on success
      } catch (error) {
        this.consecutiveErrors++;
        console.error(`[Telegram] Poll error (${this.consecutiveErrors}):`, error);

        if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
          console.error('[Telegram] Too many consecutive errors, backing off...');
          await this.sleep(30000); // 30 second backoff
        } else {
          await this.sleep(5000);
        }
      }
    }
  }

  private async fetchUpdates(): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=1`;

    const response = await fetch(url);
    const data = (await response.json()) as TelegramResponse;

    if (!data.ok) {
      // Handle specific Telegram API errors
      this.handleTelegramAPIError(data.description);
      return;
    }

    if (!data.result || data.result.length === 0) {
      return;
    }

    for (const update of data.result) {
      await this.processUpdate(update);
      this.offset = update.update_id + 1;
    }
  }

  private handleTelegramAPIError(description?: string): void {
    if (!description) return;

    // Bot blocked by user
    if (description.includes('bot was blocked by user') ||
        description.includes('Forbidden: bot was blocked by the user')) {
      console.warn('[Telegram] Bot was blocked by user. Consider using /start to re-enable.');
      // Don't stop polling, just log warning
      return;
    }

    // Rate limit
    if (description.includes('Too many requests') ||
        description.includes('rate limit')) {
      console.warn('[Telegram] Rate limited by Telegram API. Backing off...');
      this.sleep(60000); // 1 minute backoff
      return;
    }

    // Token invalid
    if (description.includes('Unauthorized') ||
        description.includes('invalid token')) {
      console.error('[Telegram] Invalid bot token. Please check TELEGRAM_BOT_TOKEN.');
      this.stop();
      return;
    }

    console.error(`[Telegram] API error: ${description}`);
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.message) {
        const { chat, text, message_id } = update.message;
        if (text) {
          console.log(`[Telegram] Message from ${chat.id}: ${text}`);

          // Check if this chat has a pending custom input request
          const requestId = this.pendingCustomInputChat.get(chat.id);
          if (requestId && approvalService.getPendingCustomInputCount() > 0) {
            // Treat this message as custom input
            await approvalService.handleCustomInput(requestId, text);
            this.pendingCustomInputChat.delete(chat.id);
          } else {
            // Normal command handling
            await handleCommand(text, chat.id, message_id);
          }
        }
      }

      if (update.callback_query) {
        const { id, data, message } = update.callback_query;
        if (data && message) {
          console.log(`[Telegram] Callback query: ${data}`);
          await this.answerCallback(id);

          // Parse callback data
          const callbackParts = data.split(':');
          const action = callbackParts[0];
          const requestId = callbackParts.slice(1).join(':');

          if (action === 'custom') {
            // Mark this chat as pending custom input
            this.pendingCustomInputChat.set(message.chat.id, requestId);
          }

          await handleCommand(`/callback ${data}`, message.chat.id, message.message_id);
        }
      }
    } catch (error) {
      console.error('[Telegram] Error processing update:', error);
    }
  }

  private async answerCallback(queryId: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery?callback_query_id=${queryId}`;
      const response = await fetch(url);
      const data = (await response.json()) as TelegramResponse;

      if (!data.ok) {
        console.warn(`[Telegram] answerCallbackQuery failed: ${data.description}`);
      }
    } catch (error) {
      console.error('[Telegram] answerCallbackQuery error:', error);
    }
  }

  async sendMessage(chatId: number, text: string): Promise<boolean> {
    try {
      this.messageQueue.push({ chatId, text });
      await this.processQueue();
      return true;
    } catch (error) {
      console.error('[Telegram] sendMessage error:', error);
      return false;
    }
  }

  private async processQueue(): Promise<void> {
    while (this.messageQueue.length > 0) {
      const now = Date.now();
      const timeSinceLast = now - this.lastSentTime;

      if (timeSinceLast < this.MESSAGE_RATE_LIMIT) {
        await this.sleep(this.MESSAGE_RATE_LIMIT - timeSinceLast);
      }

      const message = this.messageQueue.shift();
      if (message) {
        const success = await this.doSendMessage(message.chatId, message.text);
        if (success) {
          this.lastSentTime = Date.now();
        } else {
          // Re-add to queue on failure
          this.messageQueue.unshift(message);
          await this.sleep(5000); // Backoff on failure
        }
      }
    }
  }

  private async doSendMessage(chatId: number, text: string): Promise<boolean> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const data = (await response.json()) as TelegramResponse;

      if (!data.ok) {
        this.handleTelegramAPIError(data.description);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[Telegram] Send error:', error);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const telegramBot = new TelegramBot();