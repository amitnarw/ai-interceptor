export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AnthropicToolUse {
  id: string;
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

export interface DetectedTool {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export function detectOpenAIToolCalls(response: unknown): DetectedTool[] {
  if (!response || typeof response !== 'object') {
    return [];
  }

  const data = response as Record<string, unknown>;

  if (!Array.isArray(data.choices)) {
    return [];
  }

  const tools: DetectedTool[] = [];

  for (const choice of data.choices) {
    if (!choice || typeof choice !== 'object') continue;

    const choiceObj = choice as Record<string, unknown>;
    const message = choiceObj.message as Record<string, unknown> | undefined;

    if (!message || typeof message !== 'object') continue;

    const toolCalls = message.tool_calls;

    if (!Array.isArray(toolCalls)) continue;

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue;

      const tc = toolCall as Record<string, unknown>;
      const func = tc.function as Record<string, unknown> | undefined;

      if (!func || typeof func.name !== 'string') continue;

      tools.push({
        id: typeof tc.id === 'string' ? tc.id : `call_${tools.length}`,
        name: func.name,
        arguments: typeof func.arguments === 'string' ? func.arguments : JSON.stringify(func.arguments || {}),
      });
    }
  }

  return tools;
}

export function detectAnthropicToolCalls(response: unknown): DetectedTool[] {
  if (!response || typeof response !== 'object') {
    return [];
  }

  const data = response as Record<string, unknown>;

  if (!Array.isArray(data.content)) {
    return [];
  }

  const tools: DetectedTool[] = [];

  for (const content of data.content) {
    if (!content || typeof content !== 'object') continue;

    const c = content as Record<string, unknown>;

    if (c.type !== 'tool_use') continue;

    const toolUse = c as unknown as AnthropicToolUse;

    if (typeof toolUse.name !== 'string') continue;

    tools.push({
      id: typeof toolUse.id === 'string' ? toolUse.id : `call_${tools.length}`,
      name: toolUse.name,
      arguments: toolUse.input || {},
    });
  }

  return tools;
}

export function parseSSEToolCall(line: string): DetectedTool | null {
  if (!line.startsWith('data: ')) return null;

  const jsonStr = line.slice(6).trim();

  if (jsonStr === '[DONE]') return null;

  try {
    const data = JSON.parse(jsonStr);

    if (data.type === 'tool_call') {
      return {
        id: data.id || `call_${Date.now()}`,
        name: data.name,
        arguments: data.input || {},
      };
    }

    if (data.choices) {
      const openAITools = detectOpenAIToolCalls(data);
      if (openAITools.length > 0) return openAITools[0];
    }

    if (data.content) {
      const anthropicTools = detectAnthropicToolCalls(data);
      if (anthropicTools.length > 0) return anthropicTools[0];
    }
  } catch {
    return null;
  }

  return null;
}

export function detectToolCalls(
  response: unknown,
  format: 'openai' | 'anthropic'
): DetectedTool[] {
  if (format === 'anthropic') {
    return detectAnthropicToolCalls(response);
  }
  return detectOpenAIToolCalls(response);
}
