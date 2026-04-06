import { telegramBot } from './bot.js';
import { modeManager } from '../config/mode.js';
import { config } from '../config/index.js';

const LAST_TOOL_CALLS_MAX = 5;

interface ToolCallInfo {
  tool: string;
  file?: string;
  timestamp: number;
}

const recentToolCalls: ToolCallInfo[] = [];

export function addToolCall(tool: string, file?: string): void {
  recentToolCalls.unshift({ tool, file, timestamp: Date.now() });
  if (recentToolCalls.length > LAST_TOOL_CALLS_MAX) {
    recentToolCalls.pop();
  }
}

export function clearToolCalls(): void {
  recentToolCalls.length = 0;
}

function getStatusMessage(): string {
  const mode = modeManager.getMode();
  const modeEmoji = mode === 'away' ? '🔴' : '🟢';
  const modeText = mode === 'away' ? 'AWAY (approvals required)' : 'DESK (transparent passthrough)';

  let message = `${modeEmoji} *Mode:* ${modeText}\n`;
  message += `🤖 *Proxy:* Active\n`;
  message += `⏱️ *Timeout:* ${config.autoRejectTimeoutMs / 1000 / 60} minutes\n\n`;

  if (recentToolCalls.length > 0) {
    message += `📋 *Recent Tool Calls:*\n`;
    for (const call of recentToolCalls) {
      const time = new Date(call.timestamp).toLocaleTimeString();
      const file = call.file ? ` (${call.file})` : '';
      message += `• ${call.tool}${file} - ${time}\n`;
    }
  } else {
    message += `📋 *Recent Tool Calls:* None`;
  }

  return message;
}

export async function handleCommand(
  input: string,
  chatId: number,
  _messageId: number
): Promise<void> {
  const parts = input.split(' ');
  const command = parts[0]?.toLowerCase();

  switch (command) {
    case '/start':
      await sendStartMessage(chatId);
      break;

    case '/away':
      modeManager.setMode('away');
      await telegramBot.sendMessage(
        chatId,
        `🔴 Switched to *AWAY* mode.\nTool calls will require approval via Telegram.`
      );
      break;

    case '/desk':
      modeManager.setMode('desk');
      await telegramBot.sendMessage(
        chatId,
        `🟢 Switched to *DESK* mode.\nAll requests will pass through transparently.`
      );
      break;

    case '/status':
      await telegramBot.sendMessage(chatId, getStatusMessage());
      break;

    case '/clear':
      clearToolCalls();
      await telegramBot.sendMessage(chatId, '🗑️ Cleared recent tool call history.');
      break;

    default:
      if (!command?.startsWith('/')) {
        await telegramBot.sendMessage(
          chatId,
          `I don't understand that command. Try /status, /away, or /desk.`
        );
      }
      break;
  }
}

async function sendStartMessage(chatId: number): Promise<void> {
  const message = `
🤖 *Proxy Telegram Agent*

This bot controls your local AI proxy.

*Commands:*
• /away - Enable approval mode
• /desk - Disable approval mode  
• /status - Current status
• /clear - Clear tool history

_Proxy runs on port ${config.proxyPort}_
`;

  await telegramBot.sendMessage(chatId, message);
}
