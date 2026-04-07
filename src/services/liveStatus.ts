import { telegramBot } from '../telegram/bot.js';
import { buildCommandKeyboard, buildApprovalPlusCommandKeyboard } from '../telegram/keyboards.js';

export type StatusPhase = 'idle' | 'active' | 'awaiting_approval';

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
}

type PendingTimeout = ReturnType<typeof setTimeout> | null;

interface ChatState {
  status: LiveStatusState;
  queueTimeout: PendingTimeout;
  lastSentTime: number;
  lastSentText: string;
  isFlushing: boolean;
  flushId: number;
  // Accumulated SSE streaming text (raw text deltas from the AI)
  sseText: string;
}

const chatStates: Map<number, ChatState> = new Map();

const MIN_EDIT_INTERVAL_MS = 1000;
const MAX_EVENTS = 10;
const MAX_TEXT_LENGTH = 200;
const MAX_PREVIEW_LENGTH = 300;
const MAX_SSE_DISPLAY_LENGTH = 3000; // Telegram message limit buffer

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
      lastSentTime: 0,
      lastSentText: '',
      isFlushing: false,
      flushId: 0,
      sseText: '',
    };
    chatStates.set(chatId, chatState);
  }
  return chatState;
}

function addEventToStatus(
  status: LiveStatusState,
  event: Omit<StatusEvent, 'timestamp'>
): void {
  const fullEvent: StatusEvent = { ...event, timestamp: Date.now() };

  status.events.push(fullEvent);

  if (status.events.length > MAX_EVENTS) {
    status.events.shift();
  }

  switch (event.type) {
    case 'thinking':
      status.phase = 'active';
      status.isActive = true;
      break;
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

  if (status.phase === 'idle') {
    lines.push('AI Proxy — Idle');
    lines.push('No active request');
    return lines.join('\n');
  }

  // Show SSE streaming content first
  if (sseText.length > 0) {
    let displaySse = sseText;
    if (displaySse.length > MAX_SSE_DISPLAY_LENGTH) {
      displaySse = '...' + displaySse.slice(-MAX_SSE_DISPLAY_LENGTH);
    }
    lines.push(displaySse);
    lines.push('');
  }

  // Status line
  const phaseLabel =
    status.phase === 'awaiting_approval'
      ? 'Awaiting Approval'
      : status.phase === 'active'
        ? 'Active'
        : 'Idle';
  lines.push(`[${phaseLabel}]`);

  // Pending approval info
  if (status.pendingApproval) {
    lines.push(`Tool: ${status.pendingApproval.toolName}`);
    if (status.pendingApproval.filePath) {
      lines.push(`File: ${status.pendingApproval.filePath}`);
    }
    if (status.pendingApproval.preview) {
      const preview = status.pendingApproval.preview.substring(0, MAX_PREVIEW_LENGTH);
      lines.push(`Preview: ${preview}`);
    }
  }

  // Recent events
  if (status.events.length > 0) {
    lines.push('---');
    for (const event of status.events) {
      let eventLine = '';
      switch (event.type) {
        case 'thinking':
          eventLine = 'Thinking...';
          break;
        case 'text':
          eventLine = `Text: ${(event.detail ?? '').substring(0, MAX_TEXT_LENGTH)}`;
          break;
        case 'tool_start':
          eventLine = `Started: ${event.tool ?? 'unknown'}`;
          if (event.path) eventLine += ` (${event.path})`;
          break;
        case 'tool_complete':
          eventLine = `Completed: ${event.tool ?? 'unknown'}`;
          break;
        case 'tool_error':
          eventLine = `Error: ${event.tool ?? 'unknown'}`;
          if (event.detail) eventLine += ` - ${event.detail}`;
          break;
        case 'approval_required':
          eventLine = `Approval needed: ${event.tool ?? 'unknown'}`;
          break;
        case 'approval_approved':
          eventLine = `Approved: ${event.tool ?? 'unknown'}`;
          break;
        case 'approval_rejected':
          eventLine = `Rejected: ${event.tool ?? 'unknown'}`;
          break;
        case 'approval_timeout':
          eventLine = `Timeout: ${event.tool ?? 'unknown'}`;
          break;
        case 'response_complete':
          eventLine = 'Response complete';
          break;
        case 'response_error':
          eventLine = `Error: ${event.detail ?? 'unknown'}`;
          break;
        default:
          eventLine = event.type;
      }
      lines.push(eventLine);
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

    if (text === chatState.lastSentText) {
      return;
    }

    // Choose keyboard based on state
    let keyboard;
    if (status.phase === 'awaiting_approval' && status.pendingApproval) {
      keyboard = buildApprovalPlusCommandKeyboard(status.pendingApproval.requestId);
    } else {
      keyboard = buildCommandKeyboard();
    }

    if (status.messageId === null) {
      // Send initial message and pin it
      const sent = await telegramBot.sendMessageWithId(status.chatId, text, keyboard);
      if (sent && sent.message_id) {
        status.messageId = sent.message_id;
        await telegramBot.pinChatMessage(status.chatId, sent.message_id);
      }
    } else {
      // Edit existing pinned message with command keyboard
      await telegramBot.editMessage(status.chatId, status.messageId, text, keyboard);
    }

    chatState.lastSentTime = Date.now();
    chatState.lastSentText = text;
  } catch (error) {
    console.error('[LiveStatus] Flush error:', error);
  } finally {
    chatState.isFlushing = false;
  }
}

function scheduleStatusUpdate(chatId: number): void {
  const chatState = chatStates.get(chatId);
  if (!chatState || !chatState.status.isActive) {
    return;
  }

  if (chatState.queueTimeout !== null) {
    return;
  }

  const timeSinceLast = Date.now() - chatState.lastSentTime;
  const delay = Math.max(0, MIN_EDIT_INTERVAL_MS - timeSinceLast);
  const currentFlushId = chatState.flushId;

  chatState.queueTimeout = setTimeout(async () => {
    chatState.queueTimeout = null;

    if (chatState.flushId !== currentFlushId) {
      console.log(`[LiveStatus] Stale timeout ignored (flushId=${currentFlushId} != ${chatState.flushId})`);
      return;
    }

    if (!chatState.status.isActive) {
      console.log(`[LiveStatus] Timeout fired but status not active`);
      return;
    }

    await flushStatusUpdate(chatState);

    if (chatState.status.events.length > 0 && chatState.status.isActive) {
      scheduleStatusUpdate(chatId);
    }
  }, delay);
}

export function startStatus(chatId: number): void {
  const chatState = getOrCreateChatState(chatId);

  if (chatState.queueTimeout !== null) {
    clearTimeout(chatState.queueTimeout);
    chatState.queueTimeout = null;
  }

  chatState.flushId++;
  chatState.status.isActive = true;
  chatState.status.phase = 'active';
  chatState.status.messageId = null;
  chatState.status.events = [];
  chatState.lastSentText = '';
  chatState.sseText = '';

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
  if (!chatState) return;
  chatState.sseText += text;
  scheduleStatusUpdate(chatId);
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

export function completeStatus(chatId: number, success: boolean): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  addEventToStatus(chatState.status, {
    type: success ? 'response_complete' : 'response_error',
  });

  chatState.status.phase = 'idle';
  chatState.status.isActive = false;
  chatState.status.messageId = null; // Reset so next startStatus sends fresh pinned message
  chatState.lastSentText = '';

  // Force immediate flush to show final status
  flushStatusUpdate(chatState);
}

export function clearStatus(chatId: number): void {
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  if (chatState.queueTimeout !== null) {
    clearTimeout(chatState.queueTimeout);
  }

  chatStates.delete(chatId);
}

export function getStatusState(chatId: number): LiveStatusState | null {
  return chatStates.get(chatId)?.status ?? null;
}

export function getPendingApproval(chatId: number): LiveStatusState['pendingApproval'] {
  return chatStates.get(chatId)?.status.pendingApproval ?? null;
}
