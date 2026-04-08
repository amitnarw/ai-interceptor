import { EventEmitter } from 'events';
import { ApprovalJobData } from './queue.js';

export class FakeJob {
  id: string;
  data: ApprovalJobData;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' = 'waiting';

  constructor(data: ApprovalJobData) {
    this.id = data.id;
    this.data = data;
  }
}

export class FakeApprovalQueue extends EventEmitter {
  private jobs: Map<string, FakeJob> = new Map();

  async add(_name: string, data: ApprovalJobData): Promise<string> {
    const job = new FakeJob(data);
    this.jobs.set(data.id, job);
    console.log(`[FakeQueue] Added job ${data.id}`);
    return data.id;
  }

  async getJob(jobId: string): Promise<FakeJob | null> {
    return this.jobs.get(jobId) || null;
  }

  async getState(jobId: string): Promise<string> {
    const job = this.jobs.get(jobId);
    return job ? job.state : 'unknown';
  }

  async moveToCompleted(result: ApprovalJobData, _token?: string, _keepJob?: boolean): Promise<void> {
    const job = this.jobs.get(result.id);
    if (job) {
      job.data.status = 'approved';
      job.state = 'completed';
      this.emit('completed', job);
    }
    console.log(`[FakeQueue] Job ${result.id} completed`);
  }

  async moveToFailed(error: Error, _token?: string, _keepJob?: boolean, explicitJobId?: string): Promise<void> {
    // Use explicit jobId if provided, otherwise try to find matching job
    let jobId = explicitJobId ?? 'unknown';
    let job = explicitJobId ? this.jobs.get(explicitJobId) : undefined;

    if (!job) {
      job = Array.from(this.jobs.values()).find(j =>
        (explicitJobId && j.id === explicitJobId) ||
        (!explicitJobId && j.data.status === 'pending' && j.state === 'waiting')
      );
    }

    if (job) {
      if (!explicitJobId) {
        jobId = job.id;
      }
      job.data.status = error.message.includes('timeout') ? 'timeout' : 'rejected';
      job.state = 'failed';
      this.emit('failed', job, error);
    }
    console.log(`[FakeQueue] Job ${jobId} failed: ${error.message}`);
  }

  async getWaiting(): Promise<FakeJob[]> {
    return Array.from(this.jobs.values()).filter(j => j.state === 'waiting');
  }

  async getActive(): Promise<FakeJob[]> {
    return Array.from(this.jobs.values()).filter(j => j.state === 'active');
  }

  async getDelayed(): Promise<FakeJob[]> {
    return Array.from(this.jobs.values()).filter(j => j.state === 'delayed');
  }

  async close(): Promise<void> {
    this.jobs.clear();
    console.log('[FakeQueue] Closed');
  }
}

// Singleton
let fakeQueueInstance: FakeApprovalQueue | null = null;

export function getFakeApprovalQueue(): FakeApprovalQueue {
  if (!fakeQueueInstance) {
    fakeQueueInstance = new FakeApprovalQueue();
  }
  return fakeQueueInstance;
}