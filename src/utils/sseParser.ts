import { classifyTool } from '../filters/toolFilter.js';

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
}

export class SSEParser {
  private buffer: string = '';
  private pendingToolCalls: Map<string, { name: string; arguments: string }> = new Map();
  private textBuffer: string = '';

  parse(chunk: Buffer): { events: SSEEvent[]; cleanChunk: string } {
    const events: SSEEvent[] = [];
    this.buffer += chunk.toString();

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('event:')) {
        const eventType = line.slice(6).trim();
        i++;

        if (i < lines.length && lines[i].startsWith('data:')) {
          const data = lines[i].slice(6).trim();
          const parsedEvent = this.parseEventData(eventType, data);
          if (parsedEvent) events.push(parsedEvent);
        } else if (i < lines.length && lines[i].trim() === '') {
          i++;
          continue;
        } else {
          i++;
          continue;
        }
      } else if (line.startsWith('data:')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          events.push({ type: 'done' });
        } else {
          const parsedEvent = this.parseEventData('message', data);
          if (parsedEvent) events.push(parsedEvent);
        }
        i++;
      } else if (line.trim() === '') {
        i++;
      } else {
        i++;
      }
    }

    const cleanChunk = chunk.toString()
      .replace(/data: \[DONE\]\r?\n\r?\n?/g, '')
      .replace(/event: ping\r?\n\r?\n?/g, '');

    return { events, cleanChunk };
  }

  private parseEventData(eventType: string, rawData: string): SSEEvent | null {
    if (!rawData || rawData === '[DONE]') {
      return null;
    }

    try {
      const data = JSON.parse(rawData);

      if (eventType === 'content_block_start' || eventType === 'message_start') {
        if (data.type === 'content_block_start' && data.content_block?.type === 'thinking') {
          return { type: 'content_block', contentBlockType: 'thinking' };
        }
        return { type: 'content_block', contentBlockType: data.content_block?.type };
      }

      if (eventType === 'content_block_delta' || eventType === 'message_delta') {
        if (data.type === 'content_block_delta' && data.delta?.type === 'thinking_delta') {
          this.textBuffer += data.delta.thinking ?? '';
          return { type: 'text', data: data.delta.thinking };
        }
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
          this.textBuffer += data.delta.text ?? '';
          return { type: 'text', data: data.delta.text };
        }
        if (data.type === 'message_delta' && data.delta?.type === 'text_delta') {
          this.textBuffer += data.delta.text ?? '';
          return { type: 'text', data: data.delta.text };
        }
        if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
          const partialArg = data.delta.partial_json ?? '';
          const lastToolId = Array.from(this.pendingToolCalls.keys()).pop();
          if (lastToolId && this.pendingToolCalls.has(lastToolId)) {
            this.pendingToolCalls.get(lastToolId)!.arguments += partialArg;
          }
        }
      }

      if (eventType === 'content_block_stop' || eventType === 'message_stop') {
        return { type: 'done' };
      }

      if (eventType === 'message' || eventType === 'ping') {
        return null;
      }

      if (data.type === 'tool_call' || data.type === 'function_call') {
        const toolId = data.id ?? `call_${Date.now()}`;
        const toolName = data.name ?? data.function?.name ?? 'unknown';

        if (!this.pendingToolCalls.has(toolId)) {
          this.pendingToolCalls.set(toolId, {
            name: toolName,
            arguments: data.input
              ? (typeof data.input === 'string' ? data.input : JSON.stringify(data.input))
              : data.function?.arguments ?? '',
          });
        }

        return {
          type: 'tool_call',
          toolEvent: {
            type: 'tool_call',
            id: toolId,
            name: toolName,
          },
        };
      }

      if (data.choices) {
        for (const choice of data.choices) {
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const toolId = tc.index?.toString() ?? `call_${Date.now()}`;
              const func = tc.function;
              if (func) {
                if (!this.pendingToolCalls.has(toolId)) {
                  this.pendingToolCalls.set(toolId, {
                    name: func.name ?? 'unknown',
                    arguments: func.arguments ?? '',
                  });
                } else {
                  const existing = this.pendingToolCalls.get(toolId)!;
                  existing.arguments += func.arguments ?? '';
                  if (func.name) existing.name = func.name;
                }
              }
            }
          }

          if (choice.delta?.content) {
            this.textBuffer += choice.delta.content;
            return { type: 'text', data: choice.delta.content };
          }

          if (choice.finish_reason === 'tool_calls') {
            const completedTools: SSEToolEvent[] = [];
            for (const [id, tc] of this.pendingToolCalls) {
              completedTools.push({
                type: 'tool_complete',
                id,
                name: tc.name,
                arguments: tc.arguments,
              });
            }
            this.pendingToolCalls.clear();

            if (completedTools.length > 0) {
              return {
                type: 'tool_complete',
                toolEvent: completedTools[0],
              };
            }
          }
        }
      }

      if (data.type === 'tool_use') {
        const toolEvent: SSEToolEvent = {
          type: 'tool_complete',
          id: data.id ?? `tool_${Date.now()}`,
          name: data.name ?? 'unknown',
          arguments: data.input ? JSON.stringify(data.input) : undefined,
        };
        if (data.input?.path) {
          toolEvent.path = data.input.path;
        }

        return { type: 'tool_complete', toolEvent };
      }

      return { type: 'unknown' };
    } catch {
      return { type: 'unknown' };
    }
  }

  flush(): { events: SSEEvent[]; cleanChunk: string } {
    const events: SSEEvent[] = [];

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

    return { events, cleanChunk: '' };
  }

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
}
