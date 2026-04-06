import express, { Request, Response } from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import openaiRouter from './routes/openai.js';
import anthropicRouter from './routes/anthropic.js';
import { telegramBot } from './telegram/bot.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(openaiRouter);
app.use(anthropicRouter);

app.use(errorHandler);

function gracefulShutdown(signal: string): void {
  console.log(`\n[${signal}] Received shutdown signal.`);
  telegramBot.stop();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(config.proxyPort, () => {
  console.log(`Proxy server running on http://localhost:${config.proxyPort}`);
  console.log(`Health check: http://localhost:${config.proxyPort}/health`);
  console.log(`Mode: ${config.mode}`);
  telegramBot.start();
});
