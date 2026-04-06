import { Redis } from 'ioredis';

let isUsingMock = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisInstance: any = null;

function getRedisUrl(): string {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;
  const db = process.env.REDIS_DB || '0';

  const authPart = password ? `:${password}@` : '';
  return `redis://${authPart}${host}:${port}/${db}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createRedisMock(): Promise<any> {
  const RedisMock = await import('ioredis-mock');
  return new RedisMock.default();
}

export async function getRedisClient(): Promise<Redis> {
  if (redisInstance) {
    return redisInstance as Redis;
  }

  const useMock = process.env.USE_REDIS_MOCK === 'true' ||
    !process.env.REDIS_HOST;

  if (useMock) {
    isUsingMock = true;
    redisInstance = await createRedisMock();
    console.log('[Redis] Using ioredis-mock (no Redis instance configured)');
    return redisInstance as Redis;
  }

  redisInstance = new Redis(getRedisUrl(), {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 3) {
        console.warn('[Redis] Connection failed, falling back to mock');
        isUsingMock = true;
        createRedisMock().then(rm => { redisInstance = rm; });
        return null;
      }
      return Math.min(times * 100, 3000);
    },
  });

  redisInstance.on('connect', () => {
    console.log('[Redis] Connected to', process.env.REDIS_HOST || 'localhost');
  });

  redisInstance.on('error', (err: Error) => {
    console.error('[Redis] Error:', err.message);
  });

  return redisInstance as Redis;
}

export function isRedisMock(): boolean {
  return isUsingMock;
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
    isUsingMock = false;
  }
}