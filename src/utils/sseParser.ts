/**
 * SSEParser — Stateful SSE parser using eventsource-parser
 *
 * Ported from Go codebase (seifghazi/claude-code-proxy) concepts:
 * - Proper line buffering via eventsource-parser (handles multi-chunk lines)
 * - Chunk-by-chunk forwarding (real-time, not buffered)
 * - Tool input accumulation via input_json_delta events
 *
 * Key differences from raw chunk.split('\n') approach:
 * 1. eventsource-parser handles TCP chunk boundary issues internally
 * 2. cleanChunk is reconstructed from parsed events, not raw string replacement
 * 3. [DONE] and ping events are stripped at parse time, not via regex on raw chunk
 */

import { createParser, EventSourceMessage } from 'eventsource-parser';
import { classifyTool } from '../filters/toolFilter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEToolEvent {
  type: 'tool_call' | 'tool_complete';
  id: string;
  name: string;
  arguments?: string;
  path?: string;
}

export interface SSEEvent {
  type: 'text' | 'tool_call' | 'tool_complete' | 'content_block' | 'done' | 'unknown';
  data?: string;
  toolEvent?: SSEToolEvent;
  contentBlockType?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// SSEParser
// ---------------------------------------------------------------------------

export class SSEParser {
  // Tool call accumulation (indexed by tool id) — ported from Go's toolCalls[]
  private pendingToolCalls = new Map<string, { name: string; arguments: string }>();

  // Text deduplication — skip duplicate text deltas
  private lastTextDelta = '';

