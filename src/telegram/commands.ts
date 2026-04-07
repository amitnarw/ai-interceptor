import { telegramBot } from './bot.js';
import { modeManager } from '../config/mode.js';
import { config } from '../config/index.js';
import { approvalService } from '../services/approvalService.js';
import { buildCommandKeyboard } from './keyboards.js';

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
  const modeIndicator = mode === 'away' ? '[AWAY]' : '[DESK]';
  const modeText = mode === 'away' ? 'AWAY (approvals required)' : 'DESK (transparent passthrough)';

  let message = `${modeIndicator} Mode: ${modeText}\n`;
  message += `Proxy: Active\n`;
  message += `Timeout: ${config.autoRejectTimeoutMs / 1000 / 60} minutes\n\n`;

  if (recentToolCalls.length > 0) {
    message += `Recent Tool Calls:\n`;
    for (const call of recentToolCalls) {
      const time = new Date(call.timestamp).toLocaleTimeString();
      const file = call.file ? ` (${call.file})` : '';
      message += `- ${call.tool}${file} - ${time}\n`;
    }
  } else {
    message += `Recent Tool Calls: None`;
  }

  return message;
}

async function editPinnedMessage(chatId: number, text: string): Promise<void> {
  const pinnedId = telegramBot.getPinnedMessageId(chatId);
  if (pinnedId !== undefined) {
    await telegramBot.editMessage(chatId, pinnedId, text, buildCommandKeyboard());
  } else {
    // No pinned message yet — send and pin one
    const sent = await telegramBot.sendMessageWithId(chatId, text, buildCommandKeyboard());
    if (sent?.message_id) {
      await telegramBot.pinChatMessage(chatId, sent.message_id);
    }
  }
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
      await editPinnedMessage(
        chatId,
        `Switched to AWAY mode.\nTool calls will require approval via Telegram.`
      );
      break;

    case '/desk':
      modeManager.setMode('desk');
      await editPinnedMessage(
        chatId,
        `Switched to DESK mode.\nAll requests will pass through transparently.`
      );
      break;

    case '/status':
      await editPinnedMessage(chatId, getStatusMessage());
      break;

    case '/clear':
      clearToolCalls();
      await editPinnedMessage(chatId, 'Cleared recent tool call history.');
      break;

    case '/callback':
      await handleCallback(parts, chatId);
      break;

    default:
      if (!command?.startsWith('/')) {
        // No response for unknown text — chat input is ignored
        return;
      }
      break;
  }
}

async function sendStartMessage(chatId: number): Promise<void> {
  const message = `
*Proxy Telegram Agent*

This bot controls your local AI proxy.

Use the command buttons below to control the proxy.
Proxy runs on port ${config.proxyPort}
`;
  await editPinnedMessage(chatId, message);
}

async function handleCallback(parts: string[], chatId: number): Promise<void> {
  if (parts.length < 2) {
    return;
  }

  const callbackData = parts[1];
  const callbackParts = callbackData.split(':');

  if (callbackParts.length < 2) {
    return;
  }

  const action = callbackParts[0];
  const requestId = callbackParts.slice(1).join(':');

  switch (action) {
    // Inline keyboard command buttons
    case 'cmd':
      await handleCommand(`/${requestId}`, chatId, 0);
      break;

    // Approval action buttons
    case 'approve':
      await approvalService.handleApproval(requestId, 'approve');
      break;

    case 'reject':
      await approvalService.handleApproval(requestId, 'reject');
      break;

    case 'custom':
      await approvalService.handleApproval(requestId, 'custom');
      break;
  }
}
