import { telegramBot } from './bot.js';
import { modeManager } from '../config/mode.js';
import { config } from '../config/index.js';
import { approvalService } from '../services/approvalService.js';
import { buildCommandKeyboard } from './keyboards.js';
import { clearStatus } from '../services/liveStatus.js';

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
    console.log(`[Commands] Editing pinned message ${pinnedId}`);
    await telegramBot.editMessage(chatId, pinnedId, text, buildCommandKeyboard());
  } else {
    // No pinned message yet — send and pin one
    console.log(`[Commands] No pinned message, sending new message`);
    const sent = await telegramBot.sendMessageWithId(chatId, text, buildCommandKeyboard());
    console.log(`[Commands] sendMessageWithId returned:`, sent);
    if (sent?.message_id) {
      console.log(`[Commands] Pinning message ${sent.message_id}`);
      await telegramBot.pinChatMessage(chatId, sent.message_id);
    } else {
      console.warn(`[Commands] sendMessageWithId returned null, message not sent`);
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
      clearStatus(chatId);
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
  const mode = modeManager.getMode();
  const modeLabel = mode === 'away' ? 'AWAY' : 'DESK';
  const modeDesc = mode === 'away'
    ? 'Approvals required for tool calls'
    : 'Transparent passthrough mode';

  const message = `*AI Proxy Telegram Agent*
━━━━━━━━━━━━━━━━━━━━━━

Welcome! This bot lets you monitor and approve AI tool calls in real-time.

*Current Mode:* \`${modeLabel}\`
*Status:* ${modeDesc}
*Proxy Port:* \`${config.proxyPort}\`

━━━━━━━━━━━━━━━━━━━━━━

Use the buttons below to control the proxy. All interactions happen via the inline keyboard — no text commands needed.`;

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
