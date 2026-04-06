import { config } from '../config/index.js';
import { handleCommand } from './commands.js';

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
      } catch (error) {
        console.error('[Telegram] Poll error:', error);
        await this.sleep(5000);
      }
    }
  }

  private async fetchUpdates(): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=1`;

    const response = await fetch(url);
    const data = (await response.json()) as TelegramResponse;

    if (!data.ok) {
      console.error('[Telegram] API error:', data.description);
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

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      const { chat, text, message_id } = update.message;
      if (text) {
        console.log(`[Telegram] Message from ${chat.id}: ${text}`);
        await handleCommand(text, chat.id, message_id);
      }
    }

    if (update.callback_query) {
      const { id, data, message } = update.callback_query;
      if (data && message) {
        console.log(`[Telegram] Callback query: ${data}`);
        await this.answerCallback(id);
        await handleCommand(`/callback ${data}`, message.chat.id, message.message_id);
      }
    }
  }

  private async answerCallback(queryId: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery?callback_query_id=${queryId}`;
    await fetch(url);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messageQueue.push({ chatId, text });
    this.processQueue();
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
        await this.doSendMessage(message.chatId, message.text);
        this.lastSentTime = Date.now();
      }
    }
  }

  private async doSendMessage(chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = (await response.json()) as TelegramResponse;

    if (!data.ok) {
      console.error('[Telegram] Send error:', data.description);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const telegramBot = new TelegramBot();
