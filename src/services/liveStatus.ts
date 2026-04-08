import { telegramBot } from '../telegram/bot.js';
import { buildCommandKeyboard, buildApprovalPlusCommandKeyboard, ApprovalKeyboard } from '../telegram/keyboards.js';
import { modeManager } from '../config/mode.js';

// Convert standard Markdown to Telegram Markdown format
// Telegram uses *text* for bold, not **text**
function toTelegramMarkdown(text: string): string {
  // First unescape any escaped characters from MiniMax
  let result = text
    .replace(/\\([*_`\[\]()~>#+\-=|{}.!])/g, '$1'); // undo escape

  // Convert **text** to *text* (standard bold to Telegram bold)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Escape only square brackets that could break code blocks
  result = result.replace(/\[([^\]]+)\]/g, '\\[$1\\]');
  return result;
}

// Escape function to prevent Markdown parsing errors in Telegram
// Only escape chars that Telegram's Markdown parser interprets as special formatting
// We specifically escape only brackets which break code blocks
export function escapeMarkdown(text: string): string {
  return toTelegramMarkdown(text);
}

export type StatusPhase = 'idle' | 'thinking' | 'active' | 'awaiting_approval';

export type EventType =
  | 'thinking'
  | 'text'
  | 'tool_start'
  | 'tool_complete'
  | 'tool_error'
  | 'approval_required'
  | 'approval_approved'
  | 'approval_rejected'
  | 'approval_timeout'
  | 'response_complete'
  | 'response_error';

export interface StatusEvent {
  type: EventType;
  tool?: string;
  path?: string;
  detail?: string;
  timestamp: number;
}

export interface LiveStatusState {
  messageId: number | null;
  chatId: number;
  phase: StatusPhase;
  events: StatusEvent[];
  pendingApproval: {
    requestId: string;
    toolName: string;
    filePath?: string;
    preview?: string;
  } | null;
  isActive: boolean;
  tokens?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

type PendingTimeout = ReturnType<typeof setTimeout> | null;

interface ChatState {
  status: LiveStatusState;
  queueTimeout: PendingTimeout;
  gracePeriodTimeout: PendingTimeout;
  lastSentTime: number;
  lastSentText: string;
  isFlushing: boolean;
  flushId: number;
  sseText: string;
  lastAppendedText: string; // Track last appended text to detect duplicates
  flushErrorCount: number;
  streamingActive: boolean; // Guard against concurrent streams
  pendingStreamHasData: boolean; // Tracks if a new timeout was scheduled after early return
}

const chatStates: Map<number, ChatState> = new Map();

const MIN_EDIT_INTERVAL_MS = 1000;
const MAX_EVENTS = 10;
const MAX_PREVIEW_LENGTH = 300;
const MAX_SSE_DISPLAY_LENGTH = 3000;
const MAX_SSE_TEXT_LENGTH = 500; // Memory-safe truncation for sseText

function getOrCreateChatState(chatId: number): ChatState {
  let chatState = chatStates.get(chatId);
  if (!chatState) {
    chatState = {
      status: {
        messageId: null,
        chatId,
        phase: 'idle',
        events: [],
        pendingApproval: null,
        isActive: false,
      },
      queueTimeout: null,
      gracePeriodTimeout: null,
      lastSentTime: 0,
      lastSentText: '',
      isFlushing: false,
      flushId: 0,
      sseText: '',
      lastAppendedText: '',
      flushErrorCount: 0,
      streamingActive: false,
      pendingStreamHasData: false,
    };
    chatStates.set(chatId, chatState);
  }
  return chatState;
}

function cancelGracePeriod(chatState: ChatState): void {
  if (chatState.gracePeriodTimeout !== null) {
    clearTimeout(chatState.gracePeriodTimeout);
    chatState.gracePeriodTimeout = null;
  }
}

function addEventToStatus(
  status: LiveStatusState,
  event: Omit<StatusEvent, 'timestamp'>
): void {
  // Handle thinking events - don't add to events array, phase label shows it
  if (event.type === 'thinking') {
    status.phase = 'thinking';
    status.isActive = true;
    return;
  }

  // Don't add text events to events array - SSE text is displayed separately
  if (event.type === 'text') {
    return;
  }

  const fullEvent: StatusEvent = { ...event, timestamp: Date.now() };
  status.events.push(fullEvent);

  if (status.events.length > MAX_EVENTS) {
    status.events.shift();
  }

  switch (event.type) {
    case 'approval_required':
      status.phase = 'awaiting_approval';
      break;
    case 'approval_approved':
    case 'approval_rejected':
    case 'approval_timeout':
      status.phase = 'active';
      status.pendingApproval = null;
      break;
    case 'response_complete':
    case 'response_error':
      status.isActive = false;
      break;
  }
}

function buildStatusText(status: LiveStatusState, sseText: string): string {
  const lines: string[] = [];

  // Mode section - always show
  const currentMode = modeManager.getMode();
  const modeEmoji = currentMode === 'away' ? '🔒' : '🔓';
  const modeLabel = currentMode === 'away' ? 'Approval Mode' : 'Passthrough Mode';
  lines.push(`*Mode* ${modeEmoji} ${modeLabel}`);

  // Spacer
  lines.push('');

  // Status section with emoji indicator
  const phaseEmoji =
    status.phase === 'idle'
      ? '🟡'
      : status.phase === 'thinking'
        ? '🟡'
        : status.phase === 'active'
          ? '🟢'
          : status.phase === 'awaiting_approval'
            ? '🟠'
            : '🔴';
  const phaseLabel =
    status.phase === 'idle'
      ? 'Idle'
      : status.phase === 'thinking'
        ? 'Thinking...'
        : status.phase === 'active'
          ? 'Active'
          : status.phase === 'awaiting_approval'
            ? 'Awaiting Approval'
            : 'Disconnected';
  lines.push(`*Status* ${phaseEmoji} ${phaseLabel}`);

  // Spacer
  lines.push('');

  // Response section - only show when NOT thinking
  if (status.phase !== 'thinking') {
    if (status.phase === 'idle') {
      lines.push('*AI Response*: No active request');
    } else if (sseText.length > 0) {
      let displaySse = sseText;
      if (displaySse.length > MAX_SSE_DISPLAY_LENGTH) {
        displaySse = '...' + displaySse.slice(-MAX_SSE_DISPLAY_LENGTH);
      }
      // Put label and text on same line - no extra newline
      lines.push(`*AI Response*: ${escapeMarkdown(displaySse)}`);
    } else {
      lines.push('*AI Response*: ...');
    }

    // Usage (tokens in code block) - only show when idle/active and has tokens
    if (status.tokens) {
      lines.push('');
      const input = status.tokens.input_tokens ?? 0;
      const output = status.tokens.output_tokens ?? 0;
      const total = status.tokens.total_tokens ?? (input + output);
      lines.push('*API Usage*:\n```');
      lines.push(`Total: ${total}`);
      lines.push(`Input: ${input}`);
      lines.push(`Output: ${output}`);
      lines.push('```');
    }
  }

  // Thinking indicator (no key, just animated value)
  if (status.phase === 'thinking') {
    lines.push('*Thinking* ⌛');
  }

  // Pending approval info (only when awaiting approval)
  if (status.pendingApproval) {
    lines.push('*Approval Required*');
    lines.push(`Tool: ${escapeMarkdown(status.pendingApproval.toolName)}`);
    if (status.pendingApproval.filePath) {
      lines.push(`File: ${escapeMarkdown(status.pendingApproval.filePath)}`);
    }
    if (status.pendingApproval.preview) {
      // Unescape JSON and format nicely for display
      let preview = status.pendingApproval.preview
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .substring(0, MAX_PREVIEW_LENGTH);

      // Try to parse and re-format as nice JSON
      try {
        const parsed = JSON.parse(preview);
        preview = JSON.stringify(parsed, null, 2);
      } catch {
        // Not JSON - just use unescaped text
      }

      lines.push(`Preview:\n\`\`\`\n${preview}\n\`\`\``);
    }
  }

  return lines.join('\n');
}

async function flushStatusUpdate(chatState: ChatState): Promise<void> {
  if (chatState.isFlushing) {
    return;
  }
  chatState.isFlushing = true;
  const { status } = chatState;

  try {
    const text = buildStatusText(status, chatState.sseText);

    console.log(`[LiveStatus] flushStatusUpdate: messageId=${status.messageId}, phase=${status.phase}, sseTextLen=${chatState.sseText.length}, textPreview="${text.substring(0, 50)}..."`);

    if (text === chatState.lastSentText) {
      console.log(`[LiveStatus] flushStatusUpdate: skipping, same text`);
      return;
    }

    let keyboard;
    if (status.phase === 'awaiting_approval' && status.pendingApproval) {
      keyboard = buildApprovalPlusCommandKeyboard(status.pendingApproval.requestId);
    } else {
      keyboard = buildCommandKeyboard();
    }

    if (status.messageId === null) {
      const sent = await telegramBot.sendMessageWithId(status.chatId, text, keyboard);
      if (sent && sent.message_id) {
        status.messageId = sent.message_id;
      }
    } else {
      const editSuccess = await telegramBot.editMessage(status.chatId, status.messageId, text, keyboard);
      if (!editSuccess) {
        console.log('[LiveStatus] Message edit failed (deleted?), resetting messageId');
        status.messageId = null;
      }
    }

    chatState.lastSentTime = Date.now();
    chatState.lastSentText = text;
  } catch (error) {
    chatState.flushErrorCount++;
    console.error(`[LiveStatus] Flush error (${chatState.flushErrorCount}):`, error);
  } finally {
    chatState.isFlushing = false;
  }
}

function scheduleStatusUpdate(chatId: number): void {
  const chatState = chatStates.get(chatId);
  if (!chatState || !chatState.status.isActive) {
    return;
  }

  // If there's already a pending flush or a flush is in progress, don't schedule another
  // The existing flush will pick up any new state
  if (chatState.queueTimeout !== null || chatState.isFlushing) {
    return;
  }

  const timeSinceLast = Date.now() - chatState.lastSentTime;
  const delay = Math.max(0, MIN_EDIT_INTERVAL_MS - timeSinceLast);

  chatState.queueTimeout = setTimeout(async () => {
    chatState.queueTimeout = null;

    if (!chatState.status.isActive) {
      console.log(`[LiveStatus] Timeout fired but status not active`);
      return;
    }

    await flushStatusUpdate(chatState);

    // Only schedule another update if:
    // 1. Status is still active
    // 2. NOT awaiting approval (button click will trigger update)
    // 3. There is actually pending SSE text to send (not just same text)
    // Don't loop if nothing changed - just wait for new events
    if (chatState.status.isActive &&
        chatState.status.phase !== 'awaiting_approval' &&
        chatState.sseText.length > 0 &&
        chatState.sseText !== chatState.lastSentText) {
      scheduleStatusUpdate(chatId);
    }
  }, delay);
}

export function startStatus(chatId: number, existingMessageId?: number | null): void {
  const chatState = getOrCreateChatState(chatId);

  if (chatState.queueTimeout !== null) {
    clearTimeout(chatState.queueTimeout);
    chatState.queueTimeout = null;
  }

  // Cancel any existing grace period
  cancelGracePeriod(chatState);

  // Guard: if streaming is already active, don't start a new one
  // This prevents concurrent streams from corrupting state
  if (chatState.streamingActive) {
    console.log(`[LiveStatus] Stream already active for chat ${chatId}, skipping new startStatus`);
    // Increment flushId and clear queueTimeout so any pending timeout (old or new) returns early
    // Set phase='thinking' so that when appendSseText is called, it transitions to 'active'
    // and the SSE text is properly accumulated for the next timeout to send
    if (chatState.queueTimeout !== null) {
      clearTimeout(chatState.queueTimeout);
      chatState.queueTimeout = null;
    }
    chatState.flushId++;
    chatState.status.isActive = true;  // Set to true so scheduleStatusUpdate works
    chatState.status.phase = 'thinking';  // Set to thinking so appendSseText transitions to active
    chatState.pendingStreamHasData = false; // No new timeout scheduled yet - appendSseText will set it
    return;
  }

  chatState.flushId++;
  chatState.status.isActive = true;
  chatState.status.phase = 'idle'; // Start as idle, 'thinking' event will set to 'thinking'
  // Preserve existing messageId unless explicitly told to change
  if (existingMessageId === null) {
    // Explicit null means "create a new message"
    chatState.status.messageId = null;
  } else if (existingMessageId !== undefined) {
    // Use the provided messageId
    chatState.status.messageId = existingMessageId;
  }
  // If existingMessageId is undefined, keep existing status.messageId (PRESERVE it)
  chatState.status.events = [];
  chatState.lastSentText = '';
  // Reset SSE text and deduplication state BEFORE adding thinking event
  chatState.sseText = '';
  chatState.lastAppendedText = '';
  // Mark streaming as active
  chatState.streamingActive = true;
  chatState.pendingStreamHasData = false;

  addEventToStatus(chatState.status, { type: 'thinking' });
  scheduleStatusUpdate(chatId);
}

export function addStatusEvent(
  chatId: number,
  event: Omit<StatusEvent, 'timestamp'>
): void {
  const chatState = getOrCreateChatState(chatId);
  addEventToStatus(chatState.status, event);
  scheduleStatusUpdate(chatId);
}

export function appendSseText(chatId: number, text: string): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) {
    console.log(`[LiveStatus] appendSseText: no chatState for chatId ${chatId}`);
    return;
  }

  console.log(`[LiveStatus] appendSseText: phase=${chatState.status.phase}, text="${text.substring(0, 30)}..."`);

  // Transition from thinking to active when response text starts arriving
  // Clear thinking content and add the response text
  if (chatState.status.phase === 'thinking') {
    cancelGracePeriod(chatState);
    chatState.status.phase = 'active';
    chatState.sseText = '';
  }

  // Accumulate response text in sseText
  chatState.sseText += text;

  // Proactively truncate if sseText grows too large (memory safety)
  if (chatState.sseText.length > MAX_SSE_TEXT_LENGTH * 2) {
    chatState.sseText = chatState.sseText.slice(-MAX_SSE_TEXT_LENGTH);
  }

  // Track if a new timeout is being scheduled (for handling early return from startStatus)
  const hadTimeout = chatState.queueTimeout !== null;
  scheduleStatusUpdate(chatId);
  // If we didn't have a timeout before but do now, a new one was scheduled after early return
  if (!hadTimeout && chatState.queueTimeout !== null) {
    chatState.pendingStreamHasData = true;
  }
}

