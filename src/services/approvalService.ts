import { addApprovalJob, getApprovalJob, updateApprovalStatus, ApprovalJobData } from '../approvals/queue.js';
import { classifyTool } from '../filters/toolFilter.js';
import { modeManager } from '../config/mode.js';
import { config } from '../config/index.js';
import { telegramBot } from '../telegram/bot.js';
import {
  startStatus,
  setApprovalRequired,
  setApprovalResult,
} from './liveStatus.js';
import axios from 'axios';

const CUSTOM_INPUT_TIMEOUT_MS = 60000; // 60 seconds

export interface ApprovalRequest {
  id: string;
  resolve: (result: { approved: boolean; customContext?: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime: number;
  toolName: string;
  resolved?: boolean; // Flag to prevent double resolution race condition
  reminderTimers?: ReturnType<typeof setTimeout>[];
}

export interface CustomInputRequest {
  id: string;
  toolName: string;
  chatId: number;
  resolve: (customContext: string | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class ApprovalService {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private pendingCustomInputs: Map<string, CustomInputRequest> = new Map();
  private pollIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  /**
   * Check if a request needs approval based on mode and tool calls
   */
  needsApproval(toolCalls: { name: string }[]): boolean {
    // Only AWAY mode requires approval
    if (!modeManager.isAwayMode()) {
      return false;
    }

    // Check if any tool is an INTERCEPT tool
    for (const tool of toolCalls) {
      if (classifyTool(tool.name) === 'intercept') {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract tool calls from OpenAI format response
   */
  extractOpenAIToolCalls(responseData: unknown): { name: string; arguments: string }[] {
    const toolCalls: { name: string; arguments: string }[] = [];
    const data = responseData as Record<string, unknown>;

    if (!data.choices || !Array.isArray(data.choices)) {
      return toolCalls;
    }

    for (const choice of data.choices) {
      const choiceObj = choice as Record<string, unknown>;
      const message = choiceObj.message as Record<string, unknown> | undefined;

      if (!message || typeof message !== 'object') continue;

      const calls = message.tool_calls;
      if (!Array.isArray(calls)) continue;

      for (const call of calls) {
        const callObj = call as Record<string, unknown>;
        const func = callObj.function as Record<string, unknown> | undefined;

        if (func && typeof func.name === 'string') {
          toolCalls.push({
            name: func.name,
            arguments: typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments || {}),
          });
        }
      }
    }

    return toolCalls;
  }

  /**
   * Extract tool calls from Anthropic format response
   */
  extractAnthropicToolCalls(responseData: unknown): { name: string; arguments: string }[] {
    const toolCalls: { name: string; arguments: string }[] = [];
    const data = responseData as Record<string, unknown>;

    if (!data.content || !Array.isArray(data.content)) {
      return toolCalls;
    }

    for (const content of data.content) {
      if (!content || typeof content !== 'object') continue;

      const c = content as Record<string, unknown>;
      if (c.type !== 'tool_use') continue;

      const toolUse = c as { type: string; id?: string; name?: string; input?: Record<string, unknown> };

      if (typeof toolUse.name !== 'string') continue;

      toolCalls.push({
        name: toolUse.name,
        arguments: toolUse.input ? JSON.stringify(toolUse.input) : '{}',
      });
    }

    return toolCalls;
  }

  /**
   * Make a non-streaming "peek" request to detect tool calls
   */
  async peekForToolCalls(
    apiUrl: string,
    apiKey: string,
    requestBody: Record<string, unknown>,
    format: 'openai' | 'anthropic'
  ): Promise<{ hasToolCalls: boolean; toolCalls: { name: string; arguments: string }[] }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (format === 'openai') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    // Make non-streaming request
    const response = await axios({
      method: 'POST',
      url: apiUrl,
      headers,
      data: { ...requestBody, stream: false },
      timeout: 60000,
    });

    const toolCalls = format === 'openai'
      ? this.extractOpenAIToolCalls(response.data)
      : this.extractAnthropicToolCalls(response.data);

    return {
      hasToolCalls: toolCalls.length > 0,
      toolCalls,
    };
  }

  /**
   * Request approval for a tool call
   */
  async requestApproval(
    requestId: string,
    toolName: string,
    filePath: string | undefined,
    preview: string,
    chatId: number
  ): Promise<{ approved: boolean; customContext?: string }> {
    return new Promise(async (resolve) => {
      // Add job to queue
      const jobData: ApprovalJobData = {
        id: requestId,
        toolName,
        filePath,
        preview,
        timestamp: Date.now(),
        chatId,
        status: 'pending',
      };

      await addApprovalJob(jobData);

      // Set up timeout - use configured timeout
      const timeoutMs = config.autoRejectTimeoutMs;
      const timeout = setTimeout(() => {
        this.handleApprovalTimeout(requestId);
      }, timeoutMs);

      // Store pending approval
      this.pendingApprovals.set(requestId, {
        id: requestId,
        resolve,
        timeout,
        startTime: Date.now(),
        toolName,
      });

      // Start status tracking and set approval required
      startStatus(chatId);
      setApprovalRequired(chatId, requestId, toolName, filePath, preview);

      // Schedule Telegram reminders at 30s and 60s if timeout is > 60s
      if (timeoutMs > 60000) {
        const reminder1 = setTimeout(() => {
          const pending = this.pendingApprovals.get(requestId);
          if (pending && !pending.resolved) {
            telegramBot.sendMessage(chatId,
              `⏰ Reminder: Approval pending for "${toolName}"\nAuto-reject in 60s.`
            );
          }
        }, 30000);

        const reminder2 = setTimeout(() => {
          const pending = this.pendingApprovals.get(requestId);
          if (pending && !pending.resolved) {
            telegramBot.sendMessage(chatId,
              `⚠️ Final warning: Approval for "${toolName}" timed out in 30s.`
            );
          }
        }, 60000);

        const pending = this.pendingApprovals.get(requestId);
        if (pending) {
          pending.reminderTimers = [reminder1, reminder2];
        }
      }

      // Start polling for job status changes
      this.startPolling(requestId);
    });
  }

  /**
   * Handle approval from Telegram callback
   */
  async handleApproval(requestId: string, action: 'approve' | 'reject' | 'custom', _customContext?: string): Promise<void> {
    console.log(`[ApprovalService] handleApproval called: ${requestId} action=${action}`);
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      console.log(`[ApprovalService] No pending approval for ${requestId}`);
      console.log(`[ApprovalService] Pending keys:`, [...this.pendingApprovals.keys()]);
      return;
    }

    console.log(`[ApprovalService] Found pending approval, resolving...`);

    // Mark as resolved FIRST to prevent race with polling
    pending.resolved = true;

    // Get chatId for status update
    const job = await getApprovalJob(requestId);
    const chatId = job?.chatId ?? 0;
    console.log(`[ApprovalService] job=${JSON.stringify(job)}, chatId=${chatId}`);

    // Clear timeout, reminders, and polling
    clearTimeout(pending.timeout);
    if (pending.reminderTimers) {
      pending.reminderTimers.forEach(t => clearTimeout(t));
    }
    this.stopPolling(requestId);

    if (action === 'custom') {
      // Custom button pressed - ask user for modification text
      console.log(`[ApprovalService] Custom approval requested for ${requestId}`);
      await this.requestCustomInput(requestId, pending.id, pending.resolve);
      return;
    }

    // Update job status
    const status = action === 'approve' ? 'approved' : 'rejected';
    try {
      await updateApprovalStatus(requestId, status);
    } catch (err) {
      // Log but don't fail - the approval itself still needs to resolve
      console.warn(`[ApprovalService] Failed to update job status in queue: ${(err as Error).message}`);
    }

    // Update live status
    console.log(`[ApprovalService] Calling setApprovalResult(${chatId}, ${status}, ${job?.toolName})`);
    setApprovalResult(chatId, status, job?.toolName);

    // Log duration
    const duration = Date.now() - pending.startTime;
    console.log(`[ApprovalService] Request ${requestId} (${pending.toolName}) ${status} in ${duration}ms`);

    // Resolve the pending request - THIS IS CRITICAL and must happen even if queue update fails
    console.log(`[ApprovalService] Calling pending.resolve({ approved: ${action === 'approve'} })`);
    pending.resolve({ approved: action === 'approve' });

    // Remove from pending
    this.pendingApprovals.delete(requestId);
    console.log(`[ApprovalService] handleApproval complete`);
  }

  /**
   * Request custom input from user
   */
  private async requestCustomInput(
    requestId: string,
    toolName: string,
    originalResolve: (result: { approved: boolean; customContext?: string }) => void
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;

    const chatId = (await getApprovalJob(requestId))?.chatId;
    if (!chatId) return;

    return new Promise<void>(async (resolve) => {
      // Set 60 second timeout for custom input
      const timeout = setTimeout(() => {
        this.handleCustomInputTimeout(requestId, originalResolve);
        resolve();
      }, CUSTOM_INPUT_TIMEOUT_MS);

      // Wrap resolve to convert void -> string | null
      const wrappedResolve = (_customContext: string | null) => {
        resolve();
      };

      // Store pending custom input
      this.pendingCustomInputs.set(requestId, {
        id: requestId,
        toolName,
        chatId,
        resolve: wrappedResolve,
        timeout,
      });

      // Ask user for modification text via force_reply
      const message = `✏️ *Custom Feedback*

Please describe what you'd like to change or add.

Your feedback will be shown in the next AI response.

_60 seconds to respond before auto-timeout_`;

      const forceReplyMsgId = await telegramBot.sendMessageForceReply(chatId, message);
      if (forceReplyMsgId) {
        telegramBot.setCustomInputMessageId(chatId, forceReplyMsgId);
      }

      // Note: resolve will be called when user provides input or timeout occurs
    });
  }

  /**
   * Handle custom input received from user
   * Can be called either:
   * 1. Before timeout - normal flow (force_reply matched)
   * 2. After timeout - late message arrives (fallback triggered)
   */
  async handleCustomInput(requestId: string, customText: string): Promise<void> {
    let customInput = this.pendingCustomInputs.get(requestId);

    // If pendingCustomInputs was already cleared (timeout fired), this is a LATE message
    // Reconstruct needed state from the job queue
    if (!customInput) {
      console.log(`[ApprovalService] Late custom input for ${requestId}: ${customText}`);

      // Check if pendingApprovals still exists - if so, timeout fired but promise wasn't resolved
      // (we intentionally don't resolve or delete pendingApprovals in handleCustomInputTimeout
      // to allow late messages to override the timeout)
      const pending = this.pendingApprovals.get(requestId);
      if (!pending) {
        console.log(`[ApprovalService] No pending approval for ${requestId}, ignoring late message`);
        return;
      }

      const job = await getApprovalJob(requestId);
      if (!job) {
        console.log(`[ApprovalService] No job found for ${requestId}, ignoring late message`);
        return;
      }

      // Reconstruct minimal customInput for processing
      customInput = {
        id: requestId,
        toolName: job.toolName,
        chatId: job.chatId,
        resolve: () => {},
        timeout: null as any,
      };
    } else {
      // Normal case - clear timeout and pending state
      clearTimeout(customInput.timeout);
      this.pendingCustomInputs.delete(requestId);
    }

    console.log(`[ApprovalService] Custom input received for ${requestId}: ${customText}`);

    // Update job with custom context
    await updateApprovalStatus(requestId, 'approved', customText);

    // Update live status - this transitions phase from 'awaiting_approval' back to 'active'
    setApprovalResult(customInput.chatId, 'approved', customInput.toolName);

    // Resolve the pending request with the custom text
    customInput.resolve(customText);

    // Also resolve the original approval request
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      const duration = Date.now() - pending.startTime;
      console.log(`[ApprovalService] Request ${requestId} (${pending.toolName}) custom approved in ${duration}ms`);
      if (pending.reminderTimers) {
        pending.reminderTimers.forEach(t => clearTimeout(t));
      }
      pending.resolve({ approved: true, customContext: customText });
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Handle custom input timeout
   * NOTE: We do NOT resolve the promise or delete pendingApprovals here.
   * This allows LATE messages (user's Telegram reply arrives after timeout)
   * to still be processed and override the timeout result.
   */
  private async handleCustomInputTimeout(
    requestId: string,
    _originalResolve: (result: { approved: boolean; customContext?: string }) => void
  ): Promise<void> {
    const customInput = this.pendingCustomInputs.get(requestId);
    if (!customInput) return;

    this.pendingCustomInputs.delete(requestId);

    console.log(`[ApprovalService] Custom input timeout for ${requestId}`);

    // DO NOT call telegramBot.clearCustomInputState here
    // The user's message might still arrive late via getUpdates
    // Let the fallback in bot.ts handle cleanup after the message arrives

    // Update job status to 'timeout' (pendingApprovals entry remains for late override)
    await updateApprovalStatus(requestId, 'timeout');

    // Update live status - shows timeout in UI
    setApprovalResult(customInput.chatId, 'timeout', customInput.toolName);

    // DO NOT resolve originalResolve here - late message may still arrive
    // The pendingApprovals entry remains so handleCustomInput can override

    // Clear reminder timers
    const pending = this.pendingApprovals.get(requestId);
    if (pending?.reminderTimers) {
      pending.reminderTimers.forEach(t => clearTimeout(t));
    }

    // DO NOT delete from pendingApprovals - late message must be able to override
    // DO NOT call originalResolve - timeout doesn't resolve the promise
  }

  /**
   * Handle approval timeout
   */
  private async handleApprovalTimeout(requestId: string): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    console.log(`[ApprovalService] Approval timeout for ${requestId}`);

    // Get job info for status update
    const job = await getApprovalJob(requestId);

    // Update job status
    await updateApprovalStatus(requestId, 'timeout');

    // Update live status
    if (job) {
      setApprovalResult(job.chatId, 'timeout', job.toolName);
    }

    // Log duration
    const duration = Date.now() - pending.startTime;
    console.log(`[ApprovalService] Request ${requestId} (${pending.toolName}) timed out after ${duration}ms`);

    // Resolve as rejected
    pending.resolve({ approved: false });

    // Clear reminder timers if still pending
    if (pending.reminderTimers) {
      pending.reminderTimers.forEach(t => clearTimeout(t));
    }

    // Remove from pending
    this.pendingApprovals.delete(requestId);
    this.stopPolling(requestId);
  }

  /**
   * Start polling for job status changes
   */
  private startPolling(requestId: string): void {
    const interval = setInterval(async () => {
      const job = await getApprovalJob(requestId);
      if (!job) return;

      if (job.status === 'approved' || job.status === 'rejected' || job.status === 'timeout') {
        this.stopPolling(requestId);

        const pending = this.pendingApprovals.get(requestId);
        // Only resolve if not already resolved by handleApproval (race condition fix)
        if (pending && !pending.resolved) {
          pending.resolved = true;
          clearTimeout(pending.timeout);
          pending.resolve({ approved: job.status === 'approved', customContext: job.customContext });
          this.pendingApprovals.delete(requestId);
        }
      }
    }, 500);

    this.pollIntervals.set(requestId, interval);
  }

  /**
   * Stop polling for a request
   */
  private stopPolling(requestId: string): void {
    const interval = this.pollIntervals.get(requestId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(requestId);
    }
  }

  /**
   * Generate a unique request ID
   */
  generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if there are pending approvals
   */
  hasPendingApprovals(): boolean {
    return this.pendingApprovals.size > 0;
  }

  /**
   * Get pending approval count
   */
  getPendingCount(): number {
    return this.pendingApprovals.size;
  }

  /**
   * Get pending custom input count
   */
  getPendingCustomInputCount(): number {
    return this.pendingCustomInputs.size;
  }

  /**
   * Cancel pending custom input for a chat (e.g. when user sends a command)
   */
  cancelCustomInput(chatId: number): void {
    for (const [requestId, customInput] of this.pendingCustomInputs.entries()) {
      if (customInput.chatId === chatId) {
        clearTimeout(customInput.timeout);
        this.pendingCustomInputs.delete(requestId);
        console.log(`[ApprovalService] Cancelled pending custom input for ${requestId}`);
        break;
      }
    }
  }
}

// Singleton
export const approvalService = new ApprovalService();