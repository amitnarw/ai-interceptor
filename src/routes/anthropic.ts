import { Router, Request, Response } from 'express';
import axios from 'axios';
import { Readable } from 'stream';
import { config } from '../config/index.js';
import { approvalService } from '../services/approvalService.js';
import { modeManager } from '../config/mode.js';
import { MiniMaxAPIError, TimeoutError, parseMiniMaxError } from '../middleware/errorHandler.js';
import { SSEParser } from '../utils/sseParser.js';
import {
  startStatus,
  addStatusEvent,
  completeStatus,
  appendSseText,
} from '../services/liveStatus.js';

const router = Router();

const MINIMAX_ANTHROPIC_URL = 'https://api.minimax.io/anthropic/v1/messages';
const REQUEST_TIMEOUT_MS = 60000; // 60 seconds default

interface AnthropicRequest {
  model?: string;
  messages?: Array<{ role: string; content: string | Array<unknown> }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  system?: string | Array<{ type: string; text: string }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: unknown;
  }>;
  [key: string]: unknown;
}

async function handleAnthropicRequest(req: Request, res: Response): Promise<void> {
  const requestBody: AnthropicRequest = req.body;
  const stream = requestBody.stream ?? false;

  try {
    if (stream && modeManager.isAwayMode() && requestBody.tools && requestBody.tools.length > 0) {
      await handleStreamingWithApproval(req, res, requestBody);
    } else {
      await forwardToMiniMax(req, res, requestBody, !stream);
    }
  } catch (error) {
    // Handle known error types
    if (error instanceof MiniMaxAPIError || error instanceof TimeoutError) {
      if (!res.headersSent) {
        res.status((error as MiniMaxAPIError).statusCode).json({
          error: {
            code: (error as MiniMaxAPIError).code,
            type: (error as MiniMaxAPIError).statusCode === 408 ? 'timeout' : 'api_error',
            message: error.message,
            source: 'minimax',
          },
        });
      }
      return;
    }

    // Handle axios errors
    if (axios.isAxiosError(error)) {
      const miniMaxError = parseMiniMaxError(error);
      if (miniMaxError) {
        console.error(`[Anthropic] MiniMax API error: ${miniMaxError.message}`);
        if (!res.headersSent) {
          res.status(miniMaxError.statusCode).json({
            error: {
              code: miniMaxError.code,
              type: miniMaxError.errorType,
              message: miniMaxError.message,
              source: 'minimax',
            },
          });
        }
        return;
      }

      // Network error (no response)
      console.error(`[Anthropic] Network error: ${error.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            code: 'NETWORK_ERROR',
            message: 'Failed to reach MiniMax Anthropic API',
          },
        });
      }
      return;
    }

    // Unknown error
    console.error(`[Anthropic] Unexpected error:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    }
  }
}

async function handleStreamingWithApproval(
  req: Request,
  res: Response,
  requestBody: AnthropicRequest
): Promise<void> {
  const chatId = parseInt(config.telegramChatId, 10);

  console.log('[Anthropic] Making peek request to detect tool calls...');

  let peekResult;
  try {
    peekResult = await approvalService.peekForToolCalls(
      MINIMAX_ANTHROPIC_URL,
      config.minimaxApiKey,
      requestBody,
      'anthropic'
    );
  } catch (error) {
    if (error instanceof MiniMaxAPIError || error instanceof TimeoutError) {
      throw error;
    }
    console.error('[Anthropic] Peek request failed:', error);
    throw new MiniMaxAPIError(500, 'Failed to detect tool calls', 'peek_failed');
  }

  if (!peekResult.hasToolCalls) {
    console.log('[Anthropic] No tool calls detected, streaming normally');
    await forwardToMiniMax(req, res, requestBody, true);
    return;
  }

  const interceptTools = peekResult.toolCalls.filter(tc =>
    approvalService.needsApproval([{ name: tc.name }])
  );

  if (interceptTools.length === 0) {
    console.log('[Anthropic] No intercept tools, streaming normally');
    await forwardToMiniMax(req, res, requestBody, true);
    return;
  }

  console.log(`[Anthropic] Detected ${interceptTools.length} intercept tool(s), requesting approval`);

  const firstTool = interceptTools[0];
  const requestId = approvalService.generateRequestId();

  let preview = firstTool.arguments;
  let filePath: string | undefined;

  try {
    const args = JSON.parse(firstTool.arguments);
    filePath = args.path || args.file || args.filePath;
    preview = args.content || args.code || args.text || firstTool.arguments;
  } catch {
  }

  const approvalResult = await approvalService.requestApproval(
    requestId,
    firstTool.name,
    filePath,
    preview.substring(0, 500),
    chatId
  );

  if (!approvalResult.approved) {
    console.log('[Anthropic] Tool call rejected');
    completeStatus(chatId, false);
    res.status(403).json({
      error: 'Tool call rejected by user',
      tool: firstTool.name,
    });
    return;
  }

  if (approvalResult.customContext) {
    console.log('[Anthropic] Custom context provided, injecting into request');
    const customMessage = {
      role: 'user',
      content: `User modification request: ${approvalResult.customContext}`
    };

    if (Array.isArray(requestBody.messages)) {
      requestBody.messages.push(customMessage);
    }
  }

  await forwardToMiniMax(req, res, requestBody, true);
}

async function forwardToMiniMax(
  req: Request,
  res: Response,
  requestBody: AnthropicRequest,
  trackStatus: boolean = false
): Promise<void> {
  const stream = requestBody.stream ?? false;
  const chatId = parseInt(config.telegramChatId, 10);

  const response = await axios({
    method: 'POST',
    url: MINIMAX_ANTHROPIC_URL,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.minimaxApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    data: requestBody,
    responseType: stream ? 'stream' : 'json',
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!stream && !response.data) {
    console.error('[Anthropic] Empty response from MiniMax API');
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          code: 'EMPTY_RESPONSE',
          message: 'Empty response from MiniMax API',
        },
      });
    }
    return;
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Request-Id', req.headers['x-request-id'] as string || '');

    if (trackStatus) {
      startStatus(chatId);
    }

    const streamData = response.data as Readable;
    const sseParser = new SSEParser();
    let streamEnded = false;

    streamData.on('data', (chunk: Buffer) => {
      if (trackStatus && !streamEnded) {
        const { events, cleanChunk } = sseParser.parse(chunk);

        // Append streaming text to Telegram message
        if (cleanChunk && cleanChunk.trim()) {
          appendSseText(chatId, cleanChunk);
        }

        for (const event of events) {
          if (event.type === 'text' && event.data) {
            addStatusEvent(chatId, { type: 'text', detail: event.data });
          } else if (event.type === 'tool_complete' && event.toolEvent) {
            const toolName = event.toolEvent.name;
            const path = SSEParser.extractPathFromArguments(
              event.toolEvent.arguments ?? '',
              toolName
            );
            const isIntercept = SSEParser.isInterceptTool(toolName);

            addStatusEvent(chatId, {
              type: 'tool_complete',
              tool: toolName,
              path,
              detail: isIntercept ? 'approved' : 'passthrough',
            });
          } else if (event.type === 'done') {
            streamEnded = true;
            completeStatus(chatId, true);
          }
        }

        res.write(cleanChunk || chunk.toString());
      } else {
        res.write(chunk);
      }
    });

    streamData.on('end', () => {
      if (trackStatus && !streamEnded) {
        const { events } = sseParser.flush();
        for (const event of events) {
          if (event.type === 'tool_complete' && event.toolEvent) {
            addStatusEvent(chatId, {
              type: 'tool_complete',
              tool: event.toolEvent.name,
            });
          }
        }
        completeStatus(chatId, true);
      }
      res.end();
    });

    streamData.on('error', (error: Error) => {
      console.error(`[Anthropic] Stream error: ${error.message}`);
      if (trackStatus) {
        completeStatus(chatId, false);
      }
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Stream error' } });
      } else {
        res.end();
      }
    });

    res.on('error', (error: Error) => {
      console.error(`[Anthropic] Response error: ${error.message}`);
      streamData.destroy();
    });
  } else {
    res.status(response.status).json(response.data);
  }
}

// Handle axios timeout errors
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      return Promise.reject(new TimeoutError('Request to MiniMax API timed out'));
    }
    return Promise.reject(error);
  }
);

router.post('/v1/messages', handleAnthropicRequest);

export default router;