export function setApprovalRequired(
  chatId: number,
  requestId: string,
  toolName: string,
  filePath?: string,
  preview?: string
): void {
  const chatState = getOrCreateChatState(chatId);

  chatState.status.phase = 'awaiting_approval';
  chatState.status.pendingApproval = { requestId, toolName, filePath, preview };

  addEventToStatus(chatState.status, {
    type: 'approval_required',
    tool: toolName,
    path: filePath,
    detail: preview,
  });

  scheduleStatusUpdate(chatId);
}

export function setApprovalResult(
  chatId: number,
  result: 'approved' | 'rejected' | 'timeout',
  toolName?: string
): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  const eventType: EventType =
    result === 'approved'
      ? 'approval_approved'
      : result === 'rejected'
        ? 'approval_rejected'
        : 'approval_timeout';

  addEventToStatus(chatState.status, { type: eventType, tool: toolName });
  scheduleStatusUpdate(chatId);
}

export function completeStatus(chatId: number, success: boolean, message?: string): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  const eventType = success ? 'response_complete' : 'response_error';
  addEventToStatus(chatState.status, {
    type: eventType,
    ...(message ? { detail: message } : {}),
  });

  // Cancel grace period if running
  cancelGracePeriod(chatState);

  chatState.status.phase = 'idle';
  chatState.status.isActive = false;
  // Keep messageId - we want to keep editing the same message
  chatState.lastSentText = '';
  chatState.flushErrorCount = 0;
  chatState.streamingActive = false;

  // If a new timeout was scheduled after early return from startStatus,
  // don't send the idle message now - let the pending timeout send the SSE text
  if (chatState.pendingStreamHasData) {
    console.log(`[LiveStatus] completeStatus: pending timeout has SSE data, skipping flush`);
    chatState.pendingStreamHasData = false;
    // But preserve sseText so the pending timeout can send it
    return;
  }

  // CRITICAL: Flush accumulated SSE text BEFORE clearing sseText
  // The scheduled flush may not fire in time if completeStatus is called synchronously
  // after the last SSE chunk (within the throttle delay window)
  if (chatState.sseText.length > 0) {
    console.log(`[LiveStatus] completeStatus: flushing ${chatState.sseText.length} chars before clear`);
    // Temporarily set phase to 'active' so flush sends the text (not idle placeholder)
    chatState.status.phase = 'active';
    flushStatusUpdate(chatState);
    chatState.status.phase = 'idle';
    chatState.sseText = '';
    chatState.lastAppendedText = '';
    return;
  }

  chatState.sseText = '';
  chatState.lastAppendedText = '';
  flushStatusUpdate(chatState);
}

