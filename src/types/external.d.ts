declare module 'bullmq' {
  export interface JobOptions {
    removeOnComplete?: { count?: number };
    removeOnFail?: { count?: number };
  }

  export interface QueueOptions {
    connection: unknown;
    defaultJobOptions?: JobOptions;
  }

  export interface JobData {
    id?: string;
    data: Record<string, unknown>;
  }

  export class Queue<T = unknown> {
    constructor(name: string, options?: QueueOptions);
    add(name: string, data: T): Promise<{ id: string }>;
    getJob(jobId: string): Promise<Job<T> | null>;
    getState(jobId: string): Promise<string>;
    getWaiting(): Promise<Job<T>[]>;
    getActive(): Promise<Job<T>[]>;
    getDelayed(): Promise<Job<T>[]>;
    moveToCompleted(data: T, token?: string, keepJob?: boolean): Promise<void>;
    moveToFailed(err: Error, token?: string, keepJob?: boolean): Promise<void>;
    close(): Promise<void>;
  }

  export class Worker<T = unknown> {
    constructor(
      name: string,
      processor: (job: Job<T>) => Promise<void>,
      options?: {
        connection?: unknown;
        concurrency?: number;
        limiter?: { max: number; duration: number };
      }
    );
    on(event: string, handler: (job?: Job<T>, err?: Error) => void): void;
    close(): Promise<void>;
  }
}

declare module 'ioredis' {
  export class Redis {
    constructor(url: string, options?: {
      maxRetriesPerRequest?: number;
      retryStrategy?: (times: number) => number | null;
    });
    ping(): Promise<string>;
    quit(): Promise<void>;
    on(event: string, handler: (err?: Error) => void): void;
  }
}

declare module 'ioredis-mock' {
  const RedisMock: {
    default: new () => unknown;
  };
  export default RedisMock;
}
