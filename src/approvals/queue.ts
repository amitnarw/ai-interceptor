import { getRedisClient, isRedisMock } from '../config/redis.js';
import { getFakeApprovalQueue } from './fakeQueue.js';

export interface ApprovalJobData {
  id: string;
  toolName: string;
  filePath?: string;
  preview: string;
  timestamp: number;
  chatId: number;
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  customContext?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

interface QueueInterface {
  add: (name: string, data: ApprovalJobData) => Promise<string>;
  getJob: (id: string) => Promise<{ data: ApprovalJobData } | null>;
  getState: (id: string) => Promise<string>;
  getWaiting: () => Promise<{ data: ApprovalJobData }[]>;
  getActive: () => Promise<{ data: ApprovalJobData }[]>;
  getDelayed: () => Promise<{ data: ApprovalJobData }[]>;
  moveToCompleted: (data: ApprovalJobData, token?: string, keepJob?: boolean) => Promise<void>;
  moveToFailed: (err: Error, token?: string, keepJob?: boolean, explicitJobId?: string) => Promise<void>;
  close: () => Promise<void>;
}

let useFakeQueue = false;
let realQueue: QueueInterface | null = null;
let fakeQueue: QueueInterface | null = null;
let initializationAttempted = false;

async function initRealQueue(): Promise<boolean> {
  if (initializationAttempted) {
    return useFakeQueue;
  }
  initializationAttempted = true;

  try {
    const { Queue } = await import('bullmq');
    const connection = await getRedisClient();

    // Check if using mock Redis (ioredis-mock has known Lua issues with BullMQ)
    if (isRedisMock()) {
      console.log('[Queue] Using mock Redis, skipping BullMQ (has Lua issues with cmsgpack)');
      useFakeQueue = true;
      fakeQueue = getFakeApprovalQueue() as unknown as QueueInterface;
      return false;
    }

    const QueueConstructor = Queue as unknown as new (name: string, opts: {
      connection: unknown;
      defaultJobOptions?: { removeOnComplete?: { count?: number }; removeOnFail?: { count?: number } };
    }) => QueueInterface;

    realQueue = new QueueConstructor('approval-requests', {
      connection,
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });

    console.log('[Queue] Using BullMQ with Redis');
    return true;
  } catch (error) {
    console.warn('[Queue] BullMQ/Redis not available, using in-memory fake queue');
    console.warn('[Queue] Error:', error instanceof Error ? error.message : String(error));
    useFakeQueue = true;
    fakeQueue = getFakeApprovalQueue() as unknown as QueueInterface;
    return false;
  }
}

export async function getQueue(): Promise<QueueInterface> {
  if (useFakeQueue) {
    return fakeQueue!;
  }
  if (!realQueue) {
    await initRealQueue();
  }
  return useFakeQueue ? fakeQueue! : realQueue!;
}

export async function addApprovalJob(data: ApprovalJobData): Promise<string> {
  if (!initializationAttempted) {
    await initRealQueue();
  }

  const queue = await getQueue();
  return queue.add('approval-request', data);
}

export async function getApprovalJob(jobId: string): Promise<ApprovalJobData | null> {
  if (useFakeQueue && fakeQueue) {
    const job = await fakeQueue.getJob(jobId);
    if (!job) return null;
    const state = await fakeQueue.getState(jobId);
    return {
      ...job.data,
      status: state === 'completed' ? 'approved' :
              state === 'failed' ? 'rejected' :
              'pending',
    };
  }

  const queue = await getQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await queue.getState(jobId);

  return {
    ...job.data,
    status: state === 'completed' ? 'approved' :
            state === 'failed' ? 'rejected' :
            'pending',
  };
}

export async function updateApprovalStatus(
  jobId: string,
  status: ApprovalStatus,
  customContext?: string
): Promise<void> {
  const queue = await getQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const data: ApprovalJobData = {
    ...job.data,
    status,
    ...(customContext ? { customContext } : {}),
  };

  if (status === 'approved') {
    await queue.moveToCompleted(data, 'true', true);
  } else if (status === 'rejected' || status === 'timeout') {
    const reason = status === 'timeout' ? 'Approval timeout' : `Rejected: ${customContext || 'no context'}`;
    await queue.moveToFailed(new Error(reason), 'true', true, jobId);
  }
}

export async function getPendingApprovals(): Promise<ApprovalJobData[]> {
  if (useFakeQueue && fakeQueue) {
    const [waiting, active, delayed] = await Promise.all([
      fakeQueue.getWaiting(),
      fakeQueue.getActive(),
      fakeQueue.getDelayed(),
    ]);
    const allJobs = [...waiting, ...active, ...delayed];
    return allJobs.map(job => job.data);
  }

  const queue = await getQueue();
  const [waiting, active, delayed] = await Promise.all([
    queue.getWaiting(),
    queue.getActive(),
    queue.getDelayed(),
  ]);
  const allJobs = [...waiting, ...active, ...delayed];
  return allJobs.map(job => job.data);
}

export async function closeApprovalQueue(): Promise<void> {
  if (realQueue) {
    await realQueue.close();
    realQueue = null;
  }
  if (fakeQueue) {
    await fakeQueue.close();
    fakeQueue = null;
  }
  initializationAttempted = false;
  useFakeQueue = false;
}

export function isUsingFakeQueue(): boolean {
  return useFakeQueue;
}