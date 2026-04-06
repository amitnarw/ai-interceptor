import { Router, Request, Response } from 'express';
import axios, { AxiosError, AxiosResponse } from 'axios';

const router = Router();

const MINIMAX_OPENAI_URL = 'https://api.minimax.io/v1/chat/completions';

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
    const response: AxiosResponse = await axios({
      method: 'POST',
      url: MINIMAX_OPENAI_URL,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization || '',
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

      (response.data as NodeJS.ReadableStream).pipe(res);

      (response.data as NodeJS.ReadableStream).on('error', (error: Error) => {
        console.error(`[OpenAI] Stream error: ${error.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Stream error' } });
        }
      });
    } else {
      res.status(response.status).json(response.data);
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      console.error(`[OpenAI] API error: ${axiosError.message}`);

      if (axiosError.response) {
        res.status(axiosError.response.status).json(axiosError.response.data);
      } else {
        res.status(502).json({
          error: {
            message: 'Failed to reach MiniMax API',
            details: axiosError.message,
          },
        });
      }
    } else {
      console.error(`[OpenAI] Unexpected error: ${error}`);
      res.status(500).json({ error: { message: 'Internal server error' } });
    }
  }
}

router.post('/v1/chat/completions', handleOpenAIRequest);

export default router;
