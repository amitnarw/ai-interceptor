import express, { Request, Response } from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import openaiRouter from './routes/openai.js';
import anthropicRouter from './routes/anthropic.js';
import { telegramBot } from './telegram/bot.js';
import { approvalService } from './services/approvalService.js';
import { closeApprovalQueue } from './approvals/queue.js';
import { closeApprovalWorker, createApprovalWorker } from './approvals/worker.js';
import { closeRedis } from './config/redis.js';
import { modeManager } from './config/mode.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mode: modeManager.getMode(),
    pendingApprovals: approvalService.getPendingCount(),
  });
});

app.use(openaiRouter);
app.use(anthropicRouter);

app.use(errorHandler);

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('[Shutdown] Already shutting down...');
    return;
  }

  isShuttingDown = true;
  console.log(`\n[${signal}] Received shutdown signal.`);
  console.log('[Shutdown] Starting graceful shutdown...');

  // Stop accepting new requests
  console.log('[Shutdown] Stopping Telegram bot...');
  telegramBot.stop();

  // Wait for in-flight approvals to complete (with timeout)
  const pendingCount = approvalService.getPendingCount();
  if (pendingCount > 0) {
    console.log(`[Shutdown] Waiting for ${pendingCount} pending approval(s) to resolve...`);

    const maxWait = 30000; // 30 seconds max wait
    const startTime = Date.now();

    while (approvalService.getPendingCount() > 0 && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const remaining = approvalService.getPendingCount();
    if (remaining > 0) {
      console.log(`[Shutdown] ${remaining} approval(s) timed out, forcing shutdown...`);
    }
  }

  // Close approval queue and worker
  console.log('[Shutdown] Closing approval queue...');
  await closeApprovalQueue();

  console.log('[Shutdown] Closing approval worker...');
  await closeApprovalWorker();

  // Close Redis connection
  console.log('[Shutdown] Closing Redis connection...');
  await closeRedis();

  console.log('[Shutdown] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Fatal] Uncaught exception:', error);
  gracefulShutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled rejection at:', promise, 'reason:', reason);
});

// Handle server errors
app.listen(config.proxyPort, async () => {
  console.log(`Proxy server running on http://localhost:${config.proxyPort}`);
  console.log(`Health check: http://localhost:${config.proxyPort}/health`);
  console.log(`Mode: ${modeManager.getMode()}`);

  // Initialize approval worker for timeout handling
  await createApprovalWorker(async (job) => {
    console.log(`[ApprovalWorker] Job ${job.id} timed out`);
    await approvalService.handleApproval(job.id, 'reject');
  });

  telegramBot.start();
});