  // eventsource-parser instance — handles line buffering internally
  private parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      this.onEvent(event);
    },
    onComment: (_comment: string) => {
      // Comments (lines starting with ':') are ignored — not forwarded to client
    },
    onError: (error: Error) => {
      // Log but don't crash — SSE parsing continues
      console.warn('[SSEParser] Parse error:', error.message);
    },
  });

  // Pending SSE lines to forward (reconstructed from parsed events)
  private forwardBuffer = '';

  // Usage data captured from message events
  private usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;

  // Track if done was already emitted (prevents duplicate done events from flush)
  private doneEmitted = false;

  /**
   * eventsource-parser event handler — called for each complete SSE event.
   * This is the central place where we:
   * 1. Reconstruct SSE lines for forwarding (except ping/[DONE]/comment)
   * 2. Extract text/tool events for Telegram
   * 3. Accumulate tool input via input_json_delta
   */
  private onEvent(event: EventSourceMessage): void {
    const { event: type, data } = event;

    // Comment lines (onComment handles these separately)
    // [DONE] is just a data: [DONE] with no type — data === '[DONE]'
    if (data === '[DONE]') {
      // [DONE] signals end of OpenAI streaming — strip it
      // message_stop event signals end of Anthropic streaming
      return;
    }

    if (type === 'ping') {
      // ping events are not meaningful for client — strip them
      return;
    }

    if (type === 'message_stop') {
      this.doneEmitted = true;
      this.emittedEvents.push({ type: 'done' });
      return;
    }

    // Reconstruct SSE line for forwarding
    // Skip lines with no meaningful data
    if (data) {
      const sseLine = type ? `event: ${type}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
      this.forwardBuffer += sseLine;
    }

    // Parse the data JSON to extract display events
    if (!data) return;

    try {
      const parsed = JSON.parse(data);
      this.processEventData(type, parsed);
    } catch {
      // Malformed JSON — forward as-is but don't emit display event
    }
  }

  // Temporary storage for events emitted during parser.feed()
  private emittedEvents: SSEEvent[] = [];

  /**
   * Process parsed event data to extract display events for Telegram.
   * Ported from Go's handleStreamingResponse switch statement.
   */
  private processEventData(eventType: string | undefined, data: Record<string, unknown>): void {
    // Determine actual event type — eventsource-parser may give us type in data.type
    const actualType = (data.type as string) || eventType || 'message';

    // message_start — capture usage
    if (actualType === 'message_start') {
      const msg = data.message as { usage?: Record<string, number> } | undefined;
      if (msg?.usage) {
        this.usage = {
          input_tokens: msg.usage.input_tokens ?? 0,
          output_tokens: msg.usage.output_tokens ?? 0,
          total_tokens: msg.usage.total_tokens ?? 0,
        };
      }
    }

    // message_delta — capture usage at end of stream (Anthropic format)
    if (actualType === 'message_delta') {
      const usage = data.usage as Record<string, number> | undefined;
      if (usage) {
        this.usage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        };
      }
    }

    // content_block_start — tool_use blocks
    if (actualType === 'content_block_start') {
      const block = data.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'thinking') {
        this.emittedEvents.push({ type: 'content_block', contentBlockType: 'thinking' });
      }
      if (block?.type === 'tool_use') {
        const toolId = (block.id as string) || `tool_${Date.now()}`;
        const toolName = (block.name as string) || 'unknown';
        this.pendingToolCalls.set(toolId, { name: toolName, arguments: '' });
      }
    }

    // content_block_delta — text_delta, thinking_delta, input_json_delta
    if (actualType === 'content_block_delta') {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      // text_delta — actual response text, forwarded to Telegram
      if (delta.type === 'text_delta') {
        const text = (delta.text as string) || '';
        if (text && text !== this.lastTextDelta) {
          this.emittedEvents.push({ type: 'text', data: text });
          this.lastTextDelta = text;
        }
      }

      // thinking_delta — internal extended thinking, NOT forwarded to Telegram
      // (only shown internally, never exposed to user)
      if (delta.type === 'thinking_delta') {
        const thinking = (delta.thinking as string) || '';
        if (thinking && thinking !== this.lastTextDelta) {
          // Track but DO NOT emit — thinking is internal model cognition
          this.lastTextDelta = thinking;
        }
      }

      // Ported from Go: accumulate input_json_delta for tool calls
      // The Go code appends to toolCalls[index].Input as raw JSON bytes
      if (delta.type === 'input_json_delta') {
        const partialJson = (delta.partial_json as string) || '';
        const toolId = (data.index as number) ?? -1;
        // Find the tool at this index — pendingToolCalls uses string keys
        const toolKey = Array.from(this.pendingToolCalls.keys())[toolId];
        if (toolKey && this.pendingToolCalls.has(toolKey)) {
          this.pendingToolCalls.get(toolKey)!.arguments += partialJson;
        }
      }
    }

    // message — capture usage (Anthropic sends this at end of non-streaming)
    if (actualType === 'message') {
      const msg = data.message as { usage?: Record<string, number> } | undefined;
      if (msg?.usage) {
        this.usage = {
          input_tokens: msg.usage.input_tokens ?? 0,
          output_tokens: msg.usage.output_tokens ?? 0,
          total_tokens: msg.usage.total_tokens ?? 0,
        };
      }
    }
  }

  /**
   * Feed a raw chunk from the HTTP stream.
   * eventsource-parser buffers internally until complete SSE lines.
   *
   * Returns:
   *   events: SSE display events extracted from this chunk (text, tool calls, etc.)
   *   cleanChunk: SSE lines to forward to client (reconstructed, ping/[DONE] stripped)
   */
  parse(chunk: Buffer): { events: SSEEvent[]; cleanChunk: string } {
    // Feed raw bytes to the parser — it handles multi-chunk lines internally.
    // The parser calls onEvent() synchronously for each complete SSE event.
    this.parser.feed(chunk.toString('utf-8'));

    // Drain the forward buffer (reconstructed SSE lines)
    const cleanChunk = this.forwardBuffer;
    this.forwardBuffer = '';

    // Drain emitted events collected during this feed
    const emittedEvents = this.emittedEvents;
    this.emittedEvents = [];

    return { events: emittedEvents, cleanChunk };
  }

  /**
   * Flush — called when stream ends. Emit any pending tool_complete events.
   */
  flush(): { events: SSEEvent[]; cleanChunk: string } {
    const events: SSEEvent[] = [];

    // Emit pending tool calls as tool_complete events
    for (const [id, tc] of this.pendingToolCalls) {
      events.push({
        type: 'tool_complete',
        toolEvent: {
          type: 'tool_complete',
          id,
          name: tc.name,
          arguments: tc.arguments,
        },
      });
    }
    this.pendingToolCalls.clear();

    if (this.usage && !this.doneEmitted) {
      this.doneEmitted = true;
      events.push({ type: 'done', usage: this.usage });
    }

    return { events, cleanChunk: '' };
  }

  /**
   * Extract file path from tool arguments — same logic as Go's extractPathFromArguments.
   */
  static extractPathFromArguments(arguments_: string, _toolName: string): string | undefined {
    try {
      const args = JSON.parse(arguments_);
      return args.path ?? args.file ?? args.filePath ?? args.target ?? args.filepath;
    } catch {
      return undefined;
    }
  }

  static isInterceptTool(toolName: string): boolean {
    return classifyTool(toolName) === 'intercept';
  }

  /** Returns captured usage data */
  getUsage(): { input_tokens: number; output_tokens: number; total_tokens: number } | undefined {
    return this.usage;
  }
}