import { Job } from 'bullmq';
import { getRedisClient } from '../config/redis.js';
import { ApprovalJobData } from './queue.js';
import { config } from '../config/index.js';
import { FakeApprovalQueue, getFakeApprovalQueue, FakeJob } from './fakeQueue.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realWorker: any = null;
let fakeWorker: FakeApprovalQueue | null = null;
let fakeWorkerInterval: ReturnType<typeof setInterval> | null = null;
let onApprovalTimeoutCallback: ((job: ApprovalJobData) => void) | null = null;

export async function createApprovalWorker(
  timeoutCallback: (job: ApprovalJobData) => void
): Promise<void> {
  if (realWorker || fakeWorker) {
    return;
  }

  onApprovalTimeoutCallback = timeoutCallback;

  try {
    const { Worker } = await import('bullmq');
    const connection = await getRedisClient();

    // Verify Redis works
    await connection.ping();

    realWorker = new Worker<ApprovalJobData>(
      'approval-requests',
      async (job: Job<ApprovalJobData>) => {
        console.log(`[ApprovalWorker] Processing job ${job.id}`);

        const timeoutMs = config.autoRejectTimeoutMs;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
          const state = await job.getState();

          if (state === 'completed' || state === 'failed') {
            console.log(`[ApprovalWorker] Job ${job.id} was resolved externally`);
            return;
          }

          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`[ApprovalWorker] Job ${job.id} timed out`);
        if (onApprovalTimeoutCallback) {
          await onApprovalTimeoutCallback(job.data);
        }
        await job.moveToFailed(new Error('Approval timeout'), 'true', true);
      },
      {
        connection,
        concurrency: 5,
        limiter: {
          max: 10,
          duration: 1000,
        },
      }
    );

    realWorker.on('completed', (job: Job<ApprovalJobData>) => {
      console.log(`[ApprovalWorker] Job ${job.id} completed`);
    });

    realWorker.on('failed', (job: Job<ApprovalJobData> | undefined, err: Error) => {
      console.log(`[ApprovalWorker] Job ${job?.id} failed:`, err.message);
    });

    realWorker.on('error', (err: Error) => {
      console.error('[ApprovalWorker] Error:', err.message);
      // If BullMQ encounters an error (e.g., Lua script issue with ioredis-mock),
      // fall back to fake worker if not already using it
      if (fakeWorker === null) {
        console.log('[ApprovalWorker] BullMQ error, falling back to fake worker');
        realWorker = null;
        realWorker = undefined; // Ensure we don't try to close it later
        startFakeWorker(timeoutCallback!);
      }
    });

    console.log('[ApprovalWorker] Started with BullMQ');
  } catch (error) {
    // Fall back to fake worker
    console.log('[ApprovalWorker] Falling back to fake worker (no Redis)');
    startFakeWorker(timeoutCallback);
  }
}

function startFakeWorker(timeoutCallback: (job: ApprovalJobData) => void): void {
  fakeWorker = getFakeApprovalQueue();
  onApprovalTimeoutCallback = timeoutCallback;

  fakeWorker.on('completed', (job: FakeJob) => {
    console.log(`[FakeWorker] Job ${job.id} completed`);
  });

  fakeWorker.on('failed', (job: FakeJob, err: Error) => {
    console.log(`[FakeWorker] Job ${job.id} failed:`, err.message);
  });

  // Start timeout monitor
  fakeWorkerInterval = setInterval(async () => {
    if (!fakeWorker) {
      return;
    }

    const pending = await fakeWorker.getWaiting();
    const now = Date.now();

    for (const job of pending) {
      const elapsed = now - job.data.timestamp;
      if (elapsed >= config.autoRejectTimeoutMs) {
        console.log(`[FakeWorker] Job ${job.id} timed out`);
        if (onApprovalTimeoutCallback) {
          await onApprovalTimeoutCallback(job.data);
        }
        await fakeWorker.moveToFailed(new Error('Approval timeout'), 'true', true);
      }
    }
  }, 1000);

  console.log('[FakeWorker] Started');
}

export async function closeApprovalWorker(): Promise<void> {
  if (fakeWorkerInterval) {
    clearInterval(fakeWorkerInterval);
    fakeWorkerInterval = null;
  }

  if (realWorker) {
    await realWorker.close();
    realWorker = null;
    console.log('[ApprovalWorker] Stopped');
  }

  if (fakeWorker) {
    fakeWorker = null;
    console.log('[FakeWorker] Stopped');
  }

  onApprovalTimeoutCallback = null;
}

export function isWorkerRunning(): boolean {
  return realWorker !== null || fakeWorker !== null;
}