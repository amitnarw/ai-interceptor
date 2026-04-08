import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { config } from '../config/index.js';
import { approvalService } from '../services/approvalService.js';
import { modeManager } from '../config/mode.js';
import { MiniMaxAPIError, TimeoutError, parseMiniMaxError } from '../middleware/errorHandler.js';
import { SSEParser } from '../utils/sseParser.js';
import { axiosClient } from '../utils/axiosClient.js';
import { maybeDecompress } from '../utils/streamDecoders.js';
import { logRequest } from '../services/sessionStore.js';
import axios from 'axios';
import {
  startStatus,
  addStatusEvent,
  appendSseText,
  completeStatus,
  getStatusState,
  setTokens,
} from '../services/liveStatus.js';

const router = Router();

const MINIMAX_OPENAI_URL = 'https://api.minimax.io/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60000; // 60 seconds default

interface OpenAIRequest {
  model?: string;
  messages?: Array<{ role: string; content: string | Array<unknown> }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: string | { type: string; function: { name: string } };
  [key: string]: unknown;
}

async function handleOpenAIRequest(req: Request, res: Response): Promise<void> {
  const requestBody: OpenAIRequest = req.body;
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
        console.error(`[OpenAI] MiniMax API error: ${miniMaxError.message}`);
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
      console.error(`[OpenAI] Network error: ${error.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            code: 'NETWORK_ERROR',
            message: 'Failed to reach MiniMax API',
          },
        });
      }
      return;
    }

    // Unknown error
    console.error(`[OpenAI] Unexpected error:`, error);
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
  requestBody: OpenAIRequest
): Promise<void> {
  const chatId = parseInt(config.telegramChatId, 10);

  // Show thinking status immediately before peek request starts
  startStatus(chatId);

  console.log('[OpenAI] Making peek request to detect tool calls...');

  let peekResult;
  try {
    peekResult = await approvalService.peekForToolCalls(
      MINIMAX_OPENAI_URL,
      config.minimaxApiKey,
      requestBody,
      'openai'
    );
  } catch (error) {
    if (error instanceof MiniMaxAPIError || error instanceof TimeoutError) {
      throw error;
    }
    console.error('[OpenAI] Peek request failed:', error);
    throw new MiniMaxAPIError(500, 'Failed to detect tool calls', 'peek_failed');
  }

  if (!peekResult.hasToolCalls) {
    console.log('[OpenAI] No tool calls detected, streaming normally');
    await forwardToMiniMax(req, res, requestBody, true);
    return;
  }

  const interceptTools = peekResult.toolCalls.filter(tc =>
    approvalService.needsApproval([{ name: tc.name }])
  );

  if (interceptTools.length === 0) {
    console.log('[OpenAI] No intercept tools, streaming normally');
    await forwardToMiniMax(req, res, requestBody, true);
    return;
  }

  console.log(`[OpenAI] Detected ${interceptTools.length} intercept tool(s), requesting approval`);

  if (interceptTools.length > 1) {
    console.log('[OpenAI] Multiple intercept tools detected, rejecting request');
    completeStatus(chatId, false);
    res.status(400).json({
      error: 'Multiple intercept tools detected. Please retry with one tool at a time.',
      tools: interceptTools.map(t => t.name),
    });
    return;
  }

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

  // PORTED FROM GO (seifghazi/claude-code-proxy) — proxy/internal/model/models.go
  // Pass full tool arguments for rich Telegram notifications.
  // fullArguments stores the complete JSON (not truncated to 500 chars).
  const approvalResult = await approvalService.requestApproval(
    requestId,
    firstTool.name,
    filePath,
    preview.substring(0, 500),
    chatId,
    firstTool.arguments // full tool input JSON for detailed review
  );

  if (!approvalResult.approved) {
    console.log('[OpenAI] Tool call rejected, synthesizing SSE end_turn');
    completeStatus(chatId, false);

    // Synthesize a valid SSE stream that signals the turn is complete.
    // This prevents Claude Code from seeing a 403 auth error.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write('event: message_stop\ndata: {}\n\n');
    res.end();
    return;
  }

  if (approvalResult.customContext) {
    // Cannot inject a mid-stream user message — the SSE stream is assistant role only.
    // Instead, synthesize rejection SSE and show custom context in Telegram so the
    // user can naturally include it in their next prompt.
    console.log('[OpenAI] Custom context noted, synthesizing rejection SSE');
    completeStatus(chatId, false, `Custom feedback: ${approvalResult.customContext}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write('event: message_stop\ndata: {}\n\n');
    res.end();
    return;
  }

  // Preserve the existing messageId so we don't create a new pinned message
  const existingMsgId = getStatusState(chatId)?.messageId ?? null;
  await forwardToMiniMax(req, res, requestBody, true, existingMsgId);
}

