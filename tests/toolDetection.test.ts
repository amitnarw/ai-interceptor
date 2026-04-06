import { describe, it, expect } from 'vitest';
import {
  detectOpenAIToolCalls,
  detectAnthropicToolCalls,
  parseSSEToolCall,
  detectToolCalls,
} from '../src/utils/toolDetection.js';

describe('Tool Detection', () => {
  describe('detectOpenAIToolCalls', () => {
    it('should detect tool calls from OpenAI format response', () => {
      const response = {
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_123',
              type: 'function',
              function: {
                name: 'write_to_file',
                arguments: '{"path": "test.js", "content": "hello"}'
              }
            }]
          }
        }]
      };

      const result = detectOpenAIToolCalls(response);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('write_to_file');
      expect(result[0].id).toBe('call_123');
    });

    it('should return empty array for response without tool calls', () => {
      const response = {
        choices: [{
          message: {
            content: 'Hello world'
          }
        }]
      };

      const result = detectOpenAIToolCalls(response);

      expect(result).toHaveLength(0);
    });

    it('should handle multiple tool calls', () => {
      const response = {
        choices: [{
          message: {
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'write_to_file', arguments: '{}' } }
            ]
          }
        }]
      };

      const result = detectOpenAIToolCalls(response);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('read_file');
      expect(result[1].name).toBe('write_to_file');
    });

    it('should handle malformed responses gracefully', () => {
      expect(detectOpenAIToolCalls(null)).toEqual([]);
      expect(detectOpenAIToolCalls(undefined)).toEqual([]);
      expect(detectOpenAIToolCalls({})).toEqual([]);
      expect(detectOpenAIToolCalls({ choices: null })).toEqual([]);
    });
  });

  describe('detectAnthropicToolCalls', () => {
    it('should detect tool calls from Anthropic format response', () => {
      const response = {
        content: [{
          type: 'tool_use',
          id: 'tool_456',
          name: 'read_file',
          input: { path: '/etc/passwd' }
        }]
      };

      const result = detectAnthropicToolCalls(response);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
      expect(result[0].id).toBe('tool_456');
    });

    it('should return empty array for response without tool calls', () => {
      const response = {
        content: [{
          type: 'text',
          text: 'Hello world'
        }]
      };

      const result = detectAnthropicToolCalls(response);

      expect(result).toHaveLength(0);
    });

    it('should handle multiple tool uses', () => {
      const response = {
        content: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
          { type: 'tool_use', id: 't2', name: 'grep_search', input: {} }
        ]
      };

      const result = detectAnthropicToolCalls(response);

      expect(result).toHaveLength(2);
    });

    it('should handle malformed responses gracefully', () => {
      expect(detectAnthropicToolCalls(null)).toEqual([]);
      expect(detectAnthropicToolCalls({})).toEqual([]);
      expect(detectAnthropicToolCalls({ content: null })).toEqual([]);
    });
  });

  describe('parseSSEToolCall', () => {
    it('should parse SSE data line for tool_call type', () => {
      const line = 'data: {"type":"tool_call","id":"tool_789","name":"execute_command","input":{"cmd":"ls"}}';

      const result = parseSSEToolCall(line);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('execute_command');
      expect(result?.id).toBe('tool_789');
    });

    it('should return null for non-tool SSE lines', () => {
      expect(parseSSEToolCall('data: [DONE]')).toBeNull();
      expect(parseSSEToolCall('not a data line')).toBeNull();
      expect(parseSSEToolCall('data: {"type":"text","text":"hello"}')).toBeNull();
    });

    it('should handle OpenAI format in SSE', () => {
      const line = 'data: {"choices":[{"message":{"tool_calls":[{"id":"c1","function":{"name":"write_to_file"}}]}}]}';

      const result = parseSSEToolCall(line);

      expect(result).not.toBeNull();
      expect(result?.name).toBe('write_to_file');
    });
  });

  describe('detectToolCalls', () => {
    it('should use OpenAI detector for openai format', () => {
      const response = {
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'test_tool', arguments: '{}' }
            }]
          }
        }]
      };

      const result = detectToolCalls(response, 'openai');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test_tool');
    });

    it('should use Anthropic detector for anthropic format', () => {
      const response = {
        content: [{
          type: 'tool_use',
          id: 'tool_1',
          name: 'test_tool',
          input: {}
        }]
      };

      const result = detectToolCalls(response, 'anthropic');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test_tool');
    });
  });
});