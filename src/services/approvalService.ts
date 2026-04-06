import { addApprovalJob, getApprovalJob, updateApprovalStatus, ApprovalJobData } from '../approvals/queue.js';
import { classifyTool } from '../filters/toolFilter.js';
import { modeManager } from '../config/mode.js';
import { telegramBot } from '../telegram/bot.js';
import { formatToolApprovalMessage } from '../telegram/keyboards.js';
import axios from 'axios';

const CUSTOM_INPUT_TIMEOUT_MS = 60000; // 60 seconds

export interface ApprovalRequest {
  id: string;
  resolve: (result: { approved: boolean; customContext?: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
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
    return new Promise((resolve) => {
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

      addApprovalJob(jobData);

      // Set up timeout (use configured timeout from mode manager)
      const timeoutMs = 10 * 60 * 1000; // 10 minutes - should match config
      const timeout = setTimeout(() => {
        this.handleApprovalTimeout(requestId);
      }, timeoutMs);

      // Store pending approval
      this.pendingApprovals.set(requestId, {
        id: requestId,
        resolve,
        timeout,
      });

      // Send Telegram message with buttons
      const message = formatToolApprovalMessage(toolName, filePath, preview, requestId);
      telegramBot.sendMessage(chatId, message.text);

      // Start polling for job status changes
      this.startPolling(requestId);
    });
  }

  /**
   * Handle approval from Telegram callback
   */
  async handleApproval(requestId: string, action: 'approve' | 'reject' | 'custom', _customContext?: string): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      console.log(`[ApprovalService] No pending approval for ${requestId}`);
      return;
    }

    // Clear timeout and polling
    clearTimeout(pending.timeout);
    this.stopPolling(requestId);

    if (action === 'custom') {
      // Custom button pressed - ask user for modification text
      console.log(`[ApprovalService] Custom approval requested for ${requestId}`);
      await this.requestCustomInput(requestId, pending.id, pending.resolve);
      return;
    }

    // Update job status
    const status = action === 'approve' ? 'approved' : 'rejected';
    await updateApprovalStatus(requestId, status);

    // Resolve the pending request
    pending.resolve({ approved: action === 'approve' });

    // Remove from pending
    this.pendingApprovals.delete(requestId);
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

    return new Promise<void>((resolve) => {
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

      // Ask user for modification text
      const message = `✏️ *Enter your modification:*

Please describe how you'd like to modify the tool execution. The AI will incorporate your feedback.

_Timeout: 60 seconds_`;

      telegramBot.sendMessage(chatId, message);

      // Note: resolve will be called when user provides input or timeout occurs
    });
  }

  /**
   * Handle custom input received from user
   */
  async handleCustomInput(requestId: string, customText: string): Promise<void> {
    const customInput = this.pendingCustomInputs.get(requestId);
    if (!customInput) {
      console.log(`[ApprovalService] No pending custom input for ${requestId}`);
      return;
    }

    // Clear timeout
    clearTimeout(customInput.timeout);
    this.pendingCustomInputs.delete(requestId);

    console.log(`[ApprovalService] Custom input received for ${requestId}: ${customText}`);

    // Update job with custom context
    await updateApprovalStatus(requestId, 'approved', customText);

    // Resolve the pending request with the custom text
    customInput.resolve(customText);

    // Also resolve the original approval request
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve({ approved: true, customContext: customText });
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Handle custom input timeout
   */
  private async handleCustomInputTimeout(
    requestId: string,
    originalResolve: (result: { approved: boolean; customContext?: string }) => void
  ): Promise<void> {
    const customInput = this.pendingCustomInputs.get(requestId);
    if (!customInput) return;

    this.pendingCustomInputs.delete(requestId);

    console.log(`[ApprovalService] Custom input timeout for ${requestId}`);

    // Notify user
    telegramBot.sendMessage(customInput.chatId, '⏱️ Custom input timeout. Tool call rejected.');

    // Update job status
    await updateApprovalStatus(requestId, 'timeout');

    // Resolve as rejected
    originalResolve({ approved: false });

    // Remove from pending approvals
    this.pendingApprovals.delete(requestId);
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

    // Update job status
    await updateApprovalStatus(requestId, 'timeout');

    // Resolve as rejected
    pending.resolve({ approved: false });

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
        if (pending) {
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
}

// Singleton
export const approvalService = new ApprovalService();