async function forwardToMiniMax(
  req: Request,
  res: Response,
  requestBody: OpenAIRequest,
  trackStatus: boolean = false,
  existingMessageId?: number | null
): Promise<void> {
  const stream = requestBody.stream ?? false;
  const chatId = parseInt(config.telegramChatId, 10);

  const response = await axiosClient({
    method: 'POST',
    url: MINIMAX_OPENAI_URL,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.minimaxApiKey}`,
    },
    data: requestBody,
    responseType: stream ? 'stream' : 'json',
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!stream && !response.data) {
    console.error('[OpenAI] Empty response from MiniMax API');
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
      startStatus(chatId, existingMessageId);
    }

    // PORTED FROM GO (seifghazi/claude-code-proxy) — proxy/internal/service/anthropic.go
    // Handle gzip decompression BEFORE SSE parsing to avoid garbled bytes.
    // If Content-Encoding is gzip, decompress the stream first.
    const contentEncoding = response.headers['content-encoding'] as string | undefined;
    let streamData = response.data as Readable;
    if (contentEncoding) {
      streamData = maybeDecompress(streamData, contentEncoding);
    }

    const sseParser = new SSEParser();
    let streamEnded = false;
    let responseEnded = false;
    // Session tracking — ported from Go (seifghazi/claude-code-proxy) models.go RequestLog
    const sessionId = (req.headers['x-session-id'] as string) || '';
    const startTime = Date.now();
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (typeof v === 'string') responseHeaders[k] = v;
      else if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
    }

    streamData.on('data', (chunk: Buffer) => {
      if (trackStatus && !streamEnded) {
        const { events, cleanChunk } = sseParser.parse(chunk);

        for (const event of events) {
          if (event.type === 'text' && event.data) {
            appendSseText(chatId, event.data);
          } else if (event.type === 'content_block' && event.contentBlockType === 'thinking') {
            addStatusEvent(chatId, { type: 'thinking' });
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
            if (event.usage) {
              setTokens(chatId, event.usage);
            }
            completeStatus(chatId, true);
          }
        }

        res.write(cleanChunk);
      } else {
        res.write(chunk);
      }
    });

    streamData.on('end', () => {
      if (responseEnded) return;
      responseEnded = true;
      if (trackStatus && !streamEnded) {
        const { events } = sseParser.flush();
        for (const event of events) {
          if (event.type === 'tool_complete' && event.toolEvent) {
            addStatusEvent(chatId, {
              type: 'tool_complete',
              tool: event.toolEvent.name,
            });
          }
          if (event.type === 'done' && event.usage) {
            setTokens(chatId, event.usage);
          }
        }
        completeStatus(chatId, true);
      }
      // PORTED FROM GO (seifghazi/claude-code-proxy) — proxy/internal/service/storage_sqlite.go
      // Log request/response to Redis Stream after stream completes.
      logRequest('POST', '/v1/chat/completions', req.headers as Record<string, string>, requestBody, {
        statusCode: response.status,
        headers: responseHeaders,
        responseTime: Date.now() - startTime,
        isStreaming: true,
        completedAt: new Date().toISOString(),
      }, { model: requestBody.model, userAgent: req.headers['user-agent'], sessionId }).catch(err => {
        console.error('[OpenAI] Session logging error:', err);
      });
      res.end();
    });

    streamData.on('error', (error: Error) => {
      console.error(`[OpenAI] Stream error: ${error.message}`);
      if (responseEnded) return;
      responseEnded = true;
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
      console.error(`[OpenAI] Response error: ${error.message}`);
      streamData.destroy();
    });

    res.on('close', () => {
      // Client disconnected - clean up stream
      if (!responseEnded) {
        responseEnded = true;
        console.log('[OpenAI] Client disconnected');
        streamData.destroy();
        if (trackStatus) {
          completeStatus(chatId, false);
        }
      }
    });
  } else {
    // Non-streaming response — session logging
    const sessionId = (req.headers['x-session-id'] as string) || '';
    const startTime = Date.now();
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (typeof v === 'string') responseHeaders[k] = v;
      else if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
    }
    if (trackStatus) {
      startStatus(chatId);
    }
    res.status(response.status).json(response.data);
    if (trackStatus) {
      completeStatus(chatId, true);
    }
    // PORTED FROM GO (seifghazi/claude-code-proxy) — proxy/internal/service/storage_sqlite.go
    logRequest('POST', '/v1/chat/completions', req.headers as Record<string, string>, requestBody, {
      statusCode: response.status,
      headers: responseHeaders,
      body: response.data,
      responseTime: Date.now() - startTime,
      isStreaming: false,
      completedAt: new Date().toISOString(),
    }, { model: requestBody.model, userAgent: req.headers['user-agent'], sessionId }).catch(err => {
      console.error('[OpenAI] Session logging error:', err);
    });
  }
}

router.post('/v1/chat/completions', handleOpenAIRequest);

export default router;