export function setTokens(
  chatId: number,
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number }
): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  chatState.status.tokens = tokens;
  scheduleStatusUpdate(chatId);
}

export function clearStatus(chatId: number): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  if (chatState.queueTimeout !== null) {
    clearTimeout(chatState.queueTimeout);
  }

  // Reset the chatState for the next use, but don't delete it
  // This preserves the messageId so the next message edits the same message
  chatState.status.isActive = false;
  chatState.status.phase = 'idle';
  chatState.status.events = [];
  chatState.status.pendingApproval = null;
  chatState.status.tokens = undefined;
  chatState.sseText = '';
  chatState.lastAppendedText = '';
  chatState.flushErrorCount = 0;
  chatState.streamingActive = false;
  chatState.pendingStreamHasData = false;
  chatState.lastSentText = '';
}

export function getStatusState(chatId: number): LiveStatusState | null {
  return chatStates.get(chatId)?.status ?? null;
}

export function getPendingApproval(chatId: number): LiveStatusState['pendingApproval'] {
  return chatStates.get(chatId)?.status.pendingApproval ?? null;
}

/**
 * Send or edit a message for a chat. Used by commands.ts to send messages
 * without going through the streaming/approval flow.
 * This ensures liveStatus always knows about the message ID.
 */
export async function sendStatusMessage(
  chatId: number,
  text: string,
  keyboard?: ApprovalKeyboard
): Promise<void> {
  const chatState = getOrCreateChatState(chatId);

  if (chatState.status.messageId === null) {
    // No existing message - create one
    const sent = await telegramBot.sendMessageWithId(chatId, text, keyboard);
    if (sent && sent.message_id) {
      chatState.status.messageId = sent.message_id;
      chatState.lastSentTime = Date.now();
      chatState.lastSentText = text;
    }
  } else {
    // Edit existing message
    const editSuccess = await telegramBot.editMessage(chatId, chatState.status.messageId, text, keyboard);
    if (!editSuccess) {
      console.log('[LiveStatus] sendStatusMessage edit failed (deleted?), resetting messageId');
      chatState.status.messageId = null;
      // Try to create a new message
      const sent = await telegramBot.sendMessageWithId(chatId, text, keyboard);
      if (sent && sent.message_id) {
        chatState.status.messageId = sent.message_id;
      }
    }
    chatState.lastSentTime = Date.now();
    chatState.lastSentText = text;
  }
}