interface RedisClient {
  ping: () => Promise<string>;
  quit: () => Promise<void>;
  on: (event: string, handler: (err?: Error | undefined) => void) => void;
}

let isUsingMock = false;

let redisInstance: RedisClient | null = null;

function getRedisUrl(): string {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD;
  const db = process.env.REDIS_DB || '0';

  const authPart = password ? `:${password}@` : '';
  return `redis://${authPart}${host}:${port}/${db}`;
}

async function createRedisMock(): Promise<RedisClient> {
  const RedisMock = (await import('ioredis-mock')).default as unknown as new () => RedisClient;
  return new RedisMock();
}

export async function getRedisClient(): Promise<RedisClient> {
  if (redisInstance) {
    return redisInstance;
  }

  const useMock = process.env.USE_REDIS_MOCK === 'true' ||
    (process.env.USE_REDIS_MOCK !== 'false' && !process.env.REDIS_HOST);

  if (useMock) {
    isUsingMock = true;
    redisInstance = await createRedisMock();
    console.log('[Redis] Using ioredis-mock (no Redis instance configured)');
    return redisInstance;
  }

  try {
    const { Redis } = await import('ioredis');
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
    }) as unknown as RedisClient;

    redisInstance.on('connect', () => {
      console.log('[Redis] Connected to', process.env.REDIS_HOST || 'localhost');
    });

    redisInstance.on('error', (err: Error | undefined) => {
      console.error('[Redis] Error:', err?.message);
    });

    return redisInstance;
  } catch {
    console.warn('[Redis] Failed to load ioredis, using mock');
    isUsingMock = true;
    redisInstance = await createRedisMock();
    return redisInstance;
  }
}

export function isRedisMock(): boolean {
  return isUsingMock;
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    try {
      await redisInstance.quit();
    } catch {
      // Ignore errors during shutdown
    }
    redisInstance = null;
    isUsingMock = false;
  }
}