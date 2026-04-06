import { Router, Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import { Readable } from 'stream';
import { config } from '../config/index.js';

const router = Router();

const MINIMAX_ANTHROPIC_URL = 'https://api.minimax.io/anthropic/v1/messages';

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
      timeout: 120000,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Request-Id', req.headers['x-request-id'] as string || '');

      const streamData = response.data as Readable;
      streamData.pipe(res);

      streamData.on('error', (error: Error) => {
        console.error(`[Anthropic] Stream error: ${error.message}`);
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
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      console.error(`[Anthropic] API error: ${axiosError.message}`);

      if (res.headersSent) {
        return;
      }

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data as Readable | unknown;

        if (stream && data && typeof data === 'object' && 'pipe' in data) {
          res.status(status);
          (data as Readable).pipe(res);
        } else {
          res.status(status).json(data);
        }
      } else {
        res.status(502).json({
          error: {
            message: 'Failed to reach MiniMax Anthropic API',
            details: axiosError.message,
          },
        });
      }
    } else {
      console.error(`[Anthropic] Unexpected error: ${error}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal server error' } });
      }
    }
  }
}

router.post('/v1/messages', handleAnthropicRequest);

export